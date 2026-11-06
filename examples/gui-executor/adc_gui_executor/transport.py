"""Public ADC CLI and host-tool bridge; neither reads ADC credential stores."""

import base64
import json
import os
import select
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path


class ADCError(RuntimeError):
    def __init__(self, status, result=None):
        super().__init__(status)
        self.status = status
        self.result = result or {}


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle, ensure_ascii=False)
    temporary.replace(path)


def unwrap(result):
    # MCP result content is an envelope, not the ADC receipt itself.
    if isinstance(result, list):
        return unwrap({"content": result})
    if not isinstance(result, dict):
        raise ADCError("invalid_receipt")
    if "content" in result:
        for entry in result["content"]:
            if entry.get("type") == "text":
                try:
                    value = json.loads(entry["text"])
                except (ValueError, KeyError):
                    continue
                if isinstance(value, dict) and ("status" in value or "result" in value):
                    return unwrap(value)
    if "result" in result and isinstance(result["result"], dict):
        return unwrap(result["result"])
    if isinstance(result.get("output", {}).get("task"), dict):
        return unwrap(result["output"]["task"])
    return result


class Transport:
    GUI_TOOLS = frozenset({"screen.control", "ui.inspect", "ui.action", "ui.gesture", "ui.wait",
                          "app.open", "device.navigation", "screen.capture"})
    GUI_TIMEOUT_S = 30

    def invoke(self, tool, args, node, deadline, token=None, key=None):
        if time.monotonic() >= deadline:
            raise ADCError("deadline_exceeded")
        if tool in self.GUI_TOOLS:
            deadline = min(deadline, time.monotonic() + self.GUI_TIMEOUT_S)
        request = {
            "tool": tool,
            "args": args,
            "target": {"nodeId": node},
            "waitMs": min(4000, max(0, int((deadline - time.monotonic()) * 1000))),
            "executionTimeoutMs": min(1800000, max(100, int((deadline - time.monotonic()) * 1000))),
            "intent": "Perform the requested screen task",
        }
        if token:
            request["controlSessionId"] = token
        if key:
            request["idempotencyKey"] = key
        result = unwrap(self.exchange(request, deadline))
        while result.get("status") in {"queued", "running"}:
            job = result.get("jobId")
            if not job:
                raise ADCError("missing_job_id", result)
            if time.monotonic() >= deadline:
                raise ADCError("unknown_outcome", result)
            request = {
                "tool": "task.wait",
                "args": {"jobId": job, "waitMs": min(4000, max(0, int((deadline - time.monotonic()) * 1000)))},
                "waitMs": 4000,
            }
            result = self._wait_result(request, deadline, result)
        if result.get("status") != "succeeded":
            raise ADCError(result.get("status", "invalid_receipt"), result)
        return result

    def _wait_result(self, request, deadline, pending):
        try:
            return unwrap(self.exchange(request, deadline))
        except ADCError as error:
            if error.status == "unknown_outcome":
                identity = {name: pending[name] for name in ("jobId", "invocationId") if name in pending}
                raise ADCError(error.status, {**identity, **error.result}) from None
            raise


