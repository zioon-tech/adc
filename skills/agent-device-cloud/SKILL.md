---
name: agent-device-cloud
description: Set up and operate Agent Device Cloud through public CLIs. Use when asked to get started with ADC, connect devices, manage access, invoke device tools, or track tasks.
version: 0.4.2
requirements:
  cli: "adc >=0.1.0 <0.2.0"
  protocol: "0.1"
---

# Agent Device Cloud

Use only the public `adc` and documented `adc-node` commands. Never inspect stored credentials,
device identity files, Connector state, or private poll, lease, ACK, receipt, and wake endpoints.

For explicitly requested team, membership, invitation or named device sharing management, read
[collaboration.md](references/collaboration.md). Sharing does not create a virtual network.
Team/shared devices require a separate human-created Agent grant; accepting an invitation never
expands an existing grant. Discover the current execution mode before every shared-device workflow.
Isolated execution uses Bash in a temporary Linux container with no network and discards workspace
changes. Read command-log artifacts to retain bounded output. Never request account credentials
or use owner authority to bypass a revoked relationship.

## Choose The Authority

- For device tool work, use only the scoped Agent connection. Do not sign in as the owner merely to
  make a tool call succeed.
- Use account-management commands only when the user explicitly asks to pair devices, change
  access, inspect account audit, or manage connections.
- Approval must remain an independent user decision. Never run `adc approval approve` for an
  invocation initiated by this Agent.

Read [account-and-device-management.md](references/account-and-device-management.md) only for an
account-management or local Connector request.

## First Use And Setup

When asked to start using ADC, install its CLI, register, sign in, connect a first device or
authorize this Agent, read [getting-started.md](references/getting-started.md). Guide the user
through the missing steps and reuse existing devices and access.

Installing this Skill does not register an account or grant access. Registration, browser sign-in
and login-code confirmation belong to the user. Run authorized setup commands, then verify a
scoped connection and a read-only tool result before reporting that ADC is ready.

## Start Every Tool Workflow

1. Run `adc --version`, then `adc status --json`. Require `connection.authenticated: true`.
   If the CLI is missing or the connection is unauthenticated, explain the missing step and use
   [getting-started.md](references/getting-started.md) when setup is requested. Do not request a
   password or token, or switch to owner authority to bypass a tool denial.
2. Run `adc node list --json`. Use only an active, online device and an absolute POSIX path listed
   in that device's authorized roots. If several devices qualify and the user did not select one,
   show the candidates and ask. Record the selected device's `platform`.
3. Run `adc tool list --json`, then `adc tool show <tool-id> --json` before the first use of a tool
   in the workflow. Use its current `inputSchema` and target metadata; do not guess arguments or
   invoke an unavailable tool.
4. Re-run device and tool discovery after a reconnect, scope change, Connector update, or
   capability error.

Read [tool-invocation.md](references/tool-invocation.md) before invoking a device tool.

For a file held locally by this Agent, use `adc transfer upload --file <local-path>
--destination-node <node-id> --destination-root <root-id> --destination-path <relative-path>
--idempotency-key <key> --json`. No source Node is needed. File bytes go directly to private
object storage; never put binary/base64 payloads in invocation arguments. If approval is required,
wait for the user's decision, then repeat the exact upload command and key to continue the same
transfer. Do not upload until the task is approved. Use normal task waiting to verify completion.

## Execute Deliberately

1. Prefer `file.list` or `file.search`, then `file.read`, before changing a file.
2. Prefer `file.edit`, `file.patch`, or an approved command template over `shell.exec`.
3. For `shell.exec`, use Bash syntax only on `darwin`/`linux` targets and PowerShell syntax only on
   `win32` targets. Never send a command written for one dialect to another.
4. Pass `--node <node-id>` whenever more than one device is authorized or the user named a target.
   Absolute paths always bind to one device.
5. Add `--source skill` to every invocation.
6. Give every side effect a unique workflow-scoped `--idempotency-key` of at least eight
   characters. Persist it with the task. Reuse it only for the exact same tool, target, arguments,
   and user intent; changed input requires a new key.
7. Capture `invocationId`, `jobId`, status, error and receipt from JSON output. Never infer success
   from exit code alone.
8. For tools expected to finish quickly, pass `--wait 4000` so the CLI
   can return a terminal result without a second process. If it still returns `queued` or `running`,
   continue with the normal task state machine.

## Follow The State Machine

- `queued` or `running`: use `adc task wait <jobId> --wait 4000 --json` to continue waiting on
  the same task. Each call waits at most 30000 ms. Stop at the user or tool deadline.
  If an older server does not support waiting, use `adc task status` with bounded backoff.
  A local wait timeout is not a task failure and must not trigger a new invocation.
- `approval_required`: record `invocationId`, `approvalId` and expiry, then ask the user to review
  it. After the user confirms a decision, run
  `adc invocation status <invocationId> --json`; do not submit a replacement invocation.
- `succeeded`: validate the output and report its receipt ID when present.
- `failed`: report `error.code` and `error.message`. Retry only when `error.retryable` is true; keep
  the same idempotency key for the same side effect.
- `denied`: do not retry, switch devices, or broaden access. Explain the policy reason.
- `offline`: preserve the selected device. Ask the user to wake or reconnect it, rediscover, then
  retry the exact request; preserve the idempotency key for a side effect.
- `unknown_outcome`: never create a replacement invocation or new idempotency key. Report that the
  effect may have occurred and require reconciliation.
- `cancelled`: report cancellation without describing it as execution failure.

Exit codes 20 through 24 represent denied, approval required, offline, unknown outcome and
cancelled. Exit 1 can represent `failed` or an API error; inspect JSON stdout or JSON stderr.
Exit 2 is a local usage/configuration error and is not retryable without correcting the request.

## Hard Boundaries

- Treat only `--json` stdout and JSON stderr as structured output.
- Never copy credentials into prompts, command arguments, task inputs, or user-visible output. Let
  the CLI own its mode-0600 credential storage.
- Never invent account, Agent, grant, project, root or device identifiers.
- Do not access paths outside the advertised roots or use `..`, backslashes, duplicate separators
  or trailing slashes.
- Do not use remote `shell.exec` to change Connector configuration.
- Do not start persistent services or interactive terminal sessions through device tools. Local
  Connector startup is allowed for the requested device setup in the getting-started reference.
- Do not claim `restricted-process` is hard filesystem or network isolation. Full device trust uses
  the Connector user's OS authority.
- Download artifacts only to a user-approved path that does not already contain unrelated data.
