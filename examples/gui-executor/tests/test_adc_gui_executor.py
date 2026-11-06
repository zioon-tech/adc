# ruff: noqa: S101, INP001
import json
import time

import pytest

from adc_gui_executor.ark import ArkClient, ModelError
from adc_gui_executor.executor import Executor, Goal, compact_ui
from adc_gui_executor.summarize import timing_breakdown
from adc_gui_executor.transport import ADCError, Transport, unwrap


def goal(**overrides):
    return Goal(**{"objective": "查看显示设置", "acceptance": ["看到亮度"],
                   "allowed_packages": ["com.android.settings"], "required_text": ["亮度"],
                   "auto_accept": False,
                   **overrides})


def ui(text="亮度"):
    return {"snapshotId": "snapshot-1", "packageName": "com.android.settings",
            "nodes": [{"ref": "item-1", "text": text, "enabled": True}]}


class FakeTransport:
    def __init__(self, observation=None, fail=None):
        self.calls = []
        self.observation = observation or ui()
        self.fail = fail

    def invoke(self, tool, args, node, deadline, token=None, key=None):
        self.calls.append((tool, args, token, key))
        if tool == self.fail:
            raise ADCError("unknown_outcome")
        output = {}
        if tool == "screen.control" and args["action"] == "begin":
            output = {"controlSessionId": "test-control"}
        if tool == "ui.inspect":
            output = self.observation
        return {"status": "succeeded", "output": output}


class FakeModel:
    def __init__(self, action, callback=None):
        self.value = action
        self.callback = callback

    def complete(self, messages, deadline):
        if self.callback:
            self.callback()
        return json.dumps(self.value), {"actual_tier": "default"}


def test_ordered_milestones_cannot_finish_at_initial_final_page(tmp_path):
    stages = [{"id": "visit", "objective": "访问另一页", "required_text": ["另一页"]},
              {"id": "return", "objective": "返回亮度", "required_text": ["亮度"]}]
    result = Executor(FakeTransport(), FakeModel({"action": "done"}),
                      "node", tmp_path / "run").run(goal(auto_accept=True, milestones=stages))
    assert result["status"] != "succeeded"
    assert result["completed_milestones"] == []
    assert result["reason"] == "repeated_invalid_decision"


def test_calculator_previous_history_cannot_satisfy_current_result():
    stage = {"required_nodes": [{"selector": {"resourceId": "calc:result"}, "last": True,
                                 "equals": {"text": "= 200"}}]}
    assert Executor.milestone_evidence(stage, {"nodes": [
        {"resourceId": "calc:result", "text": "= 200"},
        {"resourceId": "calc:result", "text": "= 3"},
    ]}) is None
    assert Executor.milestone_evidence(stage, {"nodes": [
        {"resourceId": "calc:result", "text": "= 3"},
        {"resourceId": "calc:result", "text": "= 200"},
    ]})


def test_observe_advances_ordered_evidence_without_mutation(tmp_path):
    stages = [{"id": "a", "objective": "核验亮度", "required_text": ["亮度"]},
              {"id": "b", "objective": "再次核验", "required_text": ["亮度"]}]
    model = FakeModel({"action": "observe"})
    result = Executor(FakeTransport(), model, "node", tmp_path / "run").run(
        goal(auto_accept=True, milestones=stages))
    assert result["status"] == "succeeded"
    assert [item["id"] for item in result["completed_milestones"]] == ["a", "b"]
    assert not any(event.get("tool") == "ui.action" for event in result["events"])


def test_invalid_decision_budget_is_consecutive(tmp_path):
    decisions = iter([{"action": "click", "selector": {"text": "不存在"}},
                      {"action": "observe"}] * 3 + [{"action": "done"}])
    model = FakeModel({})
    model.complete = lambda _messages, _deadline: (json.dumps(next(decisions)), {})
    result = Executor(FakeTransport(), model, "node", tmp_path / "run").run(goal())
    assert result["status"] == "succeeded"
    assert sum("validation_error" in event for event in result["events"]) == 3


def test_pending_wait_uses_same_job():
    class Pending(Transport):
        def __init__(self):
            self.requests = []

        def exchange(self, request, deadline):
            self.requests.append(request)
            if len(self.requests) == 1:
                return {"status": "running", "jobId": "job-existing"}
            return {"status": "succeeded", "output": {"task": {
                "status": "succeeded", "output": {"clicked": True},
            }}}
    transport = Pending()
    assert transport.invoke("ui.action", {}, "node", time.monotonic() + 10)["output"]["clicked"]
    assert transport.requests[1]["tool"] == "task.wait"
    assert transport.requests[1]["args"]["jobId"] == "job-existing"

def test_gui_queue_wait_uses_a_short_budget_and_keeps_pending_identity():
    class Pending(Transport):
        def __init__(self):
            self.requests = []
            self.deadlines = []

        def exchange(self, request, deadline):
            self.requests.append(request)
            self.deadlines.append(deadline)
            if len(self.requests) == 1:
                return {"status": "queued", "jobId": "job-existing", "invocationId": "inv-existing"}
            raise ADCError("unknown_outcome")

    transport = Pending()
    started = time.monotonic()
    with pytest.raises(ADCError, match="unknown_outcome") as failure:
        transport.invoke("screen.control", {"action": "begin"}, "node", started + 600, key="queue-begin-1")
    assert transport.deadlines[0] <= started + 30.1
    assert transport.requests[0]["executionTimeoutMs"] <= 30000
    assert transport.requests[1]["args"]["jobId"] == "job-existing"
    assert failure.value.result["jobId"] == "job-existing"
    assert failure.value.result["invocationId"] == "inv-existing"
    assert len(transport.requests) == 2


