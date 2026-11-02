# Task waiting and execution budgets

All device tools, including desktop shell tools, Android tools and custom MCP providers, use the
same durable dispatch records. MCP waits up to 4000 ms by default and returns the terminal result
when available. Otherwise it returns `queued` or `running` with the existing job ID.

Use MCP's outer `waitMs`, CLI's `--wait [milliseconds]`, or SDK's
`client.invoke(invocation, { waitMs, signal })` to select 0–30000 ms. Zero returns immediately.
SDK and HTTP invocation defaults remain immediate; CLI `--wait` without a value selects 4000 ms.
HTTP accepts `POST /api/v1/invocations?waitMs=4000`.

Continue waiting through the authorized `task.wait` tool, `adc task wait JOB --wait 4000`,
`client.taskWait(jobId, waitMs, signal)`, or `GET /api/v1/tasks/JOB?waitMs=4000`.
`GET /api/v1/invocations/ID?waitMs=4000` also supports waiting.
Existing grants are not expanded automatically. Same-call invocation waiting uses the original
tool authorization; separate task reads require task read permission and the same account/grant.
Authorization is rechecked on each durable read, including after completion.

The control plane subscribes before reading task state to avoid losing a completion notification.
Committed receipts and cancellations wake local waiters immediately. A database read at most every
second detects changes made on other replicas; notifications carry no authoritative result.
Wait expiry returns the latest state. Caller cancellation or disconnect stops waiting; it does
not cancel remote work. Shutdown releases waiters before closing the store.

Optional invocation `executionTimeoutMs` (100–1800000 ms) establishes a total budget from `issuedAt`,
including queue time. MCP exposes it beside `args`; CLI exposes `--execution-timeout`.
Use this field only with updated Connectors; older strict protocol readers may reject it.
SDK `buildInvocation` accepts it and, unless `timeoutMs` was explicitly supplied, derives
`expiresAt` from that budget. Devices use the earlier of `issuedAt + executionTimeoutMs`
and `expiresAt`. Lease renewals and subsequent waits never reset the execution deadline.

Expiry requests cooperative cancellation using the existing runtime signal/cancellation checks.
Tools that cannot interrupt an OS operation may finish that operation before observing cancellation.
Leases remain valid for reporting the actual result; expiry does not invent a successful or failed
receipt. Existing tool-specific timeouts continue to apply, and invocations without the new field
retain their previous behavior.

Reuse the original invocation ID to recover a submitted dispatch, even after its submission expiry.
Changing execution budget for the same invocation or idempotency key is a conflict. Submission
time is not reset when an idempotency key returns an existing dispatch.
