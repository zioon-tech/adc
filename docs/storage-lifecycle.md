# Temporary storage lifecycle

ADC is a relay for tool output and artifacts. Save conversation history and formal files in the
receiving application, destination device or durable file store. ADC's relay copy is temporary.
Native `file.transfer` continues to use its independent transfer cleanup and object-store lifecycle.

## Default policy

| Data                                                                                | Retention                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Screenshot/text artifacts, `file.read` output and other output over 64 KiB          | 24 hours after terminal completion                                 |
| Fully received result/artifact with explicit consumption acknowledgment             | Earlier of its original expiry and 10 minutes after acknowledgment |
| Other detailed tool output, completed request arguments and execution audit records | 7 days after completion                                            |
| Execution summaries                                                                 | 30 days, then compacted to a safety record                         |
| Deduplication keys, original input hash, terminal status and side-effect receipt    | Retained to prevent replaying an old side effect                   |

Consumption acknowledgment is idempotent. Repeating it cannot extend the first acknowledgment's
grace period. `invocation.expiresAt` remains the execution deadline and is independent of storage
expiry. Queued/running work and artifacts it still depends on are protected from age-based cleanup.
Resolved or expired approval request bodies also lose their detailed arguments after 7 days.
`unknown_outcome` keeps its original status, error and receipt for reconciliation.

A safety record is deliberately retained beyond 30 days. A caller can refresh `issuedAt` while
reusing an old idempotency key; deleting that key would permit a completed write to run again.
Retiring request detail never deletes the stored input hash or the deduplication indexes.

## Consumption API and receiving applications

All reads and acknowledgments require the current account/grant and resource visibility.

- `POST /api/v1/invocations/<invocationId>/consumed`, body `{}`: acknowledge a retained terminal result.
- `POST /api/v1/artifacts/<artifactId>/consumed`, body `{ "sha256": "sha256:...", "byteSize": 123 }`:
  acknowledge the complete bytes received. Size and checksum must match the immutable artifact.

The SDK exposes `acknowledgeResult(invocationId)` and `acknowledgeArtifact(artifactId, data)`.
Call them after retaining the complete result or saving the file:

```ts
const bytes = await client.artifact(artifactId);
await writeFile(destination, bytes);
await client.acknowledgeArtifact(artifactId, bytes);
```

Downloading alone does not acknowledge a file. Existing SDK/CLI consumers that do not acknowledge
still receive the 24-hour terminal retention window. MCP retains complete bytes in its response;
the hosted MCP endpoint acknowledges only after the HTTP response finishes sending. The external
MCP adapter retains the default 24-hour window because response construction does not establish
delivery to the receiving process.
For durable files, use the SDK acknowledgment after saving.

An expired image download returns HTTP 410, `error.code = "expired"`, `retryable = false`.
Result queries retain the execution's original status and return an explicit output marker:

```json
{
  "contentRetired": true,
  "contentRetiredAt": "2026-11-08T10:00:00.000Z",
  "contentRetiredReason": "expired",
  "byteSize": 123,
  "sha256": "sha256:..."
}
```

The same marker uses `size_exceeded` or `quota_exceeded` when a completed device result cannot be
retained. This does not turn an already completed write into a retryable execution failure.
MCP displays the delivery error explicitly. Replaying an invocation whose request detail has expired
returns an expiry error; reusing its idempotency key still resolves to the original terminal record.
Consumers must not replace an expired result with a new side-effecting invocation.

## Budgets and cleanup

The server caps one result/artifact at 25 MiB, one invocation payload at 1 MiB, and execution
metadata at 64 KiB. Larger files should use native `file.transfer`. Retained temporary output,
request/approval arguments and artifact bytes share a 256 MiB per-account and 2 GiB installation
budget. Artifact admission checks capacity before writing bytes. Completion that exceeds capacity
stores the receipt and a bounded retirement marker. Metadata, indexes, authentication data and WAL
are additional overhead; these payload quotas are not a cap on PostgreSQL's physical file size.

Every Control Plane starts a janitor and continues scanning every minute even with no new requests.
Each SQL sweep processes at most 100 records per category, with a 64 MiB result/artifact payload
budget. A single legacy record larger than this budget may be retired to avoid starvation.
Legacy terminal records are initialized in bounded batches instead of rewriting all history in the
DDL transaction. No in-flight task is retired based on its creation date.

Images are immutable SHA-256 files shared across invocations. Metadata retirement releases only that
invocation's reference. A file is deleted only when no unretired artifact references it. Upload,
buffered reads and file deletion use the same PostgreSQL advisory hash lock across server processes.
A separate bounded lock pool avoids exhausting the data pool while a lock holder reads metadata.
Old orphan files and interrupted temporary writes are swept too; fresh files have a grace period.
Multiple replicas must use the same database and a shared asset filesystem.

The sweep adjusts normal autovacuum thresholds to encourage page reuse. It does not automatically
run `VACUUM FULL`, acquire long exclusive table locks, or claim that SQL deletion shrank physical
files. Disk compaction remains an explicitly planned maintenance operation.

## Configuration and monitoring

All defaults are in `packages/db/src/storage-policy.ts`, with matching `ADC_STORAGE_*` settings in
`.env.example` and `deploy/compose.yaml`. Durations are milliseconds and capacities are bytes.
Invalid or misordered deadlines fail startup. `ADC_STORAGE_MIN_FREE_BYTES` reserves 256 MiB on the
asset filesystem; uploads are rejected before consuming that reserve.

Authenticated `/metrics` adds:

- `adc_temporary_storage_bytes`, `adc_storage_expired_bytes`
- `adc_storage_oldest_expired_seconds`
- `adc_storage_maintenance_last_success_timestamp_seconds`
- `adc_storage_maintenance_failures_total`, `adc_storage_retired_total{kind=...}`
- `adc_asset_disk_available_bytes`, `adc_database_physical_bytes`
- `adc_postgres_wal_bytes`, `adc_postgres_wal_metrics_available`

WAL metrics require a database role with `pg_monitor` or superuser authority; absence is explicit.
The database metric includes reusable pages; WAL is a cluster-wide value. Monitor the database
host's free disk independently when it is on a different filesystem from assets. Recommended alerts:
maintenance has not succeeded for 5 minutes, expiry backlog is older than 10 minutes, payload usage
exceeds 80% of the configured global budget, or available disk is below 1 GiB.

Source-level regressions cover real PostgreSQL migrations and retention, acknowledgments, shared
hash references, quota admission, deduplication after compaction, explicit expiry reads, orphan
cleanup and continuous idle maintenance.