@pytest.mark.parametrize("status", ["denied", "offline", "cancelled", "unknown_outcome", "approval_required"])
def test_no_resubmit_on_terminal_failure(status):
    class Failing(Transport):
        calls = 0

        def exchange(self, request, deadline):
            self.calls += 1
            return {"status": status}
    transport = Failing()
    with pytest.raises(ADCError, match=status):
        transport.invoke("ui.action", {}, "node", time.monotonic() + 10)
    assert transport.calls == 1


def test_mcp_receipt_and_nested_task_unwrap():
    terminal = {"status": "succeeded", "output": {"found": True}}
    envelope = {"content": [{"type": "text", "text": json.dumps({
        "status": "succeeded", "output": {"task": terminal},
    })}]}
    assert unwrap(envelope) == terminal


def test_success_releases_control(tmp_path):
    transport = FakeTransport()
    result = Executor(transport, FakeModel({"action": "done"}), "node", tmp_path / "run").run(goal())
    assert result["status"] == "succeeded"
    assert result["cleanup"] == "released"
    assert transport.calls[-1][1]["action"] == "end"
    assert not any("test-control" in file.read_text() for file in (tmp_path / "run").iterdir())


def test_done_requires_visible_acceptance(tmp_path):
    transport = FakeTransport(ui("其他项目"))
    result = Executor(transport, FakeModel({"action": "done"}), "node", tmp_path / "run").run(goal())
    assert result["reason"] == "repeated_invalid_decision"
    assert any(event.get("validation_error") == "acceptance_not_observed" for event in result["events"])
    assert result["cleanup"] == "released"


def test_independent_acceptance_stops_before_redundant_model_action(tmp_path):
    transport = FakeTransport()
    model = FakeModel({"action": "click", "selector": {"text": "亮度"}},
                      lambda: pytest.fail("Accepted state must not request another action"))
    result = Executor(transport, model, "node", tmp_path / "run").run(goal(auto_accept=True))
    assert result["status"] == "succeeded"
    assert result["reason"] == "independent_acceptance_observed"
    assert not any(call[0] == "ui.action" for call in transport.calls)
    assert result["cleanup"] == "released"


def test_independent_acceptance_requires_exact_editable_input(tmp_path):
    executor = Executor(FakeTransport(), FakeModel({}), "node", tmp_path / "run")
    state = ui("字体设置")
    state["nodes"].append({"nodeId": 24, "text": "字体大小", "editable": True})
    criteria = goal(auto_accept=True, required_text=["字体设置"], required_input_text=["字体"])
    assert not executor.independently_accepted(criteria, state)
    state["nodes"][-1]["text"] = "字体"
    assert executor.independently_accepted(criteria, state)


def test_independent_acceptance_rejects_out_of_scope_or_empty_evidence(tmp_path):
    executor = Executor(FakeTransport(), FakeModel({}), "node", tmp_path / "run")
    state = ui()
    state["packageName"] = "com.other.app"
    assert not executor.independently_accepted(goal(auto_accept=True), state)
    assert not executor.independently_accepted(goal(auto_accept=True, required_text=[]), ui())


def test_cancel_during_inference_fences_action(tmp_path):
    control = tmp_path / "control.json"
    model = FakeModel({"action": "click", "selector": {"text": "亮度"}},
                      lambda: control.write_text('{"cancel":true}'))
    transport = FakeTransport()
    result = Executor(transport, model, "node", tmp_path / "run", control).run(goal())
    assert result["reason"] == "supervisor_cancelled"
    assert not any(call[0] == "ui.action" for call in transport.calls)
    assert result["cleanup"] == "released"


def test_revision_during_inference_fences_action(tmp_path):
    control = tmp_path / "control.json"
    model = FakeModel({"action": "click", "selector": {"text": "亮度"}},
                      lambda: control.write_text('{"revision":2}'))
    transport = FakeTransport()
    result = Executor(transport, model, "node", tmp_path / "run", control).run(goal())
    assert result["reason"] == "goal_revised"
    assert not any(call[0] == "ui.action" for call in transport.calls)


def test_unknown_outcome_stops_and_releases(tmp_path):
    transport = FakeTransport(fail="ui.action")
    model = FakeModel({"action": "click", "selector": {"text": "亮度"}})
    result = Executor(transport, model, "node", tmp_path / "run").run(goal())
    assert result["reason"] == "unknown_outcome"
    assert len([call for call in transport.calls if call[0] == "ui.action"]) == 1
    assert result["cleanup"] == "released"


def test_stale_snapshot_reobserved_before_new_decision(tmp_path):
    class Changing(FakeTransport):
        first = True

        def invoke(self, tool, args, node, deadline, token=None, key=None):
            if tool == "ui.action" and self.first:
                self.first = False
                self.calls.append((tool, args, token, key))
                self.observation = ui("已完成")
                raise ADCError("failed", {"error": {"code": "conflict"}})
            return super().invoke(tool, args, node, deadline, token, key)
    class StateModel:
        def complete(self, messages, deadline):
            observation = json.loads(messages[1]["content"][0]["text"])["observation"]
            decision = {"action": "done"} if observation["nodes"][0]["text"] == "已完成" else {
                "action": "click", "selector": {"text": "亮度"},
            }
            return json.dumps(decision), {}
    transport = Changing()
    result = Executor(transport, StateModel(), "node", tmp_path / "run", message_mode="roles").run(
        goal(required_text=["已完成"]),
    )
    assert result["status"] == "succeeded"
    assert len([call for call in transport.calls if call[0] == "ui.action"]) == 1
    assert len([call for call in transport.calls if call[0] == "ui.inspect"]) == 2


