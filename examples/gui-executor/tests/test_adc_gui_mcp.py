# ruff: noqa: S101, INP001
import json
import sys
import time

import pytest

from adc_gui_executor.executor import Executor
from adc_gui_executor.transport import ADCError, MCPTransport, unwrap

# A local protocol peer exercises actual pipe framing and process lifetime.
PEER = r"""
import json,sys
trace,mode=sys.argv[1:]
def reply(value):
    data=json.dumps(value)+"\n"
    sys.stdout.write(data[:4]);sys.stdout.flush()
    sys.stdout.write(data[4:]);sys.stdout.flush()
for line in sys.stdin:
    request=json.loads(line)
    with open(trace,"a") as log: log.write(json.dumps(request)+"\n")
    if "id" not in request: continue
    method=request["method"]
    if mode=="cli_error" and method=="initialize":
        sys.stderr.write(json.dumps({"error":{"code":"execution_timeout","message":"private secret"}})+"\n")
        sys.stderr.flush()
        break
    if method=="initialize":
        result={"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"peer","version":"1"}}
    elif method=="tools/list":
        props={} if mode=="legacy" else {"includeObservation":{"type":"boolean"}}
        result={"tools":[{"name":name,"inputSchema":{"properties":{"args":{"properties":props}}}}
                         for name in ["ui.inspect","ui.action","screen.control","task.wait"]]}
    else:
        if mode=="timeout":
            for ignored in sys.stdin: pass
            break
        if mode=="eof": break
        if mode=="malformed":
            sys.stdout.write("not json\n");sys.stdout.flush();continue
        if mode=="error":
            reply({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32602,"message":"private"}})
            continue
        if mode=="oversized":
            result={"padding":"x"*2000}
        else:
            output={"snapshotId":"uisnap_after","packageName":"com.android.settings","nodes":[{"text":"Brightness"}]}
            result={"content":[{"type":"text","text":json.dumps({"status":"succeeded","output":output})}]}
        reply({"jsonrpc":"2.0","method":"notifications/progress","params":{}})
    reply({"jsonrpc":"2.0","id":request["id"]+(1 if mode=="mismatch" and method=="tools/call" else 0),"result":result})
"""


def peer(tmp_path, mode="normal"):
    trace = tmp_path / "requests.jsonl"
    transport = MCPTransport(command=[sys.executable, "-u", "-c", PEER, str(trace), mode])
    return transport, trace


def request():
    return {"tool": "ui.action", "args": {"action": "click", "selector": {"nodeId": 2}},
            "target": {"nodeId": "node_test"}, "waitMs": 4000,
            "idempotencyKey": "test-action-1", "controlSessionId": "test-lease"}


@pytest.mark.parametrize(("mode", "include"), [("normal", True), ("legacy", False)])
def test_mcp_transport_reuses_process_and_discovers_schema(tmp_path, mode, include):
    transport, trace = peer(tmp_path, mode)
    assert not transport.supports_local_sequences
    try:
        for _ in range(2):
            result = unwrap(transport.exchange(request(), time.monotonic() + 3))
            assert result["output"]["snapshotId"] == "uisnap_after"
        assert transport.supports_local_sequences
        child = transport.process
        messages = [json.loads(line) for line in trace.read_text().splitlines()]
        assert [message["method"] for message in messages].count("initialize") == 1
        assert [message["method"] for message in messages].count("tools/list") == 1
        calls = [message for message in messages if message["method"] == "tools/call"]
        assert len(calls) == 2
        assert ("includeObservation" in calls[0]["params"]["arguments"]["args"]) == include
        assert calls[0]["params"]["arguments"]["controlSessionId"] == "test-lease"
    finally:
        transport.close()
    assert child.poll() is not None
    assert child.stdin.closed
    assert child.stdout.closed
    assert not transport.supports_local_sequences


@pytest.mark.parametrize(("mode", "status"), [
    ("eof", "unknown_outcome"), ("malformed", "invalid_mcp_response"),
    ("mismatch", "mcp_reply_mismatch"), ("error", "mcp_protocol_error"),
    ("oversized", "mcp_response_too_large"),
])
def test_mcp_transport_fences_broken_stream(tmp_path, mode, status):
    transport, trace = peer(tmp_path, mode)
    if mode == "oversized":
        transport.MAX_FRAME_BYTES = 1024
    with pytest.raises(ADCError, match=status):
        transport.exchange(request(), time.monotonic() + 3)
    assert transport.closed
    assert transport.process is None
    with pytest.raises(ADCError, match="mcp_transport_closed"):
        transport.exchange(request(), time.monotonic() + 1)
    messages = [json.loads(line) for line in trace.read_text().splitlines()]
    assert sum(message["method"] == "tools/call" for message in messages) == 1


