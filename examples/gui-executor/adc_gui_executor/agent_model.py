"""Decision adapter for the host agent using the exact same actor and ADC bridge."""

import json
import time
import uuid
from pathlib import Path

from .ark import ModelError
from .transport import atomic_json


class AgentDecisionModel:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=False)

    def complete(self, messages, deadline):
        identifier = uuid.uuid4().hex
        started = time.monotonic()
        atomic_json(self.directory / "decision_request.json", {
            "id": identifier, "messages": messages, "deadline": deadline,
        })
        reply = self.directory / "decision_reply.json"
        while time.monotonic() < deadline:
            if reply.exists():
                value = json.loads(reply.read_text())
                reply.unlink()
                if value.get("id") != identifier:
                    raise ModelError("agent_decision_reply_mismatch")
                (self.directory / "decision_request.json").unlink(missing_ok=True)
                elapsed = time.monotonic() - started
                return json.dumps(value["decision"]), {
                    "model": "GPT-6-host-agent", "actual_tier": "host-agent",
                    "agent_decision_wait_s": elapsed,
                    "model_total_s": elapsed, "timing_kind": "host_agent_wait",
                }
            time.sleep(0.02)
        raise ModelError("agent_decision_deadline")
