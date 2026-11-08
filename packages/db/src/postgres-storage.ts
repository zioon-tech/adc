import type { Pool, PoolClient } from "pg";
import { ErrorCodes, ProtocolError } from "@adc/protocol";
import type { StoragePolicy, StorageUsage, StorageMaintenanceResult } from "./storage-policy.ts";

export const storageLock = async (client: PoolClient): Promise<void> => {
  // One lock order for completion, upload and maintenance, across all server processes.
  await client.query("SELECT pg_advisory_xact_lock(728194033)");
};

export async function lockStorageAccount(
  client: PoolClient,
  accountId: string,
  resourceAccountId?: string,
  exclusive = !!resourceAccountId
): Promise<void> {
  // Lock every collaboration account in the revocation order before any single
  // account, node or dispatch lock. Prelocking only the requester reverses that order.
  // Admission holds UPDATE for authorization linearization. Completion/upload
  // need KEY SHARE for FK safety; UPDATE there would block revocation audit inserts.
  const accounts = [
    ...new Set([accountId, ...(resourceAccountId ? [resourceAccountId] : [])])
  ].sort();
  for (const id of accounts) {
    const account = await client.query(
      `SELECT 1 FROM adc_accounts WHERE account_id = $1 ${exclusive ? "FOR UPDATE" : "FOR KEY SHARE"}`,
      [id]
    );
    if (!account.rowCount)
      throw new ProtocolError(ErrorCodes.NOT_FOUND, "Account was not found", false);
  }
}

export async function availableStorage(
  client: PoolClient,
  accountId: string,
  bytes: number,
  policy: StoragePolicy,
  replacingApprovalInvocationId?: string
): Promise<boolean> {
  const usage = await client.query(
    `SELECT COALESCE(sum(bytes), 0)::text AS total,
      COALESCE(sum(bytes) FILTER (WHERE account_id = $1), 0)::text AS account
     FROM (
       SELECT account_id, COALESCE(input_bytes, octet_length((invocation->'args')::text), 0) +
         CASE WHEN NOT result_initialized AND result_retired_at IS NULL
         THEN COALESCE(octet_length((result->'output')::text), 0)
         ELSE result_bytes END AS bytes FROM adc_dispatches
       UNION ALL
       SELECT account_id, byte_size FROM adc_artifacts WHERE retired_at IS NULL
       UNION ALL
       SELECT a.account_id, COALESCE(a.input_bytes, octet_length((a.invocation->'args')::text), 0)
         FROM adc_approvals a WHERE a.invocation_id IS DISTINCT FROM $2 AND NOT EXISTS
           (SELECT 1 FROM adc_dispatches d WHERE d.invocation_id = a.invocation_id)
     ) usage`,
    [accountId, replacingApprovalInvocationId ?? null]
  );
  return (
    Number(usage.rows[0].total) + bytes <= policy.globalBytes &&
    Number(usage.rows[0].account) + bytes <= policy.accountBytes
  );
}