def test_conflict_feedback_reaches_next_model_and_false_done_replans(tmp_path):
    class ConflictOnce(FakeTransport):
        first = True

        def invoke(self, tool, args, node, deadline, token=None, key=None):
            if tool == "ui.action" and self.first:
                self.first = False
                self.calls.append((tool, args, token, key))
                raise ADCError("failed", {"error": {"code": "conflict"}})
            value = super().invoke(tool, args, node, deadline, token, key)
            if tool == "ui.action":
                self.observation = ui("已完成")
            return value

    class RecoveringModel:
        calls = 0

        def complete(self, messages, deadline):
            self.calls += 1
            data = json.loads(messages[1]["content"][0]["text"])
            if self.calls == 2:
                assert data["recent_steps"][-1]["action_outcome"] == "rejected_snapshot_conflict"
                return '{"action":"done"}', {}
            if self.calls == 3:
                assert data["recent_steps"][-1]["validation_error"] == "acceptance_not_observed"
            return json.dumps({"action": "click", "selector": {"text": "亮度"}}), {}

    transport = ConflictOnce()
    model = RecoveringModel()
    result = Executor(transport, model, "node", tmp_path / "run").run(
        goal(auto_accept=True, required_text=["已完成"]),
    )
    assert result["status"] == "succeeded"
    assert model.calls == 3
    assert len([call for call in transport.calls if call[0] == "ui.action"]) == 2
    assert result["cleanup"] == "released"


@pytest.mark.parametrize(("sequences", "mode", "supervised"), [
    (False, "roles", False), (False, "roles", True),
    (False, "single_text", False), (True, "roles", False), (True, "roles", True),
])
def test_decide_advertises_only_transport_sequence_capability(tmp_path, sequences, mode, supervised):
    transport = FakeTransport()
    transport.supports_sequences = sequences
    criteria = goal(sequence_packages=["com.android.settings"], sequence_labels=["1", "加"])
    original = json.dumps(criteria.__dict__, sort_keys=True)

    class CapabilityModel:
        def complete(self, messages, _deadline):
            if mode == "single_text":
                text = messages[0]["content"]
                data = json.loads(text.split("BEGIN_UNTRUSTED_OBSERVATION_JSON\n")[1]
                                  .split("\nEND_UNTRUSTED_OBSERVATION_JSON")[0])
            else:
                text = messages[0]["content"]
                data = json.loads(messages[1]["content"][0]["text"])
            assert data["goal"]["sequence_packages"] == (criteria.sequence_packages if sequences else [])
            assert data["goal"]["sequence_labels"] == (criteria.sequence_labels if sequences else [])
            if not sequences:
                assert "click_sequence" not in text
                assert "one click per decision" in text
            return '{"action":"observe"}', {}

    actor = CapabilityModel()
    executor = Executor(transport, actor, "node", tmp_path / "run",
                        message_mode=mode, supervisor=actor)
    executor.decide(criteria, ui(), None, [], time.monotonic() + 5,
                    use_supervisor=supervised, planning=supervised)
    assert json.dumps(criteria.__dict__, sort_keys=True) == original


def test_not_found_reobserves_and_uses_new_decision_and_key(tmp_path):
    class MissingOnce(FakeTransport):
        def invoke(self, tool, args, node, deadline, token=None, key=None):
            if tool == "ui.action" and self.observation["snapshotId"] == "snapshot-1":
                self.calls.append((tool, args, token, key))
                self.observation = {**ui("字体设置"), "snapshotId": "snapshot-2"}
                raise ADCError("failed", {"error": {"code": "not_found", "retryable": False,
                    "message": "The matched element has no clickable ancestor."}})
            value = super().invoke(tool, args, node, deadline, token, key)
            if tool == "ui.action":
                self.observation = ui("已完成")
            return value

    class ReplanningModel:
        def complete(self, messages, _deadline):
            data = json.loads(messages[1]["content"][0]["text"])
            if data["recent_steps"]:
                assert data["recent_steps"][-1]["action_outcome"] == "rejected_target_not_found"
            return json.dumps({"action": "click", "selector": {
                "text": data["observation"]["nodes"][0]["text"],
            }}), {}

    transport = MissingOnce()
    result = Executor(transport, ReplanningModel(), "node", tmp_path / "run").run(
        goal(required_text=["已完成"], auto_accept=True))
    actions = [call for call in transport.calls if call[0] == "ui.action"]
    assert result["status"] == "succeeded"
    assert len(actions) == 2
    assert actions[0][1]["selector"]["text"] == "亮度"
    assert actions[1][1]["selector"] == {"text": "字体设置", "snapshotId": "snapshot-2"}
    assert actions[0][3] != actions[1][3]
    assert len([call for call in transport.calls if call[0] == "ui.inspect"]) == 3
    assert result["cleanup"] == "released"


@pytest.mark.parametrize(("tool", "status", "code"), [
    ("ui.action", "unknown_outcome", "not_found"),
    ("ui.action", "unknown_outcome", "conflict"),
    ("ui.action", "denied", "conflict"),
    ("ui.action", "failed", "execution_failed"),
    ("app.open", "failed", "not_found"),
])
def test_replan_does_not_replay_uncertain_or_other_failures(tmp_path, tool, status, code):
    class Terminal(FakeTransport):
        def invoke(self, requested, args, node, deadline, token=None, key=None):
            if requested == tool:
                self.calls.append((requested, args, token, key))
                raise ADCError(status, {"error": {"code": code}})
            return super().invoke(requested, args, node, deadline, token, key)
    transport = Terminal()
    decision = ({"action": "open", "package": "com.android.settings"} if tool == "app.open" else
                {"action": "click", "selector": {"text": "亮度"}})
    result = Executor(transport, FakeModel(decision), "node", tmp_path / "run").run(goal())
    assert result["status"] == "interrupted"
    assert result["reason"] == status
    assert len([call for call in transport.calls if call[0] == tool]) == 1
    assert result["cleanup"] == "released"


