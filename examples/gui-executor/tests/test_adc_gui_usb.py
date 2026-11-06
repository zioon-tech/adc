# ruff: noqa: S101, S105, S106, INP001
import json
import time

import pytest
import requests
from test_adc_gui_executor import FakeModel, FakeTransport, client, goal, ui

from adc_gui_executor.executor import Executor
from adc_gui_executor.transport import ADCError
from adc_gui_executor.usb import USBTransport, nearby_target, parse_hierarchy, target_identity
from adc_gui_executor.usb_benchmark import reset_settings


def xml(text="入口", top=20):
    return (f'<hierarchy><node package="com.android.settings" class="android.widget.Button" '
            f'text="{text}" resource-id="id/button" clickable="true" enabled="true" '
            f'bounds="[0,{top}][200,100]"/></hierarchy>')


def test_ambiguous_target_returns_candidates_for_model(tmp_path):
    state = ui()
    state["nodes"] = [{"nodeId": 1, "text": "护眼"}, {"nodeId": 2, "text": "护眼"}]
    executor = Executor(FakeTransport(), FakeModel({}), "node", tmp_path / "run")
    with pytest.raises(ADCError) as raised:
        executor.action({"action": "click", "selector": {"text": "护眼"}}, goal(), state)
    assert raised.value.status == "selector_ambiguous"
    assert [item["nodeId"] for item in raised.value.result["candidates"]] == [1, 2]


def test_after_action_observation_is_reused_without_extra_inspect(tmp_path):
    class WithObservation(FakeTransport):
        def invoke(self, tool, args, *rest, **kwargs):
            value = super().invoke(tool, args, *rest, **kwargs)
            if tool == "ui.action":
                value["output"]["observation"] = ui("完成")
            return value
    transport = WithObservation()
    result = Executor(transport, FakeModel({"action": "click", "selector": {"text": "亮度"}}),
                      "node", tmp_path / "run").run(goal(auto_accept=True, required_text=["完成"]))
    assert result["status"] == "succeeded"
    assert len([call for call in transport.calls if call[0] == "ui.inspect"]) == 1
    assert any(event["type"] == "observation_reused" for event in result["events"])


def test_supervisor_corrects_repeated_invalid_decisions(tmp_path):
    transport = FakeTransport()
    actor = FakeModel({"action": "click", "selector": {"text": "不存在"}})
    brain = FakeModel({"action": "done"})
    result = Executor(transport, actor, "node", tmp_path / "run", supervisor=brain).run(goal())
    assert result["status"] == "succeeded"
    assert len([item for item in result["events"] if item["type"] == "supervision"]) == 1


def test_local_receipts_do_not_invent_device_time_or_adc_receipt(tmp_path):
    class Local(FakeTransport):
        def invoke(self, *args, **kwargs):
            return {**super().invoke(*args, **kwargs), "transport": "usb"}
    result = Executor(Local(), FakeModel({"action": "done"}), "node", tmp_path / "run").run(goal())
    receipts = [item for item in result["events"] if item["type"] == "receipt"]
    assert all("device_s" not in item and item["receiptId"] is None for item in receipts)


def test_invalid_action_json_is_measured_and_never_dispatched(tmp_path):
    class InvalidModel:
        def complete(self, *_args):
            return "not JSON", {"model_total_s": .4, "model_s": .4}
    transport = FakeTransport()
    result = Executor(transport, InvalidModel(), "fixture", tmp_path / "run").run(goal())
    assert result["reason"] == "invalid_model_json"
    assert result["cleanup"] == "released"
    assert not any(call[0] == "ui.action" for call in transport.calls)
    assert sum(event.get("model_total_s", 0) for event in result["events"]
               if event["type"] == "model") == .4