class CLITransport(Transport):
    def __init__(self, binary="adc"):
        self.binary = binary

    def exchange(self, request, deadline):
        command = [self.binary, "invoke", request["tool"], "--args", json.dumps(request["args"]),
                   "--source", "skill", "--json", "--wait", str(request["waitMs"])]
        if "target" in request:
            command += ["--node", request["target"]["nodeId"]]
        for name, flag in (("controlSessionId", "--control-session"),
                           ("idempotencyKey", "--idempotency-key"),
                           ("executionTimeoutMs", "--execution-timeout"), ("intent", "--intent")):
            if name in request:
                command += [flag, str(request[name])]
        try:
            result = subprocess.run(command, capture_output=True, text=True,  # noqa: S603 -- argv only, no shell
                                    timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise ADCError("unknown_outcome") from None
        for output in (result.stdout, result.stderr):
            try:
                value = json.loads(output)
            except ValueError:
                continue
            if request["tool"] == "screen.capture":
                value = self.attach_screenshot(value, deadline)
            return value
        raise ADCError("invalid_cli_response")

    def attach_screenshot(self, result, deadline):
        terminal = unwrap(result)
        output = terminal.get("output", {})
        artifact = output.get("artifactId")
        if terminal.get("status") != "succeeded" or not artifact:
            return result
        with tempfile.TemporaryDirectory(prefix="adc-gui-capture-") as directory:
            destination = Path(directory) / "screen.png"
            command = [self.binary, "artifact", "get", artifact, "--output", str(destination), "--json"]
            try:
                downloaded = subprocess.run(command, capture_output=True, text=True,  # noqa: S603 -- public CLI argv
                                            timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                raise ADCError("screenshot_download_timeout") from None
            if downloaded.returncode != 0 or not destination.exists():
                raise ADCError("screenshot_artifact_unavailable")
            if destination.stat().st_size > 10 * 1024 * 1024:
                raise ADCError("screenshot_too_large")
            raw = destination.read_bytes()
            if not raw.startswith(b"\x89PNG"):
                raise ADCError("screenshot_format_not_png")
            output["dataUrl"] = "data:image/png;base64," + base64.b64encode(raw).decode()
        return terminal


class MCPTransport(CLITransport):
    """One persistent public ``adc mcp`` process, with no mutation replay.

    The CLI owns authorization. A broken stream is fenced permanently; a late
    response cannot be mistaken for a new action. Only one request is in flight.
    """

    MAX_FRAME_BYTES = 16 * 1024 * 1024
    STARTUP_TIMEOUT_S = 10
    MIN_CALL_TIMEOUT_S = 15
    CALL_OVERHEAD_S = 10
    SAFE_CLI_CODES = frozenset({"unauthenticated", "forbidden", "denied", "execution_timeout",
                               "network_timeout", "internal", "invalid_request"})

    def __init__(self, binary="adc", command=None):
        super().__init__(binary)
        self.command = command or [binary, "mcp"]
        self.process = None
        self.buffer = bytearray()
        self.stderr_buffer = bytearray()
        self.cli_error_code = None
        self.lock = threading.Lock()
        self.identifier = 0
        self.tools = {}
        self.closed = False
        self.cleanup_only = False

    @property
    def supports_local_sequences(self):
        """Local actor composition is available only after live public discovery."""
        return (not self.closed and not self.cleanup_only
                and {"ui.action", "ui.inspect"} <= self.tools.keys())

    def close(self):
        self.closed = True
        process, self.process = self.process, None
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=1)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream:
                stream.close()

    def _send(self, message, deadline):
        data = json.dumps(message, ensure_ascii=False).encode() + b"\n"
        offset = 0
        while offset < len(data):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ADCError("unknown_outcome")
            if not select.select([], [self.process.stdin], [], remaining)[1]:
                raise ADCError("unknown_outcome")
            try:
                offset += os.write(self.process.stdin.fileno(), data[offset:])
            except (BrokenPipeError, OSError):
                raise ADCError("unknown_outcome") from None

    def _drain_stderr(self):
        data = os.read(self.process.stderr.fileno(), 65536)
        if not data:
            self.process.stderr.close()
            return
        self.stderr_buffer.extend(data)
        while b"\n" in self.stderr_buffer:
            line, _, rest = self.stderr_buffer.partition(b"\n")
            self.stderr_buffer = bytearray(rest)
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict) and isinstance(value.get("error"), dict):
                code = value["error"].get("code")
                if isinstance(code, str) and code in self.SAFE_CLI_CODES:
                    self.cli_error_code = code
        # Never retain or surface arbitrary stderr, URLs or credentials.
        if len(self.stderr_buffer) > 65536:
            self.stderr_buffer.clear()

    def _receive(self, deadline):
        while True:
            remaining = deadline - time.monotonic()
            streams = [self.process.stdout]
            if self.process.stderr and not self.process.stderr.closed:
                streams.append(self.process.stderr)
            if remaining <= 0:
                raise ADCError("unknown_outcome", self._diagnostic())
            ready = select.select(streams, [], [], remaining)[0]
            if not ready:
                raise ADCError("unknown_outcome", self._diagnostic())
            if self.process.stderr in ready:
                self._drain_stderr()
            if self.process.stdout not in ready:
                continue
            data = os.read(self.process.stdout.fileno(), 65536)
            if not data:
                raise ADCError("unknown_outcome", self._diagnostic())
            return data

    def _read(self, deadline):
        while True:
            if b"\n" in self.buffer:
                line, _, rest = self.buffer.partition(b"\n")
                if len(line) > self.MAX_FRAME_BYTES:
                    raise ADCError("mcp_response_too_large")
                self.buffer = bytearray(rest)
                try:
                    value = json.loads(line)
                except ValueError:
                    raise ADCError("invalid_mcp_response") from None
                if not isinstance(value, dict):
                    raise ADCError("invalid_mcp_response")
                return value
            if len(self.buffer) > self.MAX_FRAME_BYTES:
                raise ADCError("mcp_response_too_large")
            self.buffer.extend(self._receive(deadline))

    def _diagnostic(self):
        return {"cli_error_code": self.cli_error_code} if self.cli_error_code else {}

    def _rpc(self, method, params, deadline):
        self.identifier += 1
        identifier = self.identifier
        self._send({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params}, deadline)
        while True:
            reply = self._read(deadline)
            if "id" not in reply:  # Server notifications are not invocation responses.
                if reply.get("method") == "notifications/tools/list_changed":
                    self.tools = {}
                continue
            if reply.get("id") != identifier:
                raise ADCError("mcp_reply_mismatch")
            if "error" in reply:
                # Do not expose arbitrary server messages or classify as retryable.
                raise ADCError("mcp_protocol_error", {"rpc_code": reply["error"].get("code")})
            if not isinstance(reply.get("result"), dict):
                raise ADCError("invalid_mcp_response")
            return reply["result"]

    def _start(self, deadline):
        if self.closed:
            raise ADCError("mcp_transport_closed")
        if self.process is not None:
            return
        deadline = min(deadline, time.monotonic() + self.STARTUP_TIMEOUT_S)
        self.process = subprocess.Popen(  # noqa: S603 -- public CLI argv, never a shell
            self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, bufsize=0,
        )
        os.set_blocking(self.process.stdin.fileno(), False)
        self._rpc("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "adc-gui-executor", "version": "0.1.0"},
        }, deadline)
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"}, deadline)

    def exchange(self, request, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not self.lock.acquire(timeout=remaining):
            raise ADCError("deadline_exceeded")
        try:
            if self.cleanup_only and not (
                request["tool"] == "screen.control" and request["args"].get("action") == "end"
            ):
                raise ADCError("mcp_transport_fenced")  # noqa: TRY301 -- closes and fences the channel
            phase = "startup"
            self._start(deadline)
            phase = "discovery"
            if not self.tools:
                listed = self._rpc("tools/list", {}, min(
                    deadline, time.monotonic() + self.STARTUP_TIMEOUT_S,
                ))
                self.tools = {tool["name"]: tool for tool in listed.get("tools", [])}
            tool = request["tool"]
            if tool not in self.tools:
                raise ADCError("tool_unavailable")  # noqa: TRY301 -- closes stale discovery state
            arguments = {key: value for key, value in request.items() if key != "tool"}
            # Opt in only when the currently advertised public schema permits it.
            properties = (self.tools[tool].get("inputSchema", {}).get("properties", {})
                          .get("args", {}).get("properties", {}))
            if "includeObservation" in properties:
                arguments["args"] = {**arguments["args"], "includeObservation": True}
            phase = "invocation"
            wait_s = max(request.get("waitMs", 0), request["args"].get("waitMs", 0)) / 1000
            call_deadline = min(deadline, time.monotonic() + max(
                self.MIN_CALL_TIMEOUT_S, wait_s + self.CALL_OVERHEAD_S,
            ))
            result = self._rpc("tools/call", {"name": tool, "arguments": arguments}, call_deadline)
            if request["tool"] == "screen.capture":
                result = self.attach_screenshot(result, deadline)
            return result  # noqa: TRY300 -- the finally releases the actor lock
        except (ADCError, OSError) as error:
            self.close()
            if isinstance(error, ADCError) and error.status == "unknown_outcome" and phase != "invocation":
                raise ADCError(f"mcp_{phase}_timeout", error.result) from None
            raise
        finally:
            self.lock.release()

    def prepare_cleanup(self):
        """Reconnect only for the independent control-release operation."""
        if self.closed:
            self.cleanup_only = True
            self.closed = False
            self.buffer.clear()
            self.stderr_buffer.clear()
            self.cli_error_code = None
            self.tools.clear()


class BridgeTransport(Transport):
    """A host with authorized MCP tools services request.json, then writes response.json.

    Only one outstanding request per directory. Late replies never become a new action.
    """

    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=False)

    def exchange(self, request, deadline):
        (self.directory / "expired.json").unlink(missing_ok=True)
        identifier = uuid.uuid4().hex
        atomic_json(self.directory / "request.json", {"id": identifier, **request})
        reply = self.directory / "response.json"
        while time.monotonic() < deadline:
            if reply.exists():
                value = json.loads(reply.read_text())
                reply.unlink()
                if value.get("id") != identifier:
                    raise ADCError("bridge_reply_mismatch")
                (self.directory / "request.json").unlink(missing_ok=True)
                return value["result"]
            time.sleep(0.02)
        atomic_json(self.directory / "expired.json", {"id": identifier})
        raise ADCError("unknown_outcome")


def bridge_next(directory):
    path = Path(directory)
    if (path / "expired.json").exists():
        return {"expired": True}
    request = path / "request.json"
    return json.loads(request.read_text()) if request.exists() else {"waiting": True}


def bridge_reply(directory, identifier, encoded):
    path = Path(directory)
    request = bridge_next(directory)
    if request.get("id") != identifier or request.get("expired"):
        raise ADCError("bridge_reply_mismatch")
    atomic_json(path / "response.json", {
        "id": identifier, "result": json.loads(base64.b64decode(encoded)),
    })