def test_repeated_target_rejection_has_bounded_replan_budget(tmp_path):
    class AlwaysMissing(FakeTransport):
        def invoke(self, tool, args, node, deadline, token=None, key=None):
            if tool == "ui.action":
                self.calls.append((tool, args, token, key))
                raise ADCError("failed", {"error": {"code": "not_found"}})
            return super().invoke(tool, args, node, deadline, token, key)
    transport = AlwaysMissing()
    result = Executor(transport, FakeModel({"action": "click", "selector": {"text": "亮度"}}),
                      "node", tmp_path / "run").run(goal(max_steps=20))
    assert result["reason"] == "target_replan_budget_exhausted"
    assert len([call for call in transport.calls if call[0] == "ui.action"]) == 3
    assert result["cleanup"] == "released"


@pytest.mark.parametrize(("decision", "code"), [
    ({"action": "open", "package": "com.bank"}, "package_outside_scope"),
    ({"action": "delete"}, "action_outside_scope"),
    ({"action": "click", "selector": {"text": "不存在"}}, "selector_not_observed"),
    ({"action": "click", "selector": {"text": "亮"}}, "selector_not_observed"),
    ({"action": "click", "selector": {"role": "button"}}, "unsupported_selector"),
])
def test_scope_and_selector_guards(tmp_path, decision, code):
    executor = Executor(FakeTransport(), FakeModel({}), "node", tmp_path / "run")
    with pytest.raises(ADCError, match=code):
        executor.action(decision, goal(), ui())


def test_selector_fenced_to_snapshot(tmp_path):
    executor = Executor(FakeTransport(), FakeModel({}), "node", tmp_path / "run")
    tool, args = executor.action({"action": "click", "selector": {"text": "亮度"}}, goal(), ui())
    assert tool == "ui.action"
    assert args["selector"]["snapshotId"] == "snapshot-1"


def test_text_hint_cannot_receive_input(tmp_path):
    executor = Executor(FakeTransport(), FakeModel({}), "node", tmp_path / "run")
    with pytest.raises(ADCError, match="target_not_editable"):
        executor.action({"action": "set_text", "selector": {"text": "亮度"}, "text": "test"}, goal(), ui())


def test_android_hint_resolves_unique_editable_peer(tmp_path):
    executor = Executor(FakeTransport(), FakeModel({}), "node", tmp_path / "run")
    state = ui("搜索设置")
    state["nodes"][0]["resourceId"] = "input"
    state["nodes"].append({"nodeId": 24, "resourceId": "input", "editable": True, "enabled": True})
    _, args = executor.action({"action": "set_text", "selector": {"text": "搜索设置"}, "text": "字体"},
                             goal(), state)
    assert args["selector"]["nodeId"] == 24
    assert args["selector"]["snapshotId"] == "snapshot-1"


def test_resource_id_filters_noneditable_duplicate(tmp_path):
    executor = Executor(FakeTransport(), FakeModel({}), "node", tmp_path / "run")
    state = ui("搜索设置")
    state["nodes"][0]["resourceId"] = "input"
    state["nodes"].append({"nodeId": 24, "resourceId": "input", "editable": True, "enabled": True})
    _, args = executor.action({"action": "set_text", "selector": {"resourceId": "input"}, "text": "字体"},
                             goal(), state)
    assert args["selector"]["nodeId"] == 24


def test_ambiguous_editable_peers_never_dispatch(tmp_path):
    executor = Executor(FakeTransport(), FakeModel({}), "node", tmp_path / "run")
    state = ui("搜索设置")
    state["nodes"][0]["resourceId"] = "input"
    state["nodes"].extend([{"nodeId": i, "resourceId": "input", "editable": True} for i in (24, 25)])
    with pytest.raises(ADCError, match="target_not_editable"):
        executor.action({"action": "set_text", "selector": {"text": "搜索设置"}, "text": "字体"},
                        goal(), state)


def test_invalid_selector_replanned_without_device_mutation(tmp_path):
    class CorrectingModel:
        calls = 0

        def complete(self, messages, deadline):
            self.calls += 1
            data = json.loads(messages[1]["content"][0]["text"])
            if self.calls == 1:
                return json.dumps({"action": "set_text", "selector": {"text": "亮度"}, "text": "x"}), {}
            assert data["recent_steps"][-1]["validation_error"] == "target_not_editable"
            return '{"action":"done"}', {}
    transport = FakeTransport()
    result = Executor(transport, CorrectingModel(), "node", tmp_path / "run", message_mode="roles").run(goal())
    assert result["status"] == "succeeded"
    assert not any(call[0] == "ui.action" for call in transport.calls)


def test_invalid_open_package_feedback_without_launch(tmp_path):
    class CorrectingModel:
        calls = 0

        def complete(self, messages, deadline):
            self.calls += 1
            payload = json.loads(messages[1]["content"][0]["text"])
            if self.calls == 1:
                return '{"action":"open","package":"com.miui.misettings"}', {}
            assert payload["recent_steps"][-1]["validation_error"] == "package_outside_scope"
            return '{"action":"done"}', {}
    transport = FakeTransport()
    result = Executor(transport, CorrectingModel(), "node", tmp_path / "run").run(goal())
    assert result["status"] == "succeeded"
    assert not any(call[0] == "app.open" for call in transport.calls)


def test_actor_focuses_current_milestone_and_drops_old_reason(tmp_path):
    class InspectingModel:
        def complete(self, messages, deadline):
            payload = json.loads(messages[1]["content"][0]["text"])
            assert payload["goal"]["objective"] == "第二步"
            assert payload["completed_milestones"] == ["first"]
            assert payload["recent_steps"] == [{"action_outcome": "no_visible_change",
                                               "decision": {"action": "back"}}]
            assert "旧的错误策略" not in json.dumps(messages, ensure_ascii=False)
            return '{"action":"observe"}', {}
    executor = Executor(FakeTransport(), InspectingModel(), "node", tmp_path / "run")
    executor.completed_milestones = [{"id": "first"}]
    scoped = goal(milestones=[{"id": "first", "objective": "第一步", "required_text": ["1"]},
                              {"id": "second", "objective": "第二步", "required_text": ["2"]}])
    executor.decide(scoped, ui(), None, [{
        "decision": {"action": "back", "reason": "旧的错误策略", "next_intent": "旧的错误策略"},
        "action_outcome": "no_visible_change",
    }], time.monotonic() + 5)