def test_rejected_usb_action_preserves_read_timing_without_dispatch(tmp_path):
    transport = USBTransport("fixture", lock_directory=tmp_path)
    initial = parse_hierarchy(xml())
    transport.snapshot = initial
    transport.token = "fixture"
    transport.lease_until = time.monotonic() + 5
    calls = []

    def rpc(method, *_args, **_kwargs):
        calls.append(method)
        transport.metrics.append({"operation": method, "host_roundtrip_s": .02})
        return xml("另一项")
    transport.rpc = rpc
    executor = Executor(transport, FakeModel({}), "fixture", tmp_path / "run")
    executor.token = "fixture"
    with pytest.raises(ADCError):
        executor.call("ui.action", {"action": "click", "selector": {
            "nodeId": initial["nodes"][0]["nodeId"], "snapshotId": initial["snapshotId"],
        }}, time.monotonic() + 5, mutation=True)
    receipt = executor.events[-1]
    assert calls == ["dumpWindowHierarchy"]
    assert receipt["transport"] == "usb"
    assert receipt["error_code"] == "conflict"
    assert receipt["local_timings"][0]["host_roundtrip_s"] == .02
    assert receipt["receiptId"] is None


@pytest.mark.parametrize("wrong_foreground", [False, True])
def test_benchmark_reset_requires_root_evidence_and_always_releases(wrong_foreground):
    class ResetTransport:
        snapshot = None
        released = False

        def invoke(self, tool, args, serial, deadline, **kwargs):
            if tool == "screen.control" and args["action"] == "begin":
                return {"output": {"controlSessionId": "fixture"}}
            if tool == "screen.control" and args["action"] == "end":
                self.released = True
            return {"output": {}}

        def shell(self, argv, deadline, **kwargs):
            assert argv[-2:] == ["-f", "0x10008000"]
            assert "--activity-new-task" not in argv

        def after_action(self, before, deadline):
            return {"packageName": "com.miui.home" if wrong_foreground else "com.android.settings",
                    "snapshotId": "fixture",
                    "nodes": [{"text": "搜索系统设置项"}, {"text": "我的设备"}]}
    transport = ResetTransport()
    if wrong_foreground:
        with pytest.raises(ADCError, match="reset_wrong_foreground"):
            reset_settings(transport, "fixture", time.monotonic() + 5, "reset")
    else:
        assert reset_settings(transport, "fixture", time.monotonic() + 5, "reset")["scrolls"] == 0
    assert transport.released


def test_password_redaction_and_invisible_node_ignored():
    value = xml().replace("</hierarchy>",
        '<node package="com.android.settings" class="android.widget.EditText" password="true" '
        'text="secret" bounds="[0,100][200,200]"/>'
        '<node text="hidden" visible-to-user="false" bounds="[0,200][200,300]"/></hierarchy>')
    snapshot = parse_hierarchy(value)
    assert len(snapshot["nodes"]) == 2
    assert "secret" not in json.dumps(snapshot)


def test_semantic_node_ids_survive_unrelated_insertion_and_layout_shift():
    first = parse_hierarchy(xml("显示"))
    shifted = xml("显示", top=25).replace("<hierarchy>", '<hierarchy><node text="另一项" '
        'package="com.android.settings" class="android.widget.TextView" bounds="[200,20][400,100]"/>')
    later = parse_hierarchy(shifted)
    assert first["nodes"][0]["nodeId"] == later["nodes"][1]["nodeId"]
    assert first["snapshotId"] != later["snapshotId"]


def test_actor_references_are_short_and_never_reused_after_layout_change(tmp_path):
    transport = USBTransport("fixture", lock_directory=tmp_path)
    values = iter([xml("显示"), xml("壁纸"), xml("显示", top=25)])
    transport.rpc = lambda *_args: next(values)
    first, other, shifted = [transport.inspect(time.monotonic() + 5) for _ in range(3)]
    assert isinstance(first["nodes"][0]["nodeId"], int)
    assert first["nodes"][0]["nodeId"] != other["nodes"][0]["nodeId"]
    assert first["nodes"][0]["nodeId"] == shifted["nodes"][0]["nodeId"]


def test_keypad_labels_resolve_only_unique_current_targets(tmp_path):
    transport = FakeTransport()
    transport.supports_sequences = True
    executor = Executor(transport, FakeModel({}), "fixture", tmp_path / "run")
    state = ui()
    state["nodes"] = [{"nodeId": 1, "text": "5", "clickable": True},
                      {"nodeId": 2, "contentDescription": "加", "clickable": True}]
    permitted = goal(sequence_packages=["com.android.settings"], sequence_labels=["5", "加"])
    tool, args = executor.action({"action": "click_sequence", "selectors": [
        {"text": "5"}, {"contentDescription": "加"},
    ]}, permitted, state)
    assert tool == "ui.sequence"
    assert all(selector["snapshotId"] == state["snapshotId"] for selector in args["selectors"])
    state["nodes"].append({"nodeId": 3, "text": "5", "clickable": True})
    with pytest.raises(ADCError, match="selector_ambiguous"):
        executor.action({"action": "click_sequence", "selectors": [{"text": "5"}]},
                        permitted, state)