export async function maintainPostgresStorage(
  client: PoolClient,
  now: Date,
  policy: StoragePolicy
): Promise<StorageMaintenanceResult> {
  await storageLock(client);
  await client.query("SET LOCAL statement_timeout = '30s'");
  const terminal = `('succeeded', 'failed', 'denied', 'cancelled', 'unknown_outcome')`;
  const stamp = now.toISOString();
  const limit = policy.batchSize;
  await client.query(
    `WITH candidates AS (
      SELECT dispatch_id, COALESCE(octet_length((result->'output')::text), 0) AS bytes FROM adc_dispatches
      WHERE status IN ${terminal} AND result IS NOT NULL AND NOT result_initialized
      ORDER BY updated_at, dispatch_id LIMIT $1 FOR UPDATE SKIP LOCKED
    ), budget AS (
      SELECT dispatch_id, sum(bytes) OVER (ORDER BY dispatch_id) AS bytes,
        row_number() OVER (ORDER BY dispatch_id) AS position FROM candidates
    ), batch AS (SELECT dispatch_id FROM budget WHERE bytes <= $5 OR position = 1)
    UPDATE adc_dispatches d SET
      result_bytes = COALESCE(octet_length((result->'output')::text), 0),
      result_sha256 = 'sha256:' || encode(sha256(convert_to(COALESCE((result->'output')::text, ''), 'UTF8')), 'hex'),
      result_initialized = true,
      result_expires_at = LEAST(result_expires_at, updated_at + (
        CASE WHEN COALESCE(octet_length((result->'output')::text), 0) > $2
          OR invocation->>'tool' IN ('file.read', 'screen.capture', 'camera.capture')
        THEN $3::double precision ELSE $4::double precision END * interval '1 millisecond'))
      FROM batch WHERE d.dispatch_id = batch.dispatch_id`,
    [limit, policy.maxMetadataBytes, policy.temporaryTtlMs, policy.detailTtlMs, policy.batchBytes]
  );
  await client.query(
    `WITH batch AS (SELECT dispatch_id FROM adc_dispatches WHERE input_bytes IS NULL
       ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE adc_dispatches d SET input_bytes = COALESCE(octet_length((invocation->'args')::text), 0)
     FROM batch WHERE d.dispatch_id = batch.dispatch_id`,
    [limit]
  );
  await client.query(
    `WITH batch AS (SELECT approval_id FROM adc_approvals WHERE input_bytes IS NULL
       ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE adc_approvals a SET input_bytes = COALESCE(octet_length((invocation->'args')::text), 0)
     FROM batch WHERE a.approval_id = batch.approval_id`,
    [limit]
  );
  await client.query(
    `WITH batch AS (
       SELECT a.artifact_id, COALESCE(d.updated_at, a.created_at) AS terminal_at
       FROM adc_artifacts a LEFT JOIN adc_dispatches d USING(invocation_id)
       WHERE a.expires_at IS NULL AND a.retired_at IS NULL
       AND (d.dispatch_id IS NULL OR d.status IN ${terminal})
       ORDER BY a.created_at LIMIT $1 FOR UPDATE OF a SKIP LOCKED
     ) UPDATE adc_artifacts a SET expires_at = batch.terminal_at + $2 * interval '1 millisecond'
       FROM batch WHERE a.artifact_id = batch.artifact_id`,
    [limit, policy.temporaryTtlMs]
  );
  const results = await client.query(
    `WITH candidates AS (
      SELECT dispatch_id, result_bytes FROM adc_dispatches
      WHERE result_retired_at IS NULL AND result_expires_at <= $1 AND status IN ${terminal}
      ORDER BY result_expires_at, dispatch_id LIMIT $2 FOR UPDATE SKIP LOCKED
    ), budget AS (
      SELECT dispatch_id, sum(result_bytes) OVER (ORDER BY dispatch_id) AS bytes,
        row_number() OVER (ORDER BY dispatch_id) AS position FROM candidates
    ), batch AS (SELECT dispatch_id FROM budget WHERE bytes <= $3 OR position = 1)
    UPDATE adc_dispatches d SET
      result = jsonb_set(result, '{output}', jsonb_build_object(
        'contentRetired', true, 'contentRetiredAt', $1::text,
        'contentRetiredReason', 'expired', 'byteSize', result_bytes, 'sha256', result_sha256)),
      result_retired_at = $1, result_bytes = 0
      FROM batch WHERE d.dispatch_id = batch.dispatch_id`,
    [stamp, limit, policy.batchBytes]
  );
  const artifacts = await client.query(
    `WITH candidates AS (
      SELECT a.artifact_id, byte_size FROM adc_artifacts a
      WHERE retired_at IS NULL AND expires_at <= $1
      AND NOT EXISTS (SELECT 1 FROM adc_dispatches d WHERE d.invocation_id = a.invocation_id
        AND d.status NOT IN ${terminal})
      ORDER BY expires_at, artifact_id LIMIT $2 FOR UPDATE SKIP LOCKED
    ), budget AS (
      SELECT artifact_id, sum(byte_size) OVER (ORDER BY artifact_id) AS bytes,
        row_number() OVER (ORDER BY artifact_id) AS position FROM candidates
    ), batch AS (SELECT artifact_id FROM budget WHERE bytes <= $3 OR position = 1)
    UPDATE adc_artifacts a SET data = ''::bytea, retired_at = $1
      FROM batch WHERE a.artifact_id = batch.artifact_id`,
    [stamp, limit, policy.batchBytes]
  );
  // Retire request payloads after the detail window. Keep routing/permission fields
  // and the original input_hash so replay cannot enqueue a completed side effect.
  const details = await client.query(
    `WITH batch AS (
      SELECT dispatch_id FROM adc_dispatches WHERE details_retired_at IS NULL
      AND status IN ${terminal} AND updated_at <= $1
      ORDER BY updated_at LIMIT $2 FOR UPDATE SKIP LOCKED
    ) UPDATE adc_dispatches d SET details_retired_at = $3,
      invocation = jsonb_set(invocation, '{args}',
        COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(invocation->'args')
          WHERE key IN ('rootId', 'path', 'cwd') AND jsonb_typeof(value) = 'string'
            AND octet_length(value::text) <= 4096), '{}'::jsonb)),
      input_bytes = 0, lease_token = NULL, lease_expires_at = NULL
      FROM batch WHERE d.dispatch_id = batch.dispatch_id`,
    [new Date(now.getTime() - policy.detailTtlMs).toISOString(), limit, stamp]
  );
  const approvals = await client.query(
    `WITH batch AS (
      SELECT approval_id FROM adc_approvals a WHERE storage_details_retired_at IS NULL
      AND COALESCE(resolved_at, expires_at) <= $1
      AND (status <> 'pending' OR expires_at <= $1)
      AND NOT EXISTS (SELECT 1 FROM adc_dispatches d WHERE d.invocation_id = a.invocation_id
        AND d.status NOT IN ${terminal})
      ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED
    ) UPDATE adc_approvals a SET storage_details_retired_at = $3, input_bytes = 0,
      status = CASE WHEN status = 'pending' THEN 'expired' ELSE status END,
      invocation = jsonb_set(invocation, '{args}', COALESCE(
        (SELECT jsonb_object_agg(key, value) FROM jsonb_each(invocation->'args')
          WHERE key IN ('rootId', 'path', 'cwd') AND jsonb_typeof(value) = 'string'
            AND octet_length(value::text) <= 4096), '{}'::jsonb))
      FROM batch WHERE a.approval_id = batch.approval_id`,
    [new Date(now.getTime() - policy.detailTtlMs).toISOString(), limit, stamp]
  );
  // Beyond 30 days keep only a safety tombstone. Never remove deduplication keys.
  await client.query(
    `WITH batch AS (
      SELECT dispatch_id FROM adc_dispatches WHERE summary_retired_at IS NULL
      AND status IN ${terminal} AND updated_at <= $1
      ORDER BY updated_at LIMIT $2 FOR UPDATE SKIP LOCKED
    ) UPDATE adc_dispatches d SET summary_retired_at = $3,
      policy_decision = jsonb_set(policy_decision, '{explanation}', '"Execution summary expired."'),
      result = CASE WHEN result IS NULL THEN NULL ELSE result - 'receipt' END
      FROM batch WHERE d.dispatch_id = batch.dispatch_id`,
    [new Date(now.getTime() - policy.summaryTtlMs).toISOString(), limit, stamp]
  );
  const audits = await client.query(
    `WITH batch AS (
      SELECT event_id FROM adc_audit_events e WHERE created_at <= $1
      AND NOT EXISTS (SELECT 1 FROM adc_dispatches d WHERE d.invocation_id = e.invocation_id
        AND (d.status NOT IN ${terminal} OR d.updated_at > $1))
      ORDER BY created_at LIMIT $2
    ) DELETE FROM adc_audit_events e USING batch WHERE e.event_id = batch.event_id`,
    [new Date(now.getTime() - policy.detailTtlMs).toISOString(), limit]
  );
  return {
    results: results.rowCount ?? 0,
    artifacts: artifacts.rowCount ?? 0,
    details: details.rowCount ?? 0,
    audits: audits.rowCount ?? 0,
    approvals: approvals.rowCount ?? 0
  };
}

