"""Ark SSE client. Credentials stay in memory and never enter execution records."""

import json
import os
import time
from pathlib import Path
from urllib.parse import urlsplit

import requests
import yaml


class ModelError(RuntimeError):
    pass


class ArkClient:
    def __init__(
        self,
        model="doubao-seed-2-0-mini-260428",
        tier="fast",
        config_path=None,
        credential_model=None,
        session=None,
        fast_retries=0,
        fallback_default=False,
    ):
        config = yaml.safe_load(Path(config_path).expanduser().read_text()) if config_path else {}
        if not isinstance(config, dict):
            raise ValueError("ark_config_invalid")
        entry = {}
        if config.get("models"):
            name = credential_model or config.get("default_model")
            entry = config["models"].get(name, {})
        self._key = os.environ.get("ARK_API_KEY") or config.get("api_key") or entry.get("api_key")
        self.endpoint = (os.environ.get("ARK_ENDPOINT") or config.get("endpoint")
                         or config.get("default_endpoint"))
        if not isinstance(self._key, str) or not self._key.strip():
            raise ValueError("ark_api_key_required")
        if not isinstance(self.endpoint, str):
            raise ValueError("ark_endpoint_required")
        endpoint = urlsplit(self.endpoint)
        if (endpoint.scheme != "https" or not endpoint.hostname or endpoint.username
                or endpoint.password or endpoint.query or endpoint.fragment):
            raise ValueError("ark_endpoint_invalid")
        self.model = model
        self.tier = tier
        if not 0 <= fast_retries <= 2:
            raise ValueError("fast_retries_must_be_0_to_2")
        self.fast_retries = fast_retries
        self.fallback_default = fallback_default
        self.session = session or requests.Session()
        self.fast_unavailable_until = 0
        self.fast_rejection_count = 0

    def complete(self, messages, deadline, max_tokens=384):
        """Retry only rejected ModelNotOpen fast inference; no device action is involved.

        The default remains strict. Explicit fallback is observable, never counted as fast.
        """
        attempts = []
        total_start = time.monotonic()
        circuit_open = (self.tier == "fast" and self.fallback_default and
                        time.monotonic() < self.fast_unavailable_until)
        tier = "default" if circuit_open else self.tier
        retries = 0
        while True:
            attempt_start = time.monotonic()
            try:
                text, metrics = self._complete(messages, deadline, max_tokens, tier)
            except ModelError as error:
                attempts.append({"requested_tier": tier, "status": "failed", "error": str(error),
                                 "elapsed_s": time.monotonic() - attempt_start})
                if str(error) != "ark_http_404:ModelNotOpen" or tier != "fast":
                    error.attempts = attempts
                    raise
                self.fast_rejection_count += 1
                if retries < self.fast_retries:
                    retries += 1
                    continue
                if self.fallback_default:
                    self.fast_unavailable_until = time.monotonic() + 30
                    tier = "default"
                    continue
                error.attempts = attempts
                raise
            else:
                attempts.append({"requested_tier": tier, "status": "succeeded",
                                 "elapsed_s": time.monotonic() - attempt_start})
                metrics.update({"attempts": attempts, "model_total_s": time.monotonic() - total_start,
                                "initial_requested_tier": self.tier,
                                "fast_circuit_open": circuit_open,
                                "fast_rejection_count": self.fast_rejection_count,
                                "fallback_used": tier != self.tier})
                return text, metrics

    def _complete(self, messages, deadline, max_tokens, tier):  # noqa: C901 -- SSE state machine
        start = time.monotonic()
        remaining = deadline - start
        if remaining <= 0:
            raise ModelError("deadline_exceeded")
        payload = {
            "model": self.model,
            "messages": messages,
            "thinking": {"type": "disabled"},
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "max_tokens": max_tokens,
            "stream": True,
            "stream_options": {"include_usage": True},
            "service_tier": tier,
        }
        content = []
        usage = {}
        actual_tier = None
        first = last = None
        chunks = 0
        finish = None
        response_model = None
        done = False
        try:
            with self.session.post(
                self.endpoint,
                headers={"Authorization": f"Bearer {self._key}"},
                json=payload,
                stream=True,
                timeout=(min(10, remaining), min(30, remaining)),
            ) as response:
                if not response.ok:
                    # Provider error bodies can contain request details; never log them.
                    try:
                        code = response.json().get("error", {}).get("code", "")
                    except ValueError:
                        code = ""
                    if not isinstance(code, str) or not code.replace("_", "").isalnum():
                        code = "unknown"
                    raise ModelError(f"ark_http_{response.status_code}:{code}")
                for line in response.iter_lines(chunk_size=1):
                    now = time.monotonic()
                    if now >= deadline:
                        raise ModelError("deadline_exceeded")
                    if not line or not line.startswith(b"data:"):
                        continue
                    raw = line[5:].strip()
                    if raw == b"[DONE]":
                        done = True
                        break
                    item = json.loads(raw)
                    if "error" in item:
                        raise ModelError("ark_stream_error")
                    actual_tier = item.get("service_tier") or actual_tier
                    response_model = item.get("model") or response_model
                    usage = item.get("usage") or usage
                    for choice in item.get("choices", []):
                        text = choice.get("delta", {}).get("content")
                        if text:
                            first = now if first is None else first
                            last = now
                            chunks += 1
                            content.append(text)
                        finish = choice.get("finish_reason") or finish
        except (requests.RequestException, ValueError):
            raise ModelError("ark_transport_or_stream_error") from None
        if not done or finish != "stop" or first is None:
            raise ModelError("ark_incomplete_output")
        elapsed = time.monotonic() - start
        output_tokens = usage.get("completion_tokens")
        decode = last - first
        metrics = {
            "model": response_model,
            "requested_model": self.model,
            "requested_tier": tier,
            "actual_tier": actual_tier,
            "ttft_s": first - start,
            "model_s": elapsed,
            "decode_s": decode,
            "content_chunks": chunks,
            "usage": usage,
            "tpot_estimate_s": decode / (output_tokens - 1) if output_tokens and output_tokens > 1 else None,
            "finish_reason": finish,
        }
        return "".join(content), metrics