def test_current_value_predicates_remove_old_history_only_from_model_context(tmp_path):
    class CurrentModel:
        def complete(self, messages, *_args):
            data = json.loads(messages[1]["content"][0]["text"])
            assert [node["nodeId"] for node in data["observation"]["nodes"]] == [2]
            return '{"action":"observe"}', {}
    executor = Executor(FakeTransport(), CurrentModel(), "fixture", tmp_path / "run")
    state = ui()
    state["nodes"] = [{"nodeId": 1, "resourceId": "id/result", "text": "= 200"},
                      {"nodeId": 2, "resourceId": "id/result", "text": "= 600"}]
    stages = [{"id": "current", "objective": "核验当前值", "required_nodes": [{
        "selector": {"resourceId": "id/result"}, "last": True, "equals": {"text": "= 600"},
    }]}]
    assert executor.decide(goal(milestones=stages), state, None, [], time.monotonic() + 5)["action"] == "observe"
    assert len(state["nodes"]) == 2


def test_old_node_id_never_aliases_different_label_at_same_position(tmp_path):
    old = parse_hierarchy(xml("显示"))
    new = parse_hierarchy(xml("壁纸与个性化"))
    assert old["nodes"][0]["nodeId"] != new["nodes"][0]["nodeId"]
    executor = Executor(FakeTransport(), FakeModel({}), "node", tmp_path / "run")
    with pytest.raises(ADCError, match="selector_not_observed"):
        executor.action({"action": "click", "selector": {"nodeId": old["nodes"][0]["nodeId"]}},
                        goal(), new)


def test_editable_node_identity_survives_query_change_and_duplicates_are_distinct():
    first = xml("字体").replace("android.widget.Button", "android.widget.EditText")
    second = first.replace('text="字体"', 'text="护眼"')
    assert parse_hierarchy(first)["nodes"][0]["nodeId"] == parse_hierarchy(second)["nodes"][0]["nodeId"]
    repeated = xml().replace("</hierarchy>", xml().split("<hierarchy>")[1])
    ids = [node["nodeId"] for node in parse_hierarchy(repeated)["nodes"]]
    assert len(set(ids)) == 2


def test_transient_empty_tree_is_read_again_without_action(tmp_path):
    transport = USBTransport("fixture", lock_directory=tmp_path)
    values = iter(["<hierarchy/>", xml()])
    calls = []

    def rpc(method, *_args):
        calls.append(method)
        return next(values)
    transport.rpc = rpc
    assert transport.inspect(time.monotonic() + 5)["nodes"][0]["text"] == "入口"
    assert calls == ["dumpWindowHierarchy", "dumpWindowHierarchy"]


def test_persistent_empty_tree_stops_after_four_read_samples(tmp_path):
    transport = USBTransport("fixture", lock_directory=tmp_path)
    calls = []

    def rpc(method, *_args):
        calls.append(method)
        return "<hierarchy/>"
    transport.rpc = rpc
    with pytest.raises(ADCError, match="empty_usb_hierarchy"):
        transport.inspect(time.monotonic() + 5)
    assert len(calls) == 4


def test_planner_runs_once_per_milestone_then_mini_follows_guidance(tmp_path):
    class ProgressTransport(FakeTransport):
        def invoke(self, tool, args, *rest, **kwargs):
            value = super().invoke(tool, args, *rest, **kwargs)
            if tool == "ui.action":
                value["output"]["observation"] = ui("完成")
            return value

    actor = FakeModel({"action": "click", "selector": {"text": "亮度"}})
    planner = FakeModel({"action": "observe", "guidance": "点击亮度入口"})
    stages = [{"id": "visit", "objective": "完成子目标", "required_text": ["完成"]}]
    result = Executor(ProgressTransport(), actor, "node", tmp_path / "run", supervisor=planner).run(
        goal(milestones=stages, auto_accept=True, required_text=["完成"]), plan_milestones=True)
    assert result["status"] == "succeeded"
    assert [event["role"] for event in result["events"] if event["type"] == "model"] == ["planner", "executor"]
    assert sum(event.get("trigger") == "milestone_plan" for event in result["events"]) == 1


