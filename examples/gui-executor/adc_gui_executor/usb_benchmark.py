"""Serial, source-frozen real-phone trials; task files prescribe evidence only."""

import argparse
import hashlib
import json
import platform
import statistics
import sys
import time
from collections import Counter
from importlib.metadata import version
from pathlib import Path

from .ark import ArkClient
from .executor import Executor, Goal
from .summarize import failed_model_call_time
from .transport import ADCError, atomic_json
from .usb import USBTransport


def manifest():
    directory = Path(__file__).parent
    paths = sorted(directory.glob("*.py")) + sorted((directory / "tasks").glob("long-*.json"))
    return {str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in paths}


def percentile(values, percent):
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * percent
    low, high = int(index), min(int(index) + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (index - low)


def reset_settings(transport, serial, deadline, key):
    ownership = transport.invoke("screen.control", {"action": "begin"}, serial, deadline)
    token = ownership["output"]["controlSessionId"]
    try:
        transport.invoke("device.navigation", {"action": "home"}, serial, deadline, token=token, key=key)
        # Android 13 supports Intent flags; --activity-new-task is not an am option.
        transport.shell(["am", "start", "-a", "android.settings.SETTINGS",
                         "-f", "0x10008000"], deadline, mutation=True)
        current = transport.after_action(transport.snapshot, deadline)
        for attempt in range(12):
            texts = {item["text"] for item in current["nodes"]}
            if current["packageName"] == "com.android.settings" and {
                "搜索系统设置项", "我的设备",
            } <= texts:
                return {"packageName": current["packageName"], "required_text": ["搜索系统设置项", "我的设备"],
                        "snapshotId": current["snapshotId"], "scrolls": attempt}
            if current["packageName"] != "com.android.settings":
                raise ADCError("reset_wrong_foreground")
            scrollable = next((item for item in current["nodes"] if item["scrollable"]), None)
            if scrollable is None:
                raise ADCError("reset_no_scrollable")
            result = transport.invoke("ui.action", {"action": "scroll_backward", "selector": {
                "nodeId": scrollable["nodeId"], "snapshotId": current["snapshotId"],
            }}, serial, deadline, token=token, key=f"{key}-scroll-{attempt}")
            current = result["output"]["observation"]
        raise ADCError("reset_not_verified")
    finally:
        transport.invoke("screen.control", {"action": "end", "controlSessionId": token},
                         serial, time.monotonic() + 5)


def summarize(result, task, arm, run):
    events = result["events"]
    models = [item for item in events if item["type"] == "model"]
    receipts = [item for item in events if item["type"] == "receipt"]
    model_s = sum(item.get("model_total_s", 0) for item in models) + failed_model_call_time(events)
    transport_s = sum(item["transport_s"] for item in receipts)
    steps = [item for item in events if item["type"] == "decision"]
    rpc = [item for receipt in receipts for item in receipt.get("local_timings", [])]
    attempts = [attempt for item in models for attempt in item.get("attempts", [])]
    return {
        "task": task, "arm": arm, "run": run, "status": result["status"], "reason": result["reason"],
        "cleanup": result["cleanup"], "wall_s": result["wall_s"],
        "model_total_s": model_s, "usb_total_s": transport_s,
        "local_residual_s": result["wall_s"] - model_s - transport_s,
        "milestones": [item["id"] for item in result["completed_milestones"]],
        "decision_count": len(steps),
        "actions": dict(Counter(item["decision"].get("action") for item in steps)),
        "primitive_actions": sum(item.get("primitive_count", 1) for item in events
                                 if item["type"] == "action_result" and item["status"] in {
                                     "succeeded", "sequence_interrupted",
                                 }),
        "conflicts": sum(item.get("error_code") == "conflict" for item in receipts),
        "validation_errors": dict(Counter(item["validation_error"] for item in events
                                          if item.get("validation_error"))),
        "supervisor_calls": sum(item.get("role") in {"supervisor", "planner"} for item in models),
        "planning_calls": sum(item.get("trigger") == "milestone_plan" for item in events),
        "recovery_calls": sum(item.get("trigger") == "invalid_or_stalled" for item in events),
        "actual_tiers": dict(Counter(item.get("actual_tier") or "unknown" for item in models)),
        "fast_rejections": sum(item.get("error") == "ark_http_404:ModelNotOpen" for item in attempts),
        "fallback_calls": sum(bool(item.get("fallback_used")) for item in models),
        "model_median_s": statistics.median([item["model_s"] for item in models]) if models else None,
        "model_p95_s": percentile([item["model_s"] for item in models], .95),
        "ttft_median_s": statistics.median([item["ttft_s"] for item in models]) if models else None,
        "usb_rpc_median_s": statistics.median([item["host_roundtrip_s"] for item in rpc]) if rpc else None,
        "usb_rpc_p95_s": percentile([item["host_roundtrip_s"] for item in rpc], .95),
        "model_usage": {key: sum(item.get("usage", {}).get(key, 0) for item in models)
                        for key in ("prompt_tokens", "completion_tokens")},
        "models": [{key: item.get(key) for key in (
            "role", "requested_model", "model", "actual_tier", "ttft_s", "decode_s", "model_s",
            "model_total_s", "usage", "attempts", "fast_circuit_open", "fallback_used",
        )} for item in models],
        "tool_timings": [{key: item.get(key) for key in (
            "tool", "transport", "status", "transport_s", "error_code", "local_timings",
        )} for item in receipts],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--usb", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--repeats", type=int, default=3, choices=[1, 2, 3])
    parser.add_argument("--tasks", nargs="+", default=["audit", "search-recovery", "cross-app"])
    parser.add_argument("--tiers", nargs="+", default=["fast", "default"], choices=["fast", "default"])
    parser.add_argument("--model", default="ep-m-20260508193312-rfxzv")
    parser.add_argument("--supervisor-model", default="doubao-seed-2-1-pro-260915")
    parser.add_argument("--adaptive-visual", action="store_true")
    parser.add_argument("--plan-milestones", action="store_true")
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(mode=0o700, exist_ok=False)
    frozen = manifest()
    atomic_json(output / "manifest.json", {"files": frozen, "platform": platform.platform(),
                "dependencies": {name: version(name) for name in ("uiautomator2", "adbutils", "requests")},
                "model": args.model, "supervisor": args.supervisor_model, "repeats": args.repeats,
                "transport": "local_usb", "navigation": "model_driven",
                "adaptive_visual": args.adaptive_visual, "plan_milestones": args.plan_milestones})
    # One session survives all trials. Each trial still owns/releases its local lease.
    transport = USBTransport(args.usb)
    trials = []
    for run in range(1, args.repeats + 1):
        for task in args.tasks:
            for arm in (args.tiers if run % 2 else args.tiers[::-1]):
                if manifest() != frozen:
                    raise RuntimeError("source_changed_during_frozen_benchmark")
                path = Path(__file__).parent / "tasks" / f"long-{task}.json"
                goal = Goal(**json.loads(path.read_text()))
                client = ArkClient(args.model, arm, fallback_default=arm == "fast")
                supervisor = ArkClient(args.supervisor_model, "default") if args.supervisor_model else None
                # Reset navigation only. This sends no app-data deletion or setting changes.
                reset_start = time.monotonic()
                initial = reset_settings(transport, args.usb, reset_start + 45,
                                         f"reset-{run}-{task}-{arm}")
                reset_s = time.monotonic() - reset_start
                result = Executor(transport, client, args.usb, output / f"{arm}-{task}-{run}",
                                  output / "control.json", supervisor=supervisor).run(
                                      goal, adaptive_visual=args.adaptive_visual,
                                      plan_milestones=args.plan_milestones)
                row = summarize(result, task, arm, run)
                row["reset_s_excluded"] = reset_s
                row["initial_state"] = initial
                row["source_sha256"] = hashlib.sha256(
                    (output / f"{arm}-{task}-{run}" / "result.json").read_bytes()).hexdigest()
                trials.append(row)
                atomic_json(output / "evidence.json", {"manifest": frozen, "trials": trials})
                sys.stdout.write(json.dumps({key: value for key, value in row.items()
                                             if key not in {"models", "tool_timings"}}, ensure_ascii=False) + "\n")
                sys.stdout.flush()
                if row["cleanup"] != "released" or row["reason"] in {
                    "supervisor_cancelled", "supervisor_paused", "unknown_outcome",
                }:
                    raise RuntimeError("benchmark_stopped_for_reconciliation")


if __name__ == "__main__":
    main()
