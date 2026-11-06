"""Local, single-owner Android actor using USB ADB and UIAutomator2.

This is a separate local transport, not an ADC grant or an ADC receipt. The
UIAutomator2 jar is bootstrapped by its public Python package. RPC is sent once
over its local ADB forward so a lost click response cannot cause a replay.
"""

import base64
import fcntl
import hashlib
import io
import json
import re
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

import requests

from .transport import ADCError


def parse_hierarchy(xml):
    root = ET.fromstring(xml)  # noqa: S314 -- locally generated UIAutomator XML
    nodes = []
    flags = ("clickable", "scrollable", "enabled", "checked", "selected", "password")
    package = None
    width = height = 0
    for element in root.iter("node"):
        attr = element.attrib
        if attr.get("visible-to-user", "true") != "true":
            continue
        values = [int(value) for value in re.findall(r"\d+", attr.get("bounds", ""))]
        if len(values) != 4:
            continue
        left, top, right, bottom = values
        if right <= left or bottom <= top:
            continue
        package = package or attr.get("package")
        width, height = max(width, right), max(height, bottom)
        node = {
            "nodeId": len(nodes), "text": attr.get("text", ""),
            "contentDescription": attr.get("content-desc", ""),
            "resourceId": attr.get("resource-id", ""),
            "className": attr.get("class", ""), "packageName": attr.get("package"),
            "editable": attr.get("class", "").endswith("EditText"),
            "bounds": {"left": left, "top": top, "right": right, "bottom": bottom},
            **{flag: attr.get(flag) == "true" for flag in flags},
        }
        if node["password"]:
            node["text"] = node["contentDescription"] = ""
        nodes.append(node)
    if not nodes:
        raise ADCError("empty_usb_hierarchy")
    # Positional IDs alias a different button after navigation/history insertion.
    # Stable semantic IDs make stale references either the same target or absent.
    occurrences = {}
    for node in nodes:
        identity = {key: node[key] for key in ("packageName", "resourceId", "className",
                                              "text", "contentDescription", "editable")}
        if node["editable"]:
            identity["text"] = ""
        digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:12]
        occurrence = occurrences.get(digest, 0)
        occurrences[digest] = occurrence + 1
        node["nodeId"] = f"n_{digest}_{occurrence}"
    # Nodes from the active root exclude system status and input-method windows.
    fingerprint = hashlib.sha256(json.dumps(nodes, sort_keys=True).encode()).hexdigest()
    return {"nodes": nodes, "snapshotId": fingerprint, "packageName": package,
            "display": {"width": width, "height": height}, "truncated": False}


def target_identity(node):
    return {key: node.get(key) for key in (
        "text", "contentDescription", "resourceId", "className", "packageName",
        "editable", "enabled", "bounds",
    )}


def nearby_target(expected, candidate, display):
    """Reacquire the same unique semantic target after a small layout settling shift."""
    if any(expected.get(key) != candidate.get(key) for key in expected if key != "bounds"):
        return False
    before, after = expected["bounds"], candidate["bounds"]
    movement = max(abs(before[key] - after[key]) for key in before)
    tolerance = max(2, min(display["width"], display["height"]) * .006)
    if movement > tolerance:
        return False
    intersection = max(0, min(before["right"], after["right"]) - max(before["left"], after["left"])) * \
        max(0, min(before["bottom"], after["bottom"]) - max(before["top"], after["top"]))
    areas = [(box["right"] - box["left"]) * (box["bottom"] - box["top"]) for box in (before, after)]
    return intersection / (sum(areas) - intersection) >= .85