def test_local_ownership_excludes_second_actor_and_releases(tmp_path):
    class ADB:
        def forward_port(self, port):
            return port
    class Device:
        adb_device = ADB()
    first = USBTransport("fixture", device=Device(), lock_directory=tmp_path)
    second = USBTransport("fixture", device=Device(), lock_directory=tmp_path)
    deadline = time.monotonic() + 10
    first.control({"action": "begin"}, deadline)
    with pytest.raises(ADCError, match="usb_already_owned"):
        second.control({"action": "begin"}, deadline)
    first.release()
    second.control({"action": "begin"}, deadline)
    second.release()


@pytest.mark.parametrize(("replacement", "code"), [(xml(top=30), "conflict"), (xml("另一页"), "conflict")])
def test_usb_revalidates_target_position_and_identity_before_click(tmp_path, replacement, code):
    transport = USBTransport("fixture", lock_directory=tmp_path)
    initial = parse_hierarchy(xml())
    transport.snapshot = initial
    transport.rpc = lambda *_args, **_kwargs: replacement
    with pytest.raises(ADCError) as raised:
        transport.resolve({"nodeId": initial["nodes"][0]["nodeId"], "snapshotId": initial["snapshotId"]},
                          time.monotonic() + 10)
    assert raised.value.result["error"]["code"] == code


def test_usb_target_reacquisition_allows_unrelated_node_change(tmp_path):
    transport = USBTransport("fixture", lock_directory=tmp_path)
    initial = parse_hierarchy(xml())
    transport.snapshot = initial
    extra = xml().replace("</hierarchy>", '<node text="unrelated" bounds="[0,100][200,200]"/></hierarchy>')
    transport.rpc = lambda *_args, **_kwargs: extra
    assert transport.resolve({"nodeId": initial["nodes"][0]["nodeId"], "snapshotId": initial["snapshotId"]},
                             time.monotonic() + 10)["text"] == "入口"


@pytest.mark.parametrize(("shift", "text", "accepted"), [(5, "入口", True), (10, "入口", False),
                                                        (5, "另一页", False)])
def test_reacquisition_only_allows_small_overlap_of_same_target(shift, text, accepted):
    expected = parse_hierarchy(xml())["nodes"][0]
    candidate = parse_hierarchy(xml(text=text, top=20 + shift))["nodes"][0]
    assert nearby_target(target_identity(expected), candidate,
                         {"width": 1080, "height": 2460}) is accepted


def test_rpc_lost_mutation_response_never_replays(tmp_path):
    class Lost:
        trust_env = True
        calls = 0
        def post(self, *args, **kwargs):
            self.calls += 1
            raise requests.Timeout
    session = Lost()
    transport = USBTransport("fixture", session=session, lock_directory=tmp_path)
    with pytest.raises(ADCError, match="unknown_outcome"):
        transport.rpc("click", [10, 10], time.monotonic() + 10, mutation=True)
    assert session.calls == 1


def test_cancel_after_target_read_stops_dispatch(tmp_path):
    transport = USBTransport("fixture", lock_directory=tmp_path)
    transport.mutation_guard = lambda: (_ for _ in ()).throw(ADCError("supervisor_cancelled"))
    with pytest.raises(ADCError, match="supervisor_cancelled"):
        transport.rpc("click", [10, 10], time.monotonic() + 10, mutation=True)


def test_lease_expiry_and_duplicate_actions_are_fenced(tmp_path):
    transport = USBTransport("fixture", lock_directory=tmp_path)
    transport.token = "fixture"
    transport.lease_until = time.monotonic() - 1
    with pytest.raises(ADCError, match="usb_control_not_owned"):
        transport.invoke("device.navigation", {"action": "back"}, "fixture", time.monotonic() + 10,
                         token="fixture", key="key1")
    transport.lease_until = time.monotonic() + 10
    transport.used_keys.add("key1")
    with pytest.raises(ADCError, match="duplicate"):
        transport.invoke("device.navigation", {"action": "back"}, "fixture", time.monotonic() + 10,
                         token="fixture", key="key1")


