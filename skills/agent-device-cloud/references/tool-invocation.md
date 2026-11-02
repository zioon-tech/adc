# Tool Invocation

Load this reference before the first ADC tool call in a workflow.

## Discover The Live Contract

Always discover from the current Agent connection:

```bash
adc node list --json
adc tool list --json
adc tool show file.read --json
```

`adc node list` supplies the authorized devices, online state, exposed absolute paths and current
capabilities. `adc tool list` omits device tools that no authorized device currently advertises.

In `adc tool show` output:

- `inputSchema.properties.args` is the JSON passed to `--args`.
- `inputSchema.properties.target.properties.nodeId.enum` lists valid `--node` values.
- `inputSchema.required` shows whether a target and idempotency key are required.

Use the advertised schema for dynamic `mcp.*` tools. Never infer their arguments from the source
tool name. Dynamic MCP tools are side effects in protocol 0.1 and require an explicit node and
idempotency key.

## Built-In Tool Arguments

The live schema is authoritative. These examples show the protocol 0.1 shapes:

| Tool                    | `--args` JSON                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device.list`           | `{}`                                                                                                                                                                   |
| `device.status`         | `{"nodeId":"node_example"}`                                                                                                                                            |
| `device.battery.get`    | `{}`                                                                                                                                                                   |
| `device.info.get`       | `{}`                                                                                                                                                                   |
| `device.network.get`    | `{}`                                                                                                                                                                   |
| `device.storage.get`    | `{}`                                                                                                                                                                   |
| `device.vibrate`        | `{"durationMs":300,"amplitude":128}`                                                                                                                                   |
| `device.navigation`     | `{"action":"back"}`                                                                                                                                                    |
| `app.open`              | `{"packageName":"com.android.settings","waitForForegroundMs":5000}`                                                                                                    |
| `display.status`        | `{}`                                                                                                                                                                   |
| `audio.status`          | `{}`                                                                                                                                                                   |
| `audio.volume.set`      | `{"stream":"media","levelPercent":50}`                                                                                                                                 |
| `flashlight.status`     | `{}`                                                                                                                                                                   |
| `flashlight.set`        | `{"enabled":true}`                                                                                                                                                     |
| `location.get`          | `{"desiredAccuracy":"balanced","maxAgeMs":15000,"timeoutMs":10000}`                                                                                                    |
| `notification.show`     | `{"title":"ADC","body":"Task completed"}`                                                                                                                              |
| `screen.capture`        | `{"format":"png","maxWidth":1080}`                                                                                                                                     |
| `ui.inspect`            | `{"maxDepth":12,"maxNodes":500}`                                                                                                                                       |
| `ui.wait`               | `{"condition":"element","selector":{"text":"Save"},"state":"present","timeoutMs":10000}`                                                                               |
| `ui.action`             | `{"selector":{"text":"Save"},"action":"click"}`                                                                                                                        |
| `ui.gesture`            | `{"type":"swipe","startX":500,"startY":1500,"endX":500,"endY":500,"durationMs":300}`                                                                                   |
| `file.list`             | `{"path":"/absolute/folder","glob":"**/*.ts","maxEntries":1000}`                                                                                                       |
| `file.read`             | `{"path":"/absolute/file","encoding":"utf8","maxBytes":1048576}`                                                                                                       |
| `file.search`           | `{"path":"/absolute/folder","query":"needle","glob":"**/*.ts","maxMatches":1000}`                                                                                      |
| `file.write`            | `{"path":"/absolute/file","content":"...","createOnly":true}`                                                                                                          |
| `file.edit`             | `{"path":"/absolute/file","oldText":"exact text","newText":"replacement","replaceAll":false}`                                                                          |
| `file.patch`            | `{"path":"/absolute/file","patch":"unified diff"}`                                                                                                                     |
| `file.transfer`         | `{"source":{"nodeId":"node_source","rootId":"root_source","path":"model.bin"},"destination":{"nodeId":"node_target","rootId":"root_target","path":"cache/model.bin"}}` |
| `shell.exec`            | `{"cwd":"/absolute/folder","command":"pnpm test","timeoutMs":120000,"env":{}}`                                                                                         |
| `command.template.list` | `{}` or `{"projectId":"proj_example"}`                                                                                                                                 |
| `command.template.run`  | `{"cwd":"/absolute/folder","templateId":"build","parameters":{}}`                                                                                                      |
| `test.run`              | `{"cwd":"/absolute/folder","templateId":"test","timeoutMs":300000}`                                                                                                    |
| `task.status`           | `{"jobId":"job_example"}`                                                                                                                                              |
| `task.result`           | `{"jobId":"job_example"}`                                                                                                                                              |
| `task.wait`             | `{"jobId":"job_example","waitMs":4000}`                                                                                                                                |
| `task.cancel`           | `{"jobId":"job_example"}`                                                                                                                                              |

Optional fields may be omitted. Do not send undocumented fields because tool arguments are strict.
MCP calls accept `waitMs` (0–30000, default 4000) alongside `args` and `target`.
CLI calls use `--wait 4000`; SDK calls use `client.invoke(invocation, { waitMs: 4000 })`.
Waiting returns a terminal result or the current task state without cancelling or restarting it.
Continue with `task.wait`, `adc task wait JOB --wait 4000 --json`, or `client.taskWait(jobId)`.

`file.transfer` supports a two-device job or a local Agent upload to one device. For two devices, both devices and both roots must be present in the
current authorization; the source root may be read-only and the destination root must be writable.
Use `adc transfer create` for its dedicated CLI, then `adc transfer status|wait|cancel` with the
returned `transferId` or `jobId`. Protocol 0.1 transfers one regular file, never overwrites an
existing destination, and does not support directories. A retry of the same transfer intent must
reuse its original idempotency key.

Use `executionTimeoutMs` in MCP or `--execution-timeout` in CLI only when a total budget is needed.
It accepts 100–1800000 ms from submission, including queue time, and requests cooperative cancellation
on expiry. Waiting never extends this budget. Existing tool-specific `args.timeoutMs` still applies.
Existing grants must explicitly include `task.wait` to expose that tool.
Use `--args @/absolute/input.json` when shell quoting would make a large JSON value unsafe or
ambiguous, and remove temporary inputs that contain sensitive data.

## Platform-Aware Execution

Use `adc node list --json` and the `targets` returned by
`adc tool show shell.exec --json` before composing a shell command:

- `darwin` and `linux` targets execute Bash.
- `win32` targets execute Windows PowerShell.
- Do not send Bash pipelines, quoting or environment syntax to PowerShell, or PowerShell syntax to
  Bash.
- A failed process result includes `error.details.executor`, `exitCode`, `timedOut` and a normalized
  `stderrSummary`. Do not retry when `error.retryable` is false; correct the command or report the
  failure.

Prefer a configured command template whenever the same operation must work across platforms.

## Read Before Mutation

List or search before reading:

```bash
adc invoke file.list \
  --node node_example \
  --args '{"path":"/Users/example/work/project","maxEntries":200}' \
  --source skill \
  --json
