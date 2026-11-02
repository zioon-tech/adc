# File transfer

ADC authorizes and tracks transfers; private object storage carries the file bytes. The production
adapter is Alibaba OSS. The storage interface is pluggable, so ADC does not require TOS.
Both endpoints need outbound HTTPS; neither needs inbound connectivity.

## Commands

Device to device:

```bash
adc transfer create \
  --source-node node_source --source-root root_source --source-path models/model.bin \
  --destination-node node_target --destination-root root_target \
  --destination-path cache/model.bin --idempotency-key model-copy-1 --json
```

Local Agent to device (no source Node):

```bash
adc transfer upload --file ./model.bin \
  --destination-node node_target --destination-root root_target \
  --destination-path cache/model.bin --idempotency-key model-upload-1 --json

adc transfer wait xfr_example --wait 4000 --json
adc transfer status xfr_example --json
adc transfer cancel xfr_example --json
```

Grant `file.transfer` and the participating devices/roots. Destination access must be writable.
Grant the corresponding task tools for status/wait/cancel. Owner approval, when required, occurs
before upload tickets or device dispatch. After approval, repeat the exact upload command and
idempotency key to resume the same Agent upload. File size and digest must remain unchanged.

Protocol source forms are a device `{nodeId, rootId, path}` or an Agent
`{kind:"agent", path:"filename", byteSize, contentSha256}`. Agent source names are descriptive;
the server never opens them. The SDK exposes `uploadTransferChunk(transferId,index,buffer,signal)`.
MCP creates the same transfer using `file.transfer`; bytes use the CLI/SDK and never enter JSON
tool arguments. The destination receipt defines success.

## Data and integrity

ADC creates one durable record and either two device dispatches or a single receiving dispatch.
Device requests use signed Node authentication; Agent uploads use the originating scoped credential.
ADC validates account, grant, role, approval, state, expiry and chunk index before issuing tickets.
The receiving Connector must advertise `transferDataPlanes: ["object"]`.

Chunks are 1–32 MiB (default 8 MiB). PUT tickets expire after five minutes, sign Content-MD5 and
SHA-256/size metadata, and forbid overwriting an object. GET tickets require matching HEAD metadata.
Connectors never send ADC credentials to storage, follow redirects or read unbounded responses.
Cancellation and the execution deadline abort storage requests.

The destination verifies every SHA-256 digest and the complete file before fsync and atomic
create-only commit. It never overwrites an existing destination. Partial-file ledgers and receipts
allow resuming after interruption. Directories and cross-account copies remain unsupported.

## Configuration

Transfers default to disabled. Select a backend explicitly:

| Setting                                                                 | Default / requirement                                      |
| ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| `ADC_TRANSFER_BACKEND`                                                  | `disabled`; `oss` recommended; `local` explicit fallback   |
| `ADC_TRANSFER_MAX_BYTES`                                                | 1 GiB per file                                             |
| Account admission limit                                                 | 8 active transfers, enforced transactionally in PostgreSQL |
| `ADC_TRANSFER_OSS_REGION`                                               | Required for OSS, e.g. `oss-cn-shanghai`                   |
| `ADC_TRANSFER_OSS_BUCKET`                                               | Required private bucket                                    |
| `ADC_TRANSFER_OSS_ACCESS_KEY_ID` / `ADC_TRANSFER_OSS_ACCESS_KEY_SECRET` | Restricted server RAM identity                             |
| `ADC_TRANSFER_DIR`                                                      | Used only by local backend                                 |

Use a private bucket separate from the public Connector distribution bucket. Disable public ACLs,
use HTTPS, and add a one-day lifecycle expiration for `transfers/`. Scope the RAM identity to
ListObjects on that bucket and GetObject/PutObject/DeleteObject on its `transfers/*` keys. Do not
grant bucket creation, ACL changes or access to the public release bucket. Keep credentials in
the mode-0600 service environment, never in repository files or CLI arguments.

ADC attempts terminal cleanup immediately, then scans once a minute after a fifteen-minute grace
period. It records successful cleanup only after transfer expiry plus the grace period, so late
PUTs from previously issued tickets are removed again. Bucket lifecycle bounds orphan retention
through server crashes or missing records. Cleanup failures do not reject durable task receipts.
The scanner is bounded to 100 records per pass and does not overlap itself.

An explicit local relay stores bytes on ADC and therefore consumes server disk and bandwidth.
Multiple local replicas require shared persistent storage. Direct OSS replicas share only
PostgreSQL and the bucket. Completed transfers do not require backing up temporary chunks.

## Migration and operations

Drain or cancel old local transfers before switching backends. Back up PostgreSQL and the service
environment, publish updated Connectors, confirm their capabilities, then switch the environment
and restart ADC. Existing transfer formats, approval policy and create-only destination behavior
are preserved. Defaults change from local/100 GiB to disabled/1 GiB.

Monitor failed/unknown transfers, cleanup warnings, object count/bytes and storage request costs.
Signed URLs are short-lived bearer capabilities and must not appear in logs. Generic SDK failures
log only error type/code. Keep bucket lifecycle enabled even when application cleanup is healthy.
