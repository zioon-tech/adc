import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

from .agent_model import AgentDecisionModel
from .ark import ArkClient
from .executor import Executor, Goal
from .transport import BridgeTransport, CLITransport, MCPTransport, bridge_next, bridge_reply


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")


def build_transport(args):
    if args.usb:
        from .usb import USBTransport
        return USBTransport(args.usb)
    if args.bridge_dir:
        return BridgeTransport(args.bridge_dir)
    if args.transport == "cli":
        return CLITransport(args.adc_binary)
    return MCPTransport(args.adc_binary, shlex.split(args.adc_mcp_command)
                        if args.adc_mcp_command else None)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--goal", required=True)
    run.add_argument("--node")
    run.add_argument("--usb", metavar="SERIAL", help="Use the locally authorized USB phone")
    run.add_argument("--supervisor-model", help="Stronger Ark model used only on invalid or stalled steps")
    run.add_argument("--output", required=True)
    run.add_argument("--bridge-dir")
    run.add_argument("--transport", choices=["mcp", "cli"], default="mcp")
    run.add_argument("--adc-binary", default="adc")
    run.add_argument("--adc-mcp-command", help="Explicit public MCP argv, parsed without a shell")
    run.add_argument("--control-file")
    run.add_argument("--visual", action="store_true")
    run.add_argument("--adaptive-visual", action="store_true", help="Capture only for recovery supervision")
    run.add_argument("--plan-milestones", action="store_true", help="Ask supervisor for each milestone strategy")
    run.add_argument("--message-mode", choices=["single_text", "roles"], default="roles")
    run.add_argument("--fast-retries", type=int, choices=[0, 1, 2], default=0)
    run.add_argument("--fallback-default", action="store_true")
    run.add_argument("--detach", action="store_true", help="Start a local worker and return its PID")
    run.add_argument("--model", default="doubao-seed-2-0-mini-260428")
    run.add_argument("--tier", default="fast", choices=["fast", "default", "auto"])
    run.add_argument("--config")
    run.add_argument("--credential-model")
    run.add_argument("--agent-decisions", help="Host agent decision mailbox for matched baseline")
    probe = sub.add_parser("probe")
    probe.add_argument("--tier", default="fast")
    probe.add_argument("--model", default="doubao-seed-2-0-mini-260428")
    probe.add_argument("--prompt", default='仅返回JSON：{"ready":true}')
    probe.add_argument("--output")
    probe.add_argument("--config")
    probe.add_argument("--credential-model")
    nxt = sub.add_parser("bridge-next")
    nxt.add_argument("directory")
    nxt.add_argument("--wait", type=float, default=0)
    reply = sub.add_parser("bridge-reply")
    reply.add_argument("directory")
    reply.add_argument("identifier")
    reply.add_argument("base64")
    args = parser.parse_args()
    if args.command == "run" and (bool(args.usb) == bool(args.node) or (args.usb and args.bridge_dir)):
        parser.error("run requires exactly one of --usb or --node; USB does not use --bridge-dir")
    if args.command == "bridge-next":
        limit = time.monotonic() + min(args.wait, 10)
        value = bridge_next(args.directory)
        while value.get("waiting") and time.monotonic() < limit:
            time.sleep(0.02)
            value = bridge_next(args.directory)
        emit(value)
        return
    if args.command == "bridge-reply":
        bridge_reply(args.directory, args.identifier, args.base64)
        return
    if args.command == "probe":
        client = ArkClient(model=args.model, tier=args.tier, config_path=args.config,
                           credential_model=args.credential_model)
        text, metrics = client.complete([{"role": "user", "content": args.prompt}], time.monotonic() + 45)
        result = {"text": text, **metrics}
        if args.output:
            from .transport import atomic_json
            atomic_json(args.output, result)
        emit(result)
        return
    if args.detach:
        from .transport import atomic_json
        launch_path = Path(args.output + ".launch.json")
        log_path = Path(args.output + ".worker.log")
        if Path(args.output).exists() or launch_path.exists() or log_path.exists():
            raise ValueError("output_already_exists")
        argv = [sys.executable, "-m", "adc_gui_executor",
                *[value for value in sys.argv[1:] if value != "--detach"]]
        descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as log:
            worker = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log,  # noqa: S603 -- local worker argv
                                      start_new_session=True)
        metadata = {"pid": worker.pid, "output": args.output, "log": str(log_path)}
        atomic_json(launch_path, metadata)
        emit(metadata)
        return
    with Path(args.goal).open() as handle:
        goal = Goal(**json.load(handle))
    client = (AgentDecisionModel(args.agent_decisions) if args.agent_decisions else
              ArkClient(args.model, args.tier, args.config, args.credential_model,
                        fast_retries=args.fast_retries, fallback_default=args.fallback_default))
    transport = build_transport(args)
    supervisor = (ArkClient(args.supervisor_model, "default", args.config, args.credential_model)
                  if args.supervisor_model else None)
    try:
        result = Executor(transport, client, args.node or args.usb, args.output, args.control_file,
                          args.message_mode, supervisor).run(goal, args.visual, args.adaptive_visual,
                                                            args.plan_milestones)
    finally:
        if hasattr(transport, "close"):
            transport.close()
    emit({key: value for key, value in result.items() if key != "events"})


if __name__ == "__main__":
    main()