def test_mcp_timeout_allows_only_independent_release(tmp_path):
    transport, trace = peer(tmp_path, "timeout")
    # Complete discovery before imposing a short deterministic read deadline.
    transport._start(time.monotonic() + 3)  # noqa: SLF001 -- isolate the timed read from process startup
    listed = transport._rpc("tools/list", {}, time.monotonic() + 3)  # noqa: SLF001
    transport.tools = {item["name"]: item for item in listed["tools"]}
    with pytest.raises(ADCError, match="unknown_outcome"):
        transport.exchange(request(), time.monotonic() + 0.03)
    assert transport.closed
    transport.prepare_cleanup()
    with pytest.raises(ADCError, match="mcp_transport_fenced"):
        transport.exchange(request(), time.monotonic() + 1)
    transport.command = [sys.executable, "-u", "-c", PEER, str(trace), "normal"]
    transport.prepare_cleanup()
    release = {**request(), "tool": "screen.control",
               "args": {"action": "end", "controlSessionId": "test-lease"},
               "idempotencyKey": "test-release-1"}
    try:
        assert unwrap(transport.exchange(release, time.monotonic() + 3))["status"] == "succeeded"
    finally:
        transport.close()
    messages = [json.loads(line) for line in trace.read_text().splitlines()]
    calls = [item["params"]["name"] for item in messages if item["method"] == "tools/call"]
    assert calls == ["ui.action", "screen.control"]


def test_mcp_expired_deadline_does_not_start_process(tmp_path):
    transport, trace = peer(tmp_path)
    with pytest.raises(ADCError, match="deadline_exceeded"):
        transport.exchange(request(), time.monotonic() - 1)
    assert transport.process is None
    assert not trace.exists()

def test_mcp_initialization_uses_its_own_budget(tmp_path, monkeypatch):
    transport, _ = peer(tmp_path)
    deadlines = []

    def rpc(method, _params, deadline):
        deadlines.append((method, deadline))
        return {}

    monkeypatch.setattr(transport, "_rpc", rpc)
    started = time.monotonic()
    try:
        transport._start(started + 600)  # noqa: SLF001 -- verify startup's deadline propagation
        assert deadlines[0][0] == "initialize"
        assert started < deadlines[0][1] <= started + 10.1
    finally:
        transport.close()


def test_mcp_discovery_and_call_use_bounded_remaining_budget(tmp_path, monkeypatch):
    transport, _ = peer(tmp_path)
    deadlines = []

    def rpc(method, _params, deadline):
        deadlines.append((method, deadline))
        if method == "tools/list":
            return {"tools": [{"name": "ui.action", "inputSchema": {}}]}
        return {}

    monkeypatch.setattr(transport, "_rpc", rpc)
    started = time.monotonic()
    try:
        transport.exchange(request(), started + 600)
        by_method = dict(deadlines)
        assert started < by_method["tools/list"] <= started + 10.1
        assert started < by_method["tools/call"] <= started + 15.1
        deadlines.clear()
        total_deadline = time.monotonic() + 0.5
        transport.exchange(request(), total_deadline)
        assert dict(deadlines)["tools/call"] <= total_deadline
    finally:
        transport.close()


def test_mcp_call_timeout_fences_without_replaying(tmp_path):
    transport, trace = peer(tmp_path, "timeout")
    transport._start(time.monotonic() + 3)  # noqa: SLF001 -- exclude peer startup from the timed action
    listed = transport._rpc("tools/list", {}, time.monotonic() + 3)  # noqa: SLF001
    transport.tools = {item["name"]: item for item in listed["tools"]}
    transport.MIN_CALL_TIMEOUT_S = 0.03
    transport.CALL_OVERHEAD_S = 0.02
    started = time.monotonic()
    with pytest.raises(ADCError, match="unknown_outcome"):
        transport.exchange({**request(), "waitMs": 0}, started + 1)
    assert time.monotonic() - started < 0.5
    assert transport.closed
    with pytest.raises(ADCError, match="mcp_transport_closed"):
        transport.exchange(request(), time.monotonic() + 3)
    calls = [json.loads(line) for line in trace.read_text().splitlines()]
    assert sum(item["method"] == "tools/call" for item in calls) == 1


def test_mcp_initialization_reads_only_safe_json_stderr(tmp_path):
    transport, _ = peer(tmp_path, "cli_error")
    with pytest.raises(ADCError, match="mcp_startup_timeout") as failure:
        transport.exchange(request(), time.monotonic() + 3)
    assert failure.value.result == {"cli_error_code": "execution_timeout"}
    assert "private" not in str(failure.value.result)
    assert transport.closed


def test_executor_reuses_exact_post_action_snapshot(tmp_path):
    class NoReadTransport:
        def invoke(self, *args, **kwargs):
            pytest.fail("A second ui.inspect would discard the returned snapshot")

    executor = Executor(NoReadTransport(), None, "node_test", tmp_path / "run")
    executor.pending_ui = {"snapshotId": "uisnap_after", "packageName": "com.android.settings",
                           "nodes": [{"nodeId": 2, "text": "Brightness", "enabled": True}]}
    observed, picture = executor.observe(time.monotonic() + 1, False)
    assert observed["snapshotId"] == "uisnap_after"
    assert observed["nodes"][0]["text"] == "Brightness"
    assert picture is None
    assert executor.pending_ui is None
    assert executor.events[-1]["type"] == "observation_reused"
