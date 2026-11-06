"""Export measured trials with provider tiers and comparable execution boundaries."""

import argparse
import hashlib
import json
import statistics
import sys
from pathlib import Path

TASKS = ("display", "about", "search")


def median(values):
    return statistics.median(values) if values else None


def failed_model_call_time(events):
    requested_at, total = None, 0
    for event in events:
        if event.get("type") == "model_request":
            requested_at = event.get("at")
        elif event.get("type") == "model_failure":
            if requested_at is not None and event.get("at") is not None:
                total += event["at"] - requested_at
            else:
                total += sum(attempt.get("elapsed_s", 0) for attempt in event.get("attempts", []))
            requested_at = None
    return total


def timing_breakdown(record, arm, execution_s, models, receipts):
    """Split sequential wall time; device duration is nested inside tool duration."""
    direct = arm == "direct"
    tool_events = record.get("events", []) if direct else receipts
    tool_s = sum(event.get("host_s" if direct else "transport_s", 0) for event in tool_events
                 ) if tool_events or not direct else None
    device_s = sum(event.get("device_s") or 0 for event in tool_events
                   ) if tool_events or not direct else None
    failed_call_s = None if direct else failed_model_call_time(record.get("events", []))
    model_s = None if direct else (
        sum(model.get("model_total_s", model.get("model_s", 0)) for model in models) + failed_call_s)
    ttft_s = None if direct else sum(model.get("ttft_s") or 0 for model in models)
    decode_s = None if direct else sum(model.get("decode_s") or 0 for model in models)
    rejected_s = None if direct else sum(attempt.get("elapsed_s", 0)
                                        for model in models for attempt in model.get("attempts", [])
                                        if attempt.get("status") == "failed")
    residual = execution_s - (tool_s or 0) - (model_s or 0) if execution_s is not None else None
    tools = {}
    for event in tool_events:
        name = event.get("tool", "unknown")
        item = tools.setdefault(name, {"calls": 0, "wall_s": 0, "reported_device_s": 0,
                                      "missing_device_duration": 0, "snapshot_conflicts": 0})
        item["calls"] += 1
        item["wall_s"] += event.get("host_s" if direct else "transport_s", 0)
        item["reported_device_s"] += event.get("device_s") or 0
        item["missing_device_duration"] += event.get("device_s") is None
        item["snapshot_conflicts"] += event.get("error_code") == "conflict"
    return {
        "execution_s": execution_s,
        "model_total_s": model_s,
        "successful_ttft_sum_s": ttft_s,
        "successful_decode_sum_s": decode_s,
        "rejected_attempts_s": rejected_s,
        "failed_model_calls_s": failed_call_s,
        "model_stream_tail_and_client_s": model_s - (ttft_s or 0) - (decode_s or 0) - (
            rejected_s or 0) - (failed_call_s or 0)
            if model_s is not None else None,
        "adc_roundtrip_s": tool_s,
        "reported_device_s": device_s,
        "adc_minus_reported_device_s": tool_s - device_s if tool_s is not None else None,
        "missing_device_duration_count": sum(event.get("device_s") is None for event in tool_events),
        "local_or_agent_residual_s": residual,
        "residual_interpretation": ("unmeasured GPT-6 inference + agent scheduling + host commands outside ADC"
                                    if direct else "local controller, serialization and logging outside model/ADC"),
        "model_fraction": model_s / execution_s if model_s is not None and execution_s else None,
        "adc_fraction": tool_s / execution_s if tool_s is not None and execution_s else None,
        "tools": tools,
        "excluded_control_wall_s": record.get("wall_s", 0) - execution_s
            if not direct and execution_s is not None else None,
    }


def summarize_trial(path, arm, task, version):
    record = json.loads(path.read_text())
    events = record.get("events", [])
    models = [event for event in events if event.get("type") == "model"]
    receipts = [event for event in events if event.get("type") == "receipt"
                and event.get("tool") != "screen.control"]
    if arm == "direct":
        execution = record.get("wall_s")
        adc_s = sum(event.get("host_s", 0) for event in events)
        finish = None
    else:
        begin = next((event["at"] for event in events if
                      event.get("type") == "invocation" and event.get("tool") == "ui.inspect"), None)
        finish = next((event["at"] for event in reversed(events) if
                       event.get("type") == "acceptance" or
                       (event.get("type") == "step" and event.get("decision", {}).get("action") == "done") or
                       event.get("type") == "interruption"), None)
        execution = finish - begin if begin is not None and finish is not None else None
        adc_s = sum(event.get("transport_s", 0) for event in receipts)
    attempts = [attempt for event in events if event.get("type") in {"model", "model_failure"}
                for attempt in event.get("attempts", [])]
    return {
        "trial": path.parent.name if path.name == "result.json" else path.stem,
        "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "arm": arm, "task": task, "version": version,
        "status": record.get("status"), "reason": record.get("reason"),
        "cleanup": record.get("cleanup"), "steps": record.get("steps"),
        "execution_s": execution, "wall_including_control_s": record.get("wall_s"),
        "adc_transport_s": adc_s,
        "model_total_s": sum(model.get("model_total_s", model.get("model_s", 0)) for model in models),
        "model_calls": len(models),
        "timing": timing_breakdown(record, arm, execution, models, receipts),
        "actual_tiers": [model.get("actual_tier") for model in models],
        "fast_rejections": sum(attempt.get("error") == "ark_http_404:ModelNotOpen" for attempt in attempts),
        "fast_attempts": sum(attempt.get("requested_tier") == "fast" for attempt in attempts),
        "fallback_calls": sum(bool(model.get("fallback_used")) for model in models),
        "snapshot_conflicts": sum(event.get("error_code") == "conflict" for event in receipts),
        "models": [{key: model.get(key) for key in (
            "requested_model", "model", "initial_requested_tier", "requested_tier", "actual_tier",
            "ttft_s", "model_s", "model_total_s", "decode_s", "tpot_estimate_s",
            "usage", "finish_reason", "fallback_used", "attempts",
        )} for model in models],
        # Retain verifiable public receipt IDs without control tokens or raw UI contents.
        "receipts": [{key: event.get(key) for key in (
            "tool", "status", "error_code", "receiptId", "invocationId", "jobId",
            "device_s", "transport_s", "host_s",
        )} for event in events if event.get("type") == "receipt" or arm == "direct"],
    }