```

Read the exact file before an edit. Use:

- `file.write` to create a file or replace its complete contents.
- `file.edit` only when `oldText` is known and uniquely identifies the intended text.
- `file.patch` for a reviewed unified diff.
- `command.template.run` or `test.run` for a configured command.
- `shell.exec` only when no narrower tool expresses the operation.

Discover templates before use:

```bash
adc invoke command.template.list \
  --node node_example \
  --args '{}' \
  --source skill \
  --json
```

## Idempotency

Every write, execution, cancellation and dynamic MCP call needs a key:

```bash
adc invoke file.edit \
  --node node_example \
  --args '{"path":"/Users/example/work/project/README.md","oldText":"old","newText":"new"}' \
  --idempotency-key workflow-42-edit-readme-1 \
  --source skill \
  --json
```

Keep the key in task state before invoking. A retry of identical intent, tool, node and arguments
uses the same key. Any changed argument or distinct side effect uses a new key. Never use one global
key for multiple operations.

## Invocation Lifecycle

For mobile UI and device-status calls, add `--wait 1500` to the initial `adc invoke` command. This
keeps one CLI process alive for the common sub-second completion path. A result that remains
`queued` or `running` still follows the workflow below.

For `queued` or `running`, save the `jobId` and poll:

```bash
adc task status JOB_ID --json
```

Poll after 200 milliseconds, then 500 milliseconds and one second. For work that is still running,
back off to at most every five seconds. Stop at the user-visible or tool timeout. If local waiting
stops, retain the `jobId`; do not submit the operation again.

For `approval_required`, save `invocationId`, `error.details.approvalId`, and
`error.details.expiresAt`. Ask the user to decide independently. After the user confirms:

```bash
adc invocation status INVOCATION_ID --json
```

- Another `approval_required` means the decision is still pending.
- `denied` with error code `denied` or `expired` is terminal.
- `queued` or `running` supplies the `jobId`; continue task polling.
- A terminal result can be reported directly.

Do not re-run the original invocation merely to discover the approval result.

## Results And Artifacts

Treat only `succeeded` as success. Report `failed`, `denied`, `offline`, `cancelled`, and
`unknown_outcome` distinctly. Preserve `error.code`, `error.message`, `invocationId`, `jobId`, and
`receipt.receiptId` in the final summary when present.

If `output.truncated` is true and `receipt.artifactRefs` contains an ID, download only when the
content is needed:

```bash
adc artifact get ARTIFACT_ID --output /user/approved/new/path.log --json
```

The output path is local to the Agent host and is overwritten by the CLI. Confirm that it is an
appropriate new or disposable path first.

`adc audit show INVOCATION_ID --json` requires an owner login. It is optional verification for a
user-authorized management session, not part of the normal scoped Agent workflow.