def test_adaptive_capture_only_on_recovery_and_no_image_journal(tmp_path):
    class CaptureTransport(FakeTransport):
        def invoke(self, tool, args, node, deadline, token=None, key=None):
            result = super().invoke(tool, args, node, deadline, token, key)
            if tool == "screen.capture":
                result["output"] = {"dataUrl": "data:image/jpeg;base64,fixture-image"}
            return result

    class Supervisor:
        def complete(self, messages, deadline):
            parts = messages[1]["content"]
            assert parts[1]["image_url"]["url"].endswith("fixture-image")
            return '{"action":"done","guidance":"verified"}', {}
    transport = CaptureTransport()
    result = Executor(transport, FakeModel({"action": "observe"}), "node", tmp_path / "run",
                      supervisor=Supervisor()).run(goal(), adaptive_visual=True)
    assert result["status"] == "succeeded"
    assert sum(call[0] == "screen.capture" for call in transport.calls) == 1
    assert "fixture-image" not in (tmp_path / "run" / "events.jsonl").read_text()


def test_single_text_fast_compatibility_keeps_observation_boundary(tmp_path):
    class InspectingModel:
        def complete(self, messages, deadline):
            assert len(messages) == 1
            assert isinstance(messages[0]["content"], str)
            assert "BEGIN_UNTRUSTED_OBSERVATION_JSON" in messages[0]["content"]
            assert "END_UNTRUSTED_OBSERVATION_JSON" in messages[0]["content"]
            return '{"action":"done"}', {}
    result = Executor(FakeTransport(), InspectingModel(), "node", tmp_path / "run",
                      message_mode="single_text").run(goal())
    assert result["status"] == "succeeded"


def test_fast_reject_fallback_is_explicit_and_measured(tmp_path):
    ark, _ = client(tmp_path, [])
    ark.fast_retries = 1
    ark.fallback_default = True
    calls = []

    def completion(_messages, _deadline, _max_tokens, tier):
        calls.append(tier)
        if tier == "fast":
            raise ModelError("ark_http_404:ModelNotOpen")
        return "{}", {"actual_tier": "default", "requested_tier": tier}
    ark._complete = completion  # noqa: SLF001 -- isolate provider transport
    _, metrics = ark.complete([], time.monotonic() + 10)
    assert calls == ["fast", "fast", "default"]
    assert metrics["fallback_used"]
    assert metrics["initial_requested_tier"] == "fast"
    assert metrics["actual_tier"] == "default"
    assert len(metrics["attempts"]) == 3


def test_other_model_failure_never_retried_or_fallback(tmp_path):
    ark, _ = client(tmp_path, [])
    ark.fast_retries = 2
    ark.fallback_default = True
    calls = []

    def completion(_messages, _deadline, _max_tokens, tier):
        calls.append(tier)
        raise ModelError("ark_http_401:InvalidApiKey")
    ark._complete = completion  # noqa: SLF001 -- isolate provider transport
    with pytest.raises(ModelError, match="401"):
        ark.complete([], time.monotonic() + 10)
    assert calls == ["fast"]


def test_password_nodes_excluded():
    data = ui()
    data["nodes"].append({"password": True, "text": "a secret"})
    assert "a secret" not in json.dumps(compact_ui(data))


def test_compact_ui_derives_click_ancestry_and_row_context():
    state = ui()
    state["nodes"] = [
        {"nodeId": 0, "parentId": None, "clickable": False},
        {"nodeId": 1, "parentId": 0, "text": "字体", "clickable": False},
        {"nodeId": 2, "parentId": 0, "clickable": True},
        {"nodeId": 3, "parentId": 2, "text": "护眼模式", "clickable": False},
        {"nodeId": 4, "parentId": 2, "text": "浏览器 > 设置", "clickable": False},
        {"nodeId": 5, "parentId": 0, "clickable": True},
        {"nodeId": 6, "parentId": 5, "text": "护眼模式", "clickable": False},
        {"nodeId": 7, "parentId": 5, "text": "系统设置 > 显示", "clickable": False},
        {"nodeId": 8, "parentId": 5, "password": True, "text": "secret-context"},
    ]
    projected = compact_ui(state)
    nodes = {n["nodeId"]: n for n in projected["nodes"]}
    assert nodes[1]["canClick"] is False
    assert nodes[3]["canClick"] is True
    assert nodes[6]["canClick"] is True
    assert "浏览器 > 设置" in nodes[3]["context"]
    assert "系统设置 > 显示" in nodes[6]["context"]
    assert "secret-context" not in json.dumps(projected)


@pytest.mark.parametrize(("truncated", "parent"), [(True, None), (False, 99), (False, 1)])
def test_compact_ui_incomplete_ancestry_never_invents_nonclickable(truncated, parent):
    state = ui()
    state.update(truncated=truncated, nodes=[
        {"nodeId": 1, "parentId": parent, "text": "入口", "clickable": False},
    ])
    assert compact_ui(state)["nodes"][0].get("canClick") is None