class USBTransport:
    name = "usb"
    supports_sequences = True

    def __init__(self, serial, device=None, session=None, lock_directory=None):
        self.serial = serial
        self.device = device
        self.session = session or requests.Session()
        self.session.trust_env = False
        directory = Path(lock_directory or tempfile.gettempdir())
        key = hashlib.sha256(serial.encode()).hexdigest()[:20]
        self.lock_path = directory / f"gui-usb-{key}.lock"
        self.lock = None
        self.token = None
        self.lease_until = 0
        self.snapshot = None
        self.port = None
        self.components = {}
        self.metrics = []
        self.used_keys = set()
        self.mutation_guard = None
        self.node_aliases = {}

    @staticmethod
    def budget(deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ADCError("deadline_exceeded")
        return remaining

    def rpc(self, method, params, deadline, mutation=False):
        if mutation and self.mutation_guard:
            self.mutation_guard()
        remaining = self.budget(deadline)
        start = time.monotonic()
        try:
            response = self.session.post(
                f"http://127.0.0.1:{self.port}/jsonrpc/0",
                json={"jsonrpc": "2.0", "id": uuid.uuid4().hex, "method": method, "params": params},
                timeout=(min(1, remaining), min(4, remaining)), allow_redirects=False,
            )
            response.raise_for_status()
            data = response.json()
        except (requests.RequestException, ValueError):
            raise ADCError("unknown_outcome" if mutation else "usb_read_failed") from None
        finally:
            self.metrics.append({"operation": method, "host_roundtrip_s": time.monotonic() - start})
        if not isinstance(data, dict) or "result" not in data or "error" in data:
            # No raw RPC errors: they may include stack traces or screen contents.
            raise ADCError("unknown_outcome" if mutation else "usb_rpc_failed")
        return data["result"]

    def inspect(self, deadline):
        # Android may expose an empty root while an activity is changing. These
        # are bounded read-only samples, never replay of the preceding action.
        for attempt in range(4):
            xml = self.rpc("dumpWindowHierarchy", [False, 25, True], deadline)
            try:
                output = parse_hierarchy(xml)
            except (ET.ParseError, TypeError):
                raise ADCError("invalid_usb_hierarchy") from None
            except ADCError as error:
                if error.status != "empty_usb_hierarchy" or attempt == 3:
                    raise
                if self.metrics:
                    self.metrics[-1]["empty_hierarchy"] = True
                continue
            # Short actor-scoped references are easier for models to copy. Allocate
            # once per semantic identity; never reuse a number for another target.
            for node in output["nodes"]:
                identity = {key: node[key] for key in (
                    "packageName", "resourceId", "className", "text",
                    "contentDescription", "editable",
                )}
                if node["editable"]:
                    identity["text"] = ""
                identity["occurrence"] = node["nodeId"].rsplit("_", 1)[1]
                key = json.dumps(identity, sort_keys=True)
                if key not in self.node_aliases:
                    if len(self.node_aliases) >= 10000:
                        raise ADCError("usb_node_reference_capacity_exceeded")
                    self.node_aliases[key] = len(self.node_aliases) + 1
                node["nodeId"] = self.node_aliases[key]
            output["snapshotId"] = hashlib.sha256(
                json.dumps(output["nodes"], sort_keys=True).encode()).hexdigest()
            self.snapshot = output
            return output
        raise ADCError("empty_usb_hierarchy")

    def shell(self, argv, deadline, mutation=False):
        if mutation and self.mutation_guard:
            self.mutation_guard()
        start = time.monotonic()
        try:
            return self.device.adb_device.shell(argv, timeout=min(4, self.budget(deadline)))
        except Exception:  # noqa: BLE001 -- sanitize third-party ADB errors at the transport boundary
            raise ADCError("unknown_outcome" if mutation else "usb_read_failed") from None
        finally:
            self.metrics.append({"operation": argv[0], "host_roundtrip_s": time.monotonic() - start})

    def control(self, args, deadline):
        action = args["action"]
        if action == "begin":
            if self.lock:
                raise ADCError("usb_already_owned")
            self.lock = self.lock_path.open("a")
            try:
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                self.lock.close()
                self.lock = None
                raise ADCError("usb_already_owned") from None
            try:
                if self.device is None:
                    import uiautomator2
                    self.device = uiautomator2.connect(self.serial)
                self.budget(deadline)
                self.port = self.device.adb_device.forward_port(9008)
                self.token = uuid.uuid4().hex
            except Exception:  # noqa: BLE001 -- release ownership on every bootstrap failure
                self.release()
                raise ADCError("usb_initialization_failed") from None
        elif args.get("controlSessionId") != self.token or not self.token:
            raise ADCError("usb_control_not_owned")
        if action == "end":
            self.release()
            return {"released": True}
        if action not in {"begin", "renew"}:
            raise ADCError("invalid_control_action")
        self.lease_until = time.monotonic() + min(args.get("leaseMs", 180000) / 1000, 180)
        return {"controlSessionId": self.token, "localAuthority": True}

    def release(self):
        self.token = None
        if self.lock:
            fcntl.flock(self.lock, fcntl.LOCK_UN)
            self.lock.close()
            self.lock = None

    def guard(self, token):
        if token != self.token or not self.token or time.monotonic() >= self.lease_until:
            raise ADCError("usb_control_not_owned")

    def resolve(self, selector, deadline):
        previous = self.snapshot
        if not previous or selector.get("snapshotId") != previous["snapshotId"]:
            raise ADCError("failed", {"error": {"code": "conflict"}})
        matches = [node for node in previous["nodes"] if all(
            node.get(key) == value for key, value in selector.items() if key != "snapshotId")]
        if len(matches) != 1 or matches[0]["password"] or not matches[0]["enabled"]:
            raise ADCError("failed", {"error": {"code": "conflict"}})
        expected = target_identity(matches[0])
        fresh = self.inspect(deadline)
        matches = [node for node in fresh["nodes"] if nearby_target(expected, node, fresh["display"])]
        if fresh["packageName"] != previous["packageName"] or len(matches) != 1:
            raise ADCError("failed", {"error": {"code": "conflict"}})
        if matches[0]["bounds"] != expected["bounds"] and self.metrics:
            self.metrics[-1]["target_reacquired"] = True
        return matches[0]

    def action(self, args, deadline):
        node = self.resolve(args["selector"], deadline)
        bounds = node["bounds"]
        x = (bounds["left"] + bounds["right"]) // 2
        y = (bounds["top"] + bounds["bottom"]) // 2
        kind = args["action"]
        if kind == "click":
            self.rpc("click", [x, y], deadline, mutation=True)
        elif kind == "set_text":
            if not node["editable"]:
                raise ADCError("target_not_editable")
            self.rpc("setText", [self.object_selector(node), args["text"]], deadline, mutation=True)
        elif kind in {"scroll_forward", "scroll_backward"}:
            if not node["scrollable"]:
                raise ADCError("target_not_scrollable")
            # Native input honors milliseconds; UIAutomator steps took ~20 ms on the
            # test phone rather than its documented ~5 ms. Short, overlapping moves
            # avoid skipping a target between the top and bottom of the same list.
            upper = round(bounds["top"] + (bounds["bottom"] - bounds["top"]) * 0.40)
            lower = round(bounds["top"] + (bounds["bottom"] - bounds["top"]) * 0.65)
            start, end = (lower, upper) if kind == "scroll_forward" else (upper, lower)
            self.shell(["input", "touchscreen", "swipe", str(x), str(start), str(x), str(end), "650"],
                       deadline, mutation=True)
        else:
            raise ADCError("unsupported_usb_action")
        return {"dispatched": True}

    def object_selector(self, node):
        from uiautomator2 import Selector
        values = {"packageName": node["packageName"], "className": node["className"],
                  "resourceId": node["resourceId"], "enabled": True}
        peers = [item for item in self.snapshot["nodes"] if all(
            item.get(key) == value for key, value in values.items())]
        values["instance"] = next(index for index, item in enumerate(peers)
                                  if item["nodeId"] == node["nodeId"])
        return dict(Selector(**values))

    def after_action(self, before, deadline, no_effect=False):
        """Require two matching samples after a change; ignore transitional frames."""
        output = self.inspect(deadline)
        sampling_start = time.monotonic()
        polls = 1
        changed = not before or output["snapshotId"] != before["snapshotId"]
        limit = min(deadline, sampling_start + (2.5 if changed else 1.2))
        stable = False
        if no_effect:
            return output
        while time.monotonic() < limit:
            previous = output
            output = self.inspect(deadline)
            polls += 1
            changed = changed or not before or output["snapshotId"] != before["snapshotId"]
            if changed:
                limit = min(deadline, sampling_start + 2.5)
            stable = output["snapshotId"] == previous["snapshotId"]
            if changed and stable:
                break
        output["readiness"] = {"polls": polls, "changed": changed, "stable": stable}
        return output

    def sequence(self, selectors, deadline):
        initial = self.snapshot
        if not initial or not 1 <= len(selectors) <= 8:
            raise ADCError("invalid_sequence")
        targets = []
        for selector in selectors:
            matches = [node for node in initial["nodes"] if all(
                node.get(key) == value for key, value in selector.items() if key != "snapshotId")]
            if (selector.get("snapshotId") != initial["snapshotId"] or len(matches) != 1 or
                    not matches[0]["enabled"] or matches[0]["password"] or not matches[0]["clickable"]):
                raise ADCError("failed", {"error": {"code": "conflict"}})
            targets.append(target_identity(matches[0]))
        completed = 0
        for expected in targets:
            fresh = self.inspect(deadline)
            matches = [node for node in fresh["nodes"] if nearby_target(expected, node, fresh["display"])]
            if fresh["packageName"] != initial["packageName"] or len(matches) != 1:
                # A prefix may already have executed. Do not replay the entire sequence.
                raise ADCError("sequence_interrupted", {"completed": completed})
            bounds = matches[0]["bounds"]
            self.rpc("click", [(bounds["left"] + bounds["right"]) // 2,
                              (bounds["top"] + bounds["bottom"]) // 2], deadline, mutation=True)
            completed += 1
        return {"primitive_count": completed, "dispatched": True}

    def invoke(self, tool, args, node, deadline, token=None, key=None):
        self.metrics = []
        try:
            return self._invoke(tool, args, node, deadline, token, key)
        except ADCError as error:
            error.result["transport"] = "usb"
            error.result["local_timings"] = self.metrics
            raise

    def _invoke(self, tool, args, node, deadline, token=None, key=None):  # noqa: C901
        self.budget(deadline)
        before = self.snapshot
        mutation = tool not in {"ui.inspect", "display.status", "screen.capture", "screen.control"}
        if mutation:
            self.guard(token)
            if not key or key in self.used_keys:
                raise ADCError("usb_duplicate_or_missing_action_key")
            self.used_keys.add(key)
        if tool == "screen.control":
            output = self.control(args, deadline)
        elif tool == "ui.inspect":
            output = self.inspect(deadline)
        elif tool == "display.status":
            output = (self.snapshot or self.inspect(deadline))["display"]
        elif tool == "ui.action":
            output = self.action(args, deadline)
        elif tool == "ui.sequence":
            output = self.sequence(args["selectors"], deadline)
        elif tool == "device.navigation":
            self.rpc("pressKey", [args["action"]], deadline, mutation=True)
            output = {"dispatched": True}
        elif tool == "app.open":
            package = args["packageName"]
            if not re.fullmatch(r"[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+", package):
                raise ADCError("invalid_package")
            component = self.components.get(package)
            if not component:
                value = self.shell(["cmd", "package", "resolve-activity", "--brief", package], deadline)
                component = next((line.strip() for line in value.splitlines()
                                  if line.strip().startswith(package + "/")), None)
                if not component:
                    raise ADCError("app_not_launchable")
                self.components[package] = component
            self.shell(["am", "start", "-n", component], deadline, mutation=True)
            output = {"dispatched": True}
        elif tool == "ui.gesture":
            if args["type"] == "tap":
                params = [args["x"], args["y"]]
                method = "click"
            else:
                params = [args[key] for key in ("startX", "startY", "endX", "endY")] + [60]
                method = "swipe"
            self.rpc(method, params, deadline, mutation=True)
            output = {"dispatched": True}
        elif tool == "screen.capture":
            from PIL import Image
            capture_start = time.monotonic()
            try:
                raw = self.device.adb_device.shell(["screencap", "-p"], encoding=None,
                                                  timeout=min(4, self.budget(deadline)), rstrip=False)
                image = Image.open(io.BytesIO(raw))
                image.thumbnail((args.get("maxWidth", 720), 1800))
                buffer = io.BytesIO()
                image.convert("RGB").save(buffer, format="JPEG", quality=75)
                output = {"dataUrl": "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()}
            except Exception:  # noqa: BLE001 -- sanitize external ADB/image parsing errors
                raise ADCError("usb_screenshot_failed") from None
            finally:
                self.metrics.append({"operation": "screenshot",
                                     "host_roundtrip_s": time.monotonic() - capture_start})
        else:
            raise ADCError("unsupported_usb_tool")
        if mutation:
            output["observation"] = self.after_action(before, deadline, output.get("noEffect", False))
        return {"status": "succeeded", "output": output, "transport": "usb",
                "local_timings": self.metrics}