def aggregate(trials):
    groups = []
    for arm in ("direct", "default", "fast"):
        for task in TASKS:
            rows = [row for row in trials if row["arm"] == arm and row["task"] == task]
            successful = [row for row in rows if row["status"] == "succeeded"]
            groups.append({
                "arm": arm, "task": task, "trials": len(rows), "succeeded": len(successful),
                "execution_median_s": median([row["execution_s"] for row in successful
                                               if row["execution_s"] is not None]),
                "execution_range_s": [min(values), max(values)] if
                    (values := [row["execution_s"] for row in successful
                                if row["execution_s"] is not None]) else None,
                "ttft_median_s": median([model["ttft_s"] for row in rows for model in row["models"]
                                        if model["ttft_s"] is not None]),
                "tpot_estimate_median_s": median([model["tpot_estimate_s"] for row in rows
                                                for model in row["models"]
                                                if model["tpot_estimate_s"] is not None]),
                "fast_rejections": sum(row["fast_rejections"] for row in rows),
                "fast_attempts": sum(row["fast_attempts"] for row in rows),
                "fallback_calls": sum(row["fallback_calls"] for row in rows),
                "actual_tiers": sorted({tier or "unknown" for row in rows for tier in row["actual_tiers"]}),
            })
    return groups


def direct_pilots(source):
    pilots = []
    for task in TASKS:
        pilot = source / f"adc-gui-direct-{task}-1.json"
        if pilot.exists():
            row = summarize_trial(pilot, "direct", task, "excluded-direct-pilot")
            row["exclusion_reason"] = {
                "display": "pilot included stale snapshot recovery",
                "about": "pilot targeted an unavailable MIUI page label",
                "search": "pilot used earlier search acceptance criteria",
            }[task]
            pilots.append(row)
    return pilots


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    source, output = Path(args.input), Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    final, diagnostics, repair_trials = [], direct_pilots(source), []
    for task in TASKS:
        for run in (2, 3):
            path = source / f"adc-gui-direct-{task}-{run}.json"
            final.append(summarize_trial(path, "direct", task, "direct-agent"))
        for arm in ("fast", "default"):
            for run in (1, 2):
                path = source / f"adc-gui-bench-v2-{arm}-{task}-{run}" / "result.json"
                final.append(summarize_trial(path, arm, task, "v2-independent-acceptance"))
    for path in sorted(source.glob("adc-gui-bench-*/result.json")):
        if "-v2-" in path.parent.name:
            continue
        if "-v3-" in path.parent.name:
            _, _, _, _, arm, task, _run = path.parent.name.split("-")
            repair_trials.append(summarize_trial(path, arm, task, "v3-action-outcome-feedback"))
            continue
        _, _, _, arm, task, _run = path.parent.name.split("-")
        diagnostics.append(summarize_trial(path, arm, task, "v1-model-completion"))
    for path in sorted(source.glob("adc-gui-mini-*/result.json")):
        task = path.parent.name.split("-")[3]
        if task in TASKS:
            diagnostics.append(summarize_trial(path, "default", task, "earlier-prompt"))
    diagnostics.extend(summarize_trial(path, "fast", "display", "strict-or-fallback-pilot")
                       for path in sorted(source.glob("adc-gui-fast-display-*/result.json")))
    hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
              for path in Path(__file__).parent.glob("*.py")}
    protocol = {
        "date": "2026-11-05", "device": "Xiaomi 22041216C / Android 13",
        "baseline": "GPT-6 parent agent makes each navigation decision; no scripted navigation plan",
        "executor_model": "Doubao-Seed-2.0-mini 260428 / ep-m-20260508193312-rfxzv",
        "observation": "semantic Android accessibility tree; screenshot grounding not tested",
        "execution_boundary": "first ui.inspect submission to observed acceptance; reset/control begin/end excluded",
        "fast_policy": ("service_tier=fast, at most 2 immediate retries only on 404 ModelNotOpen; "
                        "then explicit default fallback"),
        "sample_size": "3 tasks x 2 repetitions x 3 arms; exploratory, not an SLA or statistical significance result",
        "caveat": ("direct includes parent-agent scheduling; executor uses a local file bridge "
                   "with additional host commands"),
        "source_hashes": hashes,
        "implementation_versions": {
            "primary": "v2: independent visible-text/input acceptance before inference",
            "repair": "v3: report action outcome to model and replan unverified done",
        },
    }
    evidence = {"protocol": protocol, "summary": aggregate(final),
                "trials": final, "diagnostics": diagnostics, "repair_trials": repair_trials,
                "repair_summary": [row for row in aggregate(repair_trials) if row["trials"]]}
    (output / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    sys.stdout.write(json.dumps(evidence["summary"], ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