def test_decide_preserves_actionability_and_semantic_history(tmp_path):
    class InspectModel:
        def complete(self, messages, _deadline):
            value = json.loads(messages[-1]["content"][0]["text"])
            label = next(n for n in value["observation"]["nodes"] if n["text"] == "字体")
            assert label["clickable"] is False
            assert label["canClick"] is False
            assert value["recent_steps"][-1]["target"]["text"] == "1"
            assert "nodeId" not in value["recent_steps"][-1]["decision"]["selector"]
            return '{"action":"observe"}', {}

    executor = Executor(FakeTransport(), InspectModel(), "node", tmp_path / "run")
    state = compact_ui({**ui(), "nodes": [
        {"nodeId": 1, "parentId": None, "text": "字体", "clickable": False},
    ]})
    history = [{"decision": {"action": "click", "selector": {"nodeId": 75}},
                "target": {"text": "1", "resourceId": "calc:digit1"},
                "action_outcome": "succeeded"}]
    executor.decide(goal(), state, None, history, time.monotonic() + 5)


def test_nonclickable_target_replans_without_dispatch(tmp_path):
    state = compact_ui({**ui(), "nodes": [
        {"nodeId": 1, "parentId": None, "text": "字体", "clickable": False},
    ]})
    transport = FakeTransport(state)
    decisions = iter([{"action": "click", "selector": {"nodeId": 1}}, {"action": "done"}])
    model = FakeModel({})
    model.complete = lambda *_args: (json.dumps(next(decisions)), {})
    result = Executor(transport, model, "node", tmp_path / "run").run(goal(required_text=["字体"]))
    assert result["status"] == "succeeded"
    assert any(e.get("validation_error") == "target_not_clickable" for e in result["events"])
    assert not any(c[0] == "ui.action" for c in transport.calls)


def test_native_click_resolves_unique_semantics_and_records_label(tmp_path):
    state = compact_ui({**ui(), "nodes": [
        {"nodeId": 75, "parentId": None, "text": "1", "resourceId": "calc:digit1", "clickable": True},
    ]})
    class AfterClick(FakeTransport):
        def invoke(self, tool, args, *rest, **kwargs):
            result = super().invoke(tool, args, *rest, **kwargs)
            if tool == "ui.action":
                result["output"]["observation"] = ui("完成")
            return result
    transport = AfterClick(state)
    result = Executor(transport, FakeModel({"action": "click", "selector": {"nodeId": 75}}),
                      "node", tmp_path / "run").run(goal(auto_accept=True, required_text=["完成"]))
    action = next(c for c in transport.calls if c[0] == "ui.action")
    assert action[1]["selector"] == {"text": "1", "snapshotId": "snapshot-1"}
    step = next(e for e in result["events"] if e["type"] == "step")
    assert step["target"]["text"] == "1"
    assert step["target"]["resourceId"] == "calc:digit1"


def test_duplicate_click_labels_keep_exact_native_target(tmp_path):
    state = compact_ui({**ui(), "nodes": [
        {"nodeId": 1, "parentId": None, "text": "护眼模式", "clickable": True},
        {"nodeId": 2, "parentId": None, "text": "护眼模式", "clickable": True},
    ]})
    executor = Executor(FakeTransport(), FakeModel({}), "node", tmp_path / "run")
    _, args = executor.action({"action": "click", "selector": {"nodeId": 2}}, goal(), state)
    assert args["selector"] == {"nodeId": 2, "snapshotId": "snapshot-1"}


@pytest.mark.parametrize(("failure", "attempts"), [
    ("recover", 2), ("exhaust", 3), ("offline", 1), ("denied", 1),
    ("unknown_outcome", 1), ("unretryable", 1),
])
def test_observe_retry_is_bounded_and_only_for_retryable_root_read(tmp_path, failure, attempts):
    class ReadFailure(FakeTransport):
        def invoke(self, tool, args, *rest, **kwargs):
            if tool == "ui.inspect":
                self.calls.append((tool, args, kwargs.get("token"), kwargs.get("key")))
                count = sum(c[0] == tool for c in self.calls)
                if failure == "recover" and count > 1:
                    return {"status": "succeeded", "output": ui()}
                status = failure if failure in {"offline", "denied", "unknown_outcome"} else "failed"
                raise ADCError(status, {"error": {"code": "offline",
                                                 "retryable": failure != "unretryable"}})
            return super().invoke(tool, args, *rest, **kwargs)
    transport = ReadFailure()
    executor = Executor(transport, FakeModel({"action": "done"}), "node", tmp_path / "run")
    if failure == "recover":
        observed, _ = executor.observe(time.monotonic() + 10, False)
        assert observed["packageName"] == "com.android.settings"
    else:
        with pytest.raises(ADCError):
            executor.observe(time.monotonic() + 10, False)
    assert len(transport.calls) == attempts
    assert all(c[2] is None and c[3] is None for c in transport.calls)


def keypad_state(count=0, package="com.android.settings", changed=False):
    return {**ui(), "snapshotId": f"pad-{count}", "packageName": package, "nodes": [
        {"nodeId": 10 + count, "ref": f"window/one-{count}", "text": "1", "resourceId": "pad:1", "clickable": True,
         "checked": False, "enabled": True, "editable": False, "scrollable": False, "role": "button"},
        {"nodeId": 20 + count, "ref": f"window/two-{count}", "text": "2",
         "resourceId": "pad:changed" if changed else "pad:2",
         "clickable": True, "checked": False, "enabled": True, "editable": False,
         "scrollable": False, "role": "button"},
        {"nodeId": 30 + count, "ref": f"window/equal-{count}", "contentDescription": "等于",
         "resourceId": "pad:equal", "clickable": True,
         "checked": False, "enabled": True, "editable": False, "scrollable": False, "role": "button"},
        {"nodeId": 40 + count, "text": "完成" if count == 3 else f"表达式{count}", "clickable": False},
    ]}