export async function postgresStorageUsage(
  pool: Pool,
  now: Date,
  policy: StoragePolicy
): Promise<StorageUsage> {
  const data = await pool.query(
    `SELECT COALESCE(sum(bytes) FILTER (WHERE NOT retired), 0)::text AS bytes,
      COALESCE(sum(bytes) FILTER (WHERE NOT retired AND expires_at <= $1), 0)::text AS expired,
      min(expires_at) FILTER (WHERE NOT retired AND expires_at <= $1) AS oldest,
      count(*) FILTER (WHERE retired AND kind = 'result')::text AS results,
      count(*) FILTER (WHERE retired AND kind = 'artifact')::text AS artifacts
     FROM (
       SELECT CASE WHEN NOT result_initialized AND result_retired_at IS NULL
         THEN COALESCE(octet_length((result->'output')::text), 0) ELSE result_bytes END AS bytes,
         result_expires_at AS expires_at, result_retired_at IS NOT NULL AS retired, 'result' AS kind
         FROM adc_dispatches
       UNION ALL
       SELECT COALESCE(input_bytes, octet_length((invocation->'args')::text), 0),
         CASE WHEN details_retired_at IS NULL AND status IN ('succeeded', 'failed', 'denied', 'cancelled', 'unknown_outcome')
           THEN updated_at + $2 * interval '1 millisecond' END, false, 'input'
         FROM adc_dispatches
       UNION ALL
       SELECT byte_size, expires_at, retired_at IS NOT NULL, 'artifact' FROM adc_artifacts
       UNION ALL
       SELECT COALESCE(a.input_bytes, octet_length((a.invocation->'args')::text), 0),
         CASE WHEN storage_details_retired_at IS NULL THEN COALESCE(resolved_at, expires_at) + $2 * interval '1 millisecond' END,
         false, 'approval' FROM adc_approvals a WHERE NOT EXISTS
           (SELECT 1 FROM adc_dispatches d WHERE d.invocation_id = a.invocation_id)
     ) usage`,
    [now.toISOString(), policy.detailTtlMs]
  );
  const row = data.rows[0];
  const physical = await pool.query(
    `SELECT pg_database_size(current_database())::text AS database_bytes,
      has_function_privilege(current_user, 'pg_ls_waldir()', 'EXECUTE') AS can_read_wal`
  );
  // PostgreSQL checks a CASE subquery's function privileges before selecting its
  // branch. Keep restricted WAL observation out of the payload/database query.
  let walBytes: number | undefined;
  if (physical.rows[0].can_read_wal) {
    try {
      const wal = await pool.query("SELECT sum(size)::text AS bytes FROM pg_ls_waldir()");
      if (wal.rows[0].bytes !== null) walBytes = Number(wal.rows[0].bytes);
    } catch (error) {
      // A role can lose permission between the capability check and observation.
      if ((error as { code?: string }).code !== "42501") throw error;
    }
  }
  return {
    temporaryBytes: Number(row.bytes),
    expiredBytes: Number(row.expired),
    retiredResults: Number(row.results),
    retiredArtifacts: Number(row.artifacts),
    databaseBytes: Number(physical.rows[0].database_bytes),
    ...(walBytes !== undefined ? { walBytes } : {}),
    ...(row.oldest ? { oldestExpiredAt: new Date(row.oldest).toISOString() } : {})
  };
}

export function quotaError(): ProtocolError {
  return new ProtocolError(ErrorCodes.INVALID_REQUEST, "Temporary storage quota exceeded", false);
}