def test_fast_rejection_opens_bounded_circuit_without_hiding_fallback(tmp_path):
    ark, _ = client(tmp_path, [])
    ark.fallback_default = True
    calls = []
    def complete(_messages, _deadline, _max_tokens, tier):
        calls.append(tier)
        if tier == "fast":
            from adc_gui_executor.ark import ModelError
            raise ModelError("ark_http_404:ModelNotOpen")
        return "{}", {"actual_tier": "default"}
    ark._complete = complete  # noqa: SLF001 -- isolate provider
    ark.complete([], time.monotonic() + 10)
    _, metrics = ark.complete([], time.monotonic() + 10)
    assert calls == ["fast", "default", "default"]
    assert metrics["fast_circuit_open"]
    assert metrics["fallback_used"]
    assert metrics["actual_tier"] == "default"


def test_stabilizer_rejects_first_transitional_frame(tmp_path):
    transport = USBTransport("fixture", lock_directory=tmp_path)
    before = parse_hierarchy(xml("before"))
    transit = parse_hierarchy(xml("moving", top=25))
    final = parse_hierarchy(xml("final"))
    samples = iter([transit, final, final])
    transport.inspect = lambda _deadline: next(samples)
    result = transport.after_action(before, time.monotonic() + 10)
    assert result["nodes"][0]["text"] == "final"
    assert result["readiness"]["polls"] == 3
    assert result["readiness"]["stable"]


def test_sequence_stops_at_page_change_without_replaying_prefix(tmp_path):
    transport = USBTransport("fixture", lock_directory=tmp_path)
    initial = parse_hierarchy(xml("1"))
    transport.snapshot = initial
    samples = iter([initial, parse_hierarchy(xml("other"))])
    transport.inspect = lambda _deadline: next(samples)
    actions = []
    transport.rpc = lambda method, params, *_args, **_kwargs: actions.append((method, params))
    selector = {"nodeId": initial["nodes"][0]["nodeId"], "snapshotId": initial["snapshotId"]}
    with pytest.raises(ADCError, match="sequence_interrupted") as raised:
        transport.sequence([selector, selector], time.monotonic() + 10)
    assert raised.value.result["completed"] == 1
    assert len(actions) == 1


def test_sequences_cannot_include_navigation_or_unapproved_buttons(tmp_path):
    transport = FakeTransport()
    transport.supports_sequences = True
    executor = Executor(transport, FakeModel({}), "node", tmp_path / "run")
    state = ui()
    state["nodes"][0].update({"nodeId": 1, "clickable": True})
    permitted = goal(sequence_packages=["com.android.settings"], sequence_labels=["1"])
    with pytest.raises(ADCError, match="sequence_target_outside_scope"):
        executor.action({"action": "click_sequence", "selectors": [{"nodeId": 1}]}, permitted, state)


def test_recovery_guidance_survives_next_executor_step(tmp_path):
    class Guided:
        calls = 0
        def complete(self, messages, deadline):
            self.calls += 1
            request = json.loads(messages[1]["content"][0]["text"])
            if self.calls <= 2:
                return '{"action":"click","selector":{"text":"不存在"}}', {}
            assert request["supervisor_guidance"]["guidance"] == "保留该策略直到完成"
            return '{"action":"done"}', {}
    supervisor = FakeModel({"action": "observe", "guidance": "保留该策略直到完成"})
    result = Executor(FakeTransport(), Guided(), "node", tmp_path / "run",
                      supervisor=supervisor).run(goal())
    assert result["status"] == "succeeded"
    assert sum(item["type"] == "supervision" for item in result["events"]) == 1


def test_scroll_uses_one_bounded_native_input_without_uiautomator_replay(tmp_path):
    transport = USBTransport("fixture", lock_directory=tmp_path)
    target = parse_hierarchy(xml())["nodes"][0]
    target["scrollable"] = True
    transport.resolve = lambda *_args: target
    calls = []
    transport.shell = lambda argv, *_args, **_kwargs: calls.append(argv)
    transport.action({"action": "scroll_forward", "selector": {}}, time.monotonic() + 10)
    assert len(calls) == 1
    assert calls[0][:3] == ["input", "touchscreen", "swipe"]
    start_y, end_y = int(calls[0][4]), int(calls[0][6])
    assert target["bounds"]["top"] < end_y < start_y < target["bounds"]["bottom"]