class LocalKeypad(FakeTransport):
    supports_local_sequences = True

    def __init__(self, fail_at=None, status="failed", code="conflict", callback=None):
        super().__init__(keypad_state())
        self.completed = []
        self.fail_at, self.failure_status, self.failure_code = fail_at, status, code
        self.callback = callback

    def invoke(self, tool, args, *rest, **kwargs):
        result = super().invoke(tool, args, *rest, **kwargs)
        if tool == "ui.action":
            count = len(self.completed)
            if count == self.fail_at:
                raise ADCError(self.failure_status, {"error": {"code": self.failure_code}})
            assert args["selector"]["snapshotId"] == f"pad-{count}"
            assert "nodeId" not in args["selector"]
            self.completed.append(args["selector"].get("text") or args["selector"].get("contentDescription"))
            self.observation = keypad_state(count + 1)
            if self.callback:
                self.callback(self)
            result["output"]["observation"] = self.observation
        return result


def sequence_goal(**kwargs):
    return goal(auto_accept=True, required_text=["完成"],
                sequence_packages=["com.android.settings"], sequence_labels=["1", "2", "等于"], **kwargs)


def sequence_decision():
    return {"action": "click_sequence",
            "selectors": [{"nodeId": 10}, {"text": "2"}, {"contentDescription": "等于"}]}


def test_local_sequence_dispatches_current_keys_and_uses_only_public_actions(tmp_path):
    transport = LocalKeypad()
    model = FakeModel(sequence_decision())
    result = Executor(transport, model, "node", tmp_path / "run").run(sequence_goal())
    assert result["status"] == "succeeded"
    assert transport.completed == ["1", "2", "等于"]
    assert sum(e["type"] == "model" for e in result["events"]) == 1
    calls = [c for c in transport.calls if c[0] == "ui.action"]
    assert len(calls) == 3
    assert len({c[3] for c in calls}) == 3
    assert not any(c[0] in {"ui.sequence", "executor.click_sequence"} for c in transport.calls)
    assert result["cleanup"] == "released"


@pytest.mark.parametrize("code", ["conflict", "not_found"])
def test_local_sequence_conflict_keeps_executed_prefix_without_replay(tmp_path, code):
    def completed_first(transport):
        transport.observation["nodes"][-1]["text"] = "完成"
    transport = LocalKeypad(fail_at=1, code=code, callback=completed_first)
    result = Executor(transport, FakeModel(sequence_decision()), "node", tmp_path / "run").run(sequence_goal())
    assert result["status"] == "succeeded"
    assert transport.completed == ["1"]
    assert sum(c[0] == "ui.action" for c in transport.calls) == 2
    interrupted = next(e for e in result["events"] if e.get("status") == "sequence_interrupted")
    assert interrupted["primitive_count"] == 1


@pytest.mark.parametrize(("status", "code"), [
    ("unknown_outcome", "conflict"), ("offline", "offline"),
    ("denied", "denied"), ("failed", "execution_failed"),
])
def test_local_sequence_uncertain_or_terminal_failure_stops_all_remaining_keys(tmp_path, status, code):
    transport = LocalKeypad(fail_at=1, status=status, code=code)
    result = Executor(transport, FakeModel(sequence_decision()), "node", tmp_path / "run").run(sequence_goal())
    assert result["reason"] == status
    assert transport.completed == ["1"]
    assert sum(c[0] == "ui.action" for c in transport.calls) == 2
    assert result["cleanup"] == "released"


@pytest.mark.parametrize("change", ["package", "identity"])
def test_local_sequence_rechecks_foreground_and_key_identity(tmp_path, change):
    def alter(transport):
        if change == "package":
            transport.observation["packageName"] = "com.other.app"
        else:
            transport.observation["nodes"][1]["resourceId"] = "pad:changed"
    transport = LocalKeypad(callback=alter)
    executor = Executor(transport, FakeModel({}), "node", tmp_path / "run")
    executor.require_session({"controlSessionId": "test-control"})
    state = compact_ui(keypad_state())
    _, args = executor.action(sequence_decision(), sequence_goal(), state)
    with pytest.raises(ADCError, match="sequence_interrupted") as failure:
        executor.call_sequence(args, sequence_goal(), state, time.monotonic() + 10)
    assert failure.value.result["completed"] == 1
    assert transport.completed == ["1"]
    assert sum(c[0] == "ui.action" for c in transport.calls) == 1


def test_local_sequence_cancel_fences_each_key(tmp_path):
    control = tmp_path / "control.json"
    transport = LocalKeypad(callback=lambda _: control.write_text('{"cancel":true}'))
    result = Executor(transport, FakeModel(sequence_decision()), "node", tmp_path / "run",
                      control).run(sequence_goal())
    assert result["reason"] == "supervisor_cancelled"
    assert transport.completed == ["1"]
    assert sum(c[0] == "ui.action" for c in transport.calls) == 1


def test_local_sequence_missing_observation_reads_before_next_key(tmp_path):
    class ReadAfterClick(LocalKeypad):
        def invoke(self, tool, args, *rest, **kwargs):
            result = super().invoke(tool, args, *rest, **kwargs)
            if tool == "ui.action":
                result["output"].pop("observation")
            return result
    transport = ReadAfterClick()
    result = Executor(transport, FakeModel(sequence_decision()), "node", tmp_path / "run").run(
        sequence_goal())
    assert result["status"] == "succeeded"
    assert transport.completed == ["1", "2", "等于"]
    assert sum(c[0] == "ui.inspect" for c in transport.calls) == 4


def test_local_sequence_model_capability_and_history_are_semantic(tmp_path):
    transport = LocalKeypad()
    class SemanticModel:
        def complete(self, messages, _deadline):
            assert "click_sequence" in messages[0]["content"]
            data = json.loads(messages[1]["content"][0]["text"])
            assert data["goal"]["sequence_packages"] == ["com.android.settings"]
            assert data["recent_steps"][0]["decision"]["selectors"] == [
                {"text": "1", "resourceId": "pad:1"}]
            return '{"action":"observe"}', {}
    executor = Executor(transport, SemanticModel(), "node", tmp_path / "run")
    executor.decide(sequence_goal(), compact_ui(keypad_state()), None, [
        {"decision": {"action": "click_sequence", "selectors": [{"nodeId": 999}]},
         "targets": [{"text": "1", "resourceId": "pad:1"}], "completed_actions": 1},
    ], time.monotonic() + 10)


def test_compact_sequence_observation_keeps_window_identity_when_reused():
    current = compact_ui(keypad_state())
    reused = compact_ui(current)
    assert current["nodes"][0]["window"] == "window"
    assert reused["nodes"][0]["window"] == "window"


def test_local_sequence_expired_budget_never_dispatches_first_key(tmp_path):
    transport = LocalKeypad()
    executor = Executor(transport, FakeModel({}), "node", tmp_path / "run")
    state = compact_ui(keypad_state())
    _, args = executor.action(sequence_decision(), sequence_goal(), state)
    with pytest.raises(ADCError, match="deadline_exceeded"):
        executor.call_sequence(args, sequence_goal(), state, time.monotonic() - 1)
    assert transport.calls == []


@pytest.mark.parametrize("role", ["switch", "checkbox", "edit_text"])
def test_local_sequence_never_batches_settings_values_or_inputs(tmp_path, role):
    state = keypad_state()
    state["nodes"][0]["role"] = role
    executor = Executor(LocalKeypad(), FakeModel({}), "node", tmp_path / "run")
    with pytest.raises(ADCError, match="sequence_target_outside_scope"):
        executor.action(sequence_decision(), sequence_goal(), compact_ui(state))


class Response:
    ok = True

    def __init__(self, chunks):
        self.chunks = chunks

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def iter_lines(self, **kwargs):
        yield from self.chunks


class Session:
    def __init__(self, response):
        self.response = response

    def post(self, *args, **kwargs):
        self.payload = kwargs["json"]
        return self.response


def client(tmp_path, chunks):
    config = tmp_path / "config.yaml"
    config.write_text("default_model: fixture\ndefault_endpoint: https://example.invalid\n"
                      "models:\n  fixture:\n    api_key: test-only\n")
    session = Session(Response(chunks))
    return ArkClient(config_path=config, session=session), session


def data(value):
    return b"data: " + json.dumps(value).encode()


def test_sse_records_actual_tier_and_usage(tmp_path):
    ark, session = client(tmp_path, [
        data({"model": "mini", "service_tier": "default", "choices": [
            {"delta": {"content": "{}"}, "finish_reason": "stop"}]}),
        data({"usage": {"completion_tokens": 2, "prompt_tokens": 10}, "choices": []}),
        b"data: [DONE]",
    ])
    text, metrics = ark.complete([], time.monotonic() + 10)
    assert text == "{}"
    assert session.payload["service_tier"] == "fast"
    assert metrics["actual_tier"] == "default"
    assert metrics["usage"]["completion_tokens"] == 2
    assert metrics["ttft_s"] is not None


@pytest.mark.parametrize("chunks", [
    [data({"choices": [{"delta": {"content": "{}"}, "finish_reason": "length"}]}), b"data: [DONE]"],
    [data({"choices": [{"delta": {"content": "{}"}, "finish_reason": "stop"}]})],
    [b"data: [DONE]"],
    [b"data: malformed"],
])
def test_incomplete_or_malformed_model_output_never_executes(tmp_path, chunks):
    ark, _ = client(tmp_path, chunks)
    with pytest.raises(ModelError):
        ark.complete([], time.monotonic() + 10)


def test_model_expired_deadline_no_request(tmp_path):
    ark, session = client(tmp_path, [])
    with pytest.raises(ModelError, match="deadline_exceeded"):
        ark.complete([], time.monotonic() - 1)
    assert not hasattr(session, "payload")


def test_timing_accounting_does_not_double_count_device_execution():
    models = [{"model_total_s": 2, "model_s": 1.8, "ttft_s": 1, "decode_s": 0.5,
               "attempts": [{"status": "failed", "elapsed_s": 0.2}]}]
    receipts = [{"tool": "ui.inspect", "transport_s": 6, "device_s": 0.5}]
    result = timing_breakdown({"events": [], "wall_s": 12}, "fast", 10, models, receipts)
    assert result["model_total_s"] + result["adc_roundtrip_s"] + result["local_or_agent_residual_s"] == 10
    assert result["reported_device_s"] == 0.5
    assert result["adc_minus_reported_device_s"] == 5.5
    assert result["model_stream_tail_and_client_s"] == pytest.approx(0.3)
    assert result["excluded_control_wall_s"] == 2


def test_direct_model_time_remains_unknown_in_breakdown():
    record = {"events": [{"tool": "ui.inspect", "host_s": 2, "device_s": 0.1}], "wall_s": 10}
    result = timing_breakdown(record, "direct", 10, [], [])
    assert result["model_total_s"] is None
    assert result["model_fraction"] is None
    assert result["local_or_agent_residual_s"] == 8
    assert "unmeasured GPT-6" in result["residual_interpretation"]
    assert result["excluded_control_wall_s"] is None


def test_failed_model_time_and_missing_device_duration_are_visible():
    record = {"events": [{"type": "model_request", "at": 10},
                         {"type": "model_failure", "at": 11}], "wall_s": 5}
    result = timing_breakdown(record, "fast", 4, [],
                              [{"tool": "ui.action", "transport_s": 2, "status": "failed"}])
    assert result["model_total_s"] == 1
    assert result["failed_model_calls_s"] == 1
    assert result["missing_device_duration_count"] == 1
    assert result["local_or_agent_residual_s"] == 1
