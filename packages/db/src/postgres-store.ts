import { createHash, randomBytes } from "node:crypto";
import { consentIsAuthorized } from "./consent-authority.ts";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import {
  ErrorCodes,
  ProtocolError,
  createId,
  isSideEffectTool,
  type CapabilityAdvertisement,
  type InvocationResult,
  type Receipt
} from "@adc/protocol";
import type {
  AccountResourceSummary,
  AccountRecord,
  AgentGrantRecord,
  ApprovalPage,
  ApprovalPageOptions,
  ApprovalRecord,
  ArtifactRecord,
  AuditPage,
  AuditPageOptions,
  AuditEvent,
  DispatchRecord,
  NodeRecord,
  PairNodeInput,
  PairNodeResult,
  PairingCodeRecord,
  ProjectRecord,
  RootBindingRecord,
  Store,
  TransferRecord
} from "./types.ts";
import { assertSameInvocation, invocationInputHash } from "./dispatch-identity.ts";
import {
  ProjectManagement,
  lockProjectGrant,
  projectFromRow,
  rootFromRow
} from "./project-management.ts";
import {
  assertMetadataBudget,
  bodyHash,
  jsonBytes,
  retireResult,
  storagePolicy,
  type StoragePolicy
} from "./storage-policy.ts";
import {
  availableStorage,
  maintainPostgresStorage,
  postgresStorageUsage,
  quotaError,
  storageLock
} from "./postgres-storage.ts";
import { lockStorageAccount } from "./postgres-storage.ts";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nodeFromRow(row: QueryResultRow): NodeRecord {
  return {
    nodeId: row.node_id,
    accountId: row.account_id,
    resourceClass: row.resource_class ?? "physical",
    label: row.label,
    ...(row.description ? { description: row.description } : {}),
    publicKey: row.public_key,
    platform: row.platform,
    status: row.status,
    revision: row.revision,
    ...(row.access_policy ? { accessPolicy: row.access_policy } : {}),
    ...(row.deleted_at ? { deletedAt: iso(row.deleted_at) } : {}),
    ...(row.capability ? { capability: row.capability } : {}),
    ...(row.last_seen_at ? { lastSeenAt: iso(row.last_seen_at) } : {}),
    createdAt: iso(row.created_at)
  };
}

function dispatchFromRow(row: QueryResultRow): DispatchRecord {
  return {
    dispatchId: row.dispatch_id,
    invocation: row.invocation,
    nodeId: row.node_id,
    policyDecision: row.policy_decision,
    status: row.status,
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.result ? { result: row.result } : {}),
    ...(row.receipt ? { receipt: row.receipt } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.details_retired_at ? { detailsRetiredAt: iso(row.details_retired_at) } : {}),
    ...(row.summary_retired_at ? { summaryRetiredAt: iso(row.summary_retired_at) } : {}),
    ...(row.result_expires_at ? { resultExpiresAt: iso(row.result_expires_at) } : {})
  };
}

function auditFromRow(row: QueryResultRow): AuditEvent {
  return {
    eventId: row.event_id,
    accountId: row.account_id,
    ...(row.invocation_id ? { invocationId: row.invocation_id } : {}),
    type: row.event_type,
    payload: row.payload,
    createdAt: iso(row.created_at)
  };
}

function approvalFromRow(row: QueryResultRow): ApprovalRecord {
  return {
    approvalId: row.approval_id,
    accountId: row.account_id,
    invocation: row.invocation,
    nodeId: row.node_id,
    placementReason: row.placement_reason,
    policyDecision: row.policy_decision,
    status: row.status,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    requiredConsents: row.required_consents ?? [],
    consents: row.consents ?? [],
    ...(row.resolved_at ? { resolvedAt: iso(row.resolved_at) } : {})
  };
}

function transferFromRow(row: QueryResultRow): TransferRecord {
  return {
    transferId: row.transfer_id,
    invocation: row.invocation,
    args: row.args,
    status: row.status,
    ...(row.source_dispatch_id ? { sourceDispatchId: row.source_dispatch_id } : {}),
    ...(row.destination_dispatch_id ? { destinationDispatchId: row.destination_dispatch_id } : {}),
    ...(row.byte_size === null || row.byte_size === undefined
      ? {}
      : { byteSize: Number(row.byte_size) }),
    ...(row.chunk_count === null || row.chunk_count === undefined
      ? {}
      : { chunkCount: Number(row.chunk_count) }),
    ...(row.content_sha256 ? { contentSha256: row.content_sha256 } : {}),
    bytesTransferred: Number(row.bytes_transferred ?? 0),
    ...(row.error ? { error: row.error } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {})
  };
}

function grantFromRow(row: QueryResultRow): AgentGrantRecord {
  return {
    grantId: row.grant_id,
    accountId: row.account_id,
    name: row.name,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    actorId: row.actor_id,
    ...(row.responsible_user_id ? { responsibleUserId: row.responsible_user_id } : {}),
    resourceBindings: row.resource_bindings ?? [],
    profile: row.profile,
    nodeIds: row.node_ids,
    rootIds: row.root_ids,
    rootAccess: row.root_access,
    ...(row.approval_policy ? { approvalPolicy: row.approval_policy } : {}),
    allowedTools: row.allowed_tools,
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
    ...(row.deleted_at ? { deletedAt: iso(row.deleted_at) } : {}),
    revision: row.revision,
    createdAt: iso(row.created_at)
  };
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function closePool(pool: Pool): Promise<void> {
  const connections: Promise<void>[] = [];
  const removed = (client: PoolClient) => {
    // pg-pool resolves end() after removing clients, before their sockets finish
    // closing. Observe the actual end event without sending another termination.
    connections.push(new Promise<void>((resolve) => client.once("end", resolve)));
  };
  pool.on("remove", removed);
  try {
    await pool.end();
    await Promise.all(connections);
  } finally {
    pool.removeListener("remove", removed);
  }
}

export class PostgresStore implements Store {
  readonly pool: Pool;
  private readonly artifactLockPool: Pool;
  private retention = storagePolicy();

  configureStorage(policy: StoragePolicy): void {
    this.retention = storagePolicy(policy);
  }
  maintainStorage(now: Date) {
    return transaction(this.pool, (client) => maintainPostgresStorage(client, now, this.retention));
  }
  storageUsage(now: Date) {
    return postgresStorageUsage(this.pool, now, this.retention);
  }
  async acknowledgeResult(invocationId: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE adc_dispatches SET result_consumed_at = COALESCE(result_consumed_at, $2),
       result_bytes = CASE WHEN result_initialized THEN result_bytes
         ELSE COALESCE(octet_length((result->'output')::text), 0) END,
       result_sha256 = COALESCE(result_sha256,
         'sha256:' || encode(sha256(convert_to(COALESCE((result->'output')::text, ''), 'UTF8')), 'hex')),
       result_initialized = true,
       result_expires_at = LEAST(result_expires_at,
         updated_at + CASE WHEN COALESCE(octet_length((result->'output')::text), 0) > $4
           OR invocation->>'tool' IN ('file.read', 'screen.capture', 'camera.capture')
           THEN $5::double precision ELSE $6::double precision END * interval '1 millisecond',
         $2::timestamptz + $3 * interval '1 millisecond')
       WHERE invocation_id = $1 AND result_retired_at IS NULL
       AND status IN ('succeeded', 'failed', 'denied', 'cancelled', 'unknown_outcome')`,
      [
        invocationId,
        now.toISOString(),
        this.retention.deliveryGraceMs,
        this.retention.maxMetadataBytes,
        this.retention.temporaryTtlMs,
        this.retention.detailTtlMs
      ]
    );
  }
  async acknowledgeArtifact(artifactId: string, now: Date): Promise<void> {
    await this.pool.query(
      `WITH owner AS (
         SELECT a.artifact_id, CASE WHEN d.dispatch_id IS NULL THEN a.created_at
           WHEN d.status IN ('succeeded', 'failed', 'denied', 'cancelled', 'unknown_outcome')
             THEN d.updated_at END AS terminal_at
         FROM adc_artifacts a LEFT JOIN adc_dispatches d USING(invocation_id)
         WHERE a.artifact_id = $1
       )
       UPDATE adc_artifacts a SET consumed_at = COALESCE(a.consumed_at, $2),
       expires_at = LEAST(a.expires_at,
         owner.terminal_at + $4 * interval '1 millisecond',
         $2::timestamptz + $3 * interval '1 millisecond')
       FROM owner WHERE a.artifact_id = owner.artifact_id AND a.retired_at IS NULL`,
      [artifactId, now.toISOString(), this.retention.deliveryGraceMs, this.retention.temporaryTtlMs]
    );
  }
  async hasLiveArtifact(sha256: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM adc_artifacts WHERE content_sha256 = $1 AND retired_at IS NULL LIMIT 1",
      [sha256]
    );
    return !!result.rowCount;
  }
  async withArtifactLock<T>(sha256: string, operation: () => Promise<T>): Promise<T> {
    const client = await this.artifactLockPool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 728194034))", [sha256]);
      return await operation();
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 728194034))", [sha256]);
      } finally {
        client.release();
      }
    }
  }

  constructor(connectionStringOrPool: string | Pool) {
    this.pool =
      typeof connectionStringOrPool === "string"
        ? new Pool({ connectionString: connectionStringOrPool, max: 10 })
        : connectionStringOrPool;
    // Hash locks must not consume the data pool while their callback needs another
    // connection. A separate bounded pool prevents saturation deadlocks.
    this.artifactLockPool = new Pool({ ...this.pool.options, max: 4 });
  }

  async migrate(): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    const directory = resolve(here, "../migrations");
    await transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(728194032)");
      await client.query(`CREATE TABLE IF NOT EXISTS adc_schema_migrations (
        name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT NOW()
      )`);
      for (const name of (await readdir(directory))
        .filter((name) => /^\d+.*\.sql$/.test(name))
        .sort()) {
        const sql = await readFile(resolve(directory, name), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        const existing = await client.query<{ checksum: string }>(
          "SELECT checksum FROM adc_schema_migrations WHERE name = $1",
          [name]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].checksum !== checksum) throw new Error(`Migration changed: ${name}`);
          continue;
        }
        await client.query(sql);
        await client.query("INSERT INTO adc_schema_migrations (name, checksum) VALUES ($1, $2)", [
          name,
          checksum
        ]);
      }
    });
  }

  async close(): Promise<void> {
    await closePool(this.artifactLockPool);
    await closePool(this.pool);
  }

  async putAccount(account: AccountRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO adc_accounts (account_id, owner_token_hash, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET owner_token_hash = EXCLUDED.owner_token_hash`,
      [account.accountId, account.ownerTokenHash, account.createdAt]
    );
  }

  async getAccount(accountId: string): Promise<AccountRecord | undefined> {
    const result = await this.pool.query(
      "SELECT account_id, owner_token_hash, created_at FROM adc_accounts WHERE account_id = $1",
      [accountId]
    );
    const row = result.rows[0];
    return row
      ? {
          accountId: row.account_id,
          ownerTokenHash: row.owner_token_hash,
          createdAt: iso(row.created_at)
        }
      : undefined;
  }

  async putPairingCode(code: PairingCodeRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO adc_pairing_codes (code_hash, account_id, expires_at, used_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code_hash) DO NOTHING`,
      [code.codeHash, code.accountId, code.expiresAt, code.usedAt ?? null]
    );
  }

  async pairNode(input: PairNodeInput): Promise<PairNodeResult | undefined> {
    return transaction(this.pool, async (client) => {
      const consumed = await client.query(
        `UPDATE adc_pairing_codes
         SET used_at = $2
         WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2
         RETURNING account_id`,
        [input.codeHash, input.now.toISOString()]
      );
      if (!consumed.rowCount) {
        return undefined;
      }
      // Pairing can reach the server before the installer persists its private key.
      // A same-account device that never completed one poll is safe to replace.
      const replaced = await client.query(
        `UPDATE adc_nodes
         SET status = 'revoked', deleted_at = $3, revision = revision + 1
         WHERE account_id = $1 AND label = $2 AND status = 'active'
           AND last_seen_at IS NULL AND deleted_at IS NULL
         RETURNING node_id`,
        [consumed.rows[0]!.account_id, input.node.label, input.now.toISOString()]
      );
      try {
        const inserted = await client.query(
          `INSERT INTO adc_nodes
           (node_id, account_id, label, public_key, platform, status, capability, last_seen_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [
            input.node.nodeId,
            consumed.rows[0]!.account_id,
            input.node.label,
            input.node.publicKey,
            input.node.platform,
            input.node.status,
            input.node.capability ?? null,
            input.node.lastSeenAt ?? null,
            input.node.createdAt
          ]
        );
        return {
          node: nodeFromRow(inserted.rows[0]!),
          replacedNodeIds: replaced.rows.map((row) => String(row.node_id))
        };
      } catch (error: any) {
        if (error?.code === "23505") {
          throw new ProtocolError(ErrorCodes.CONFLICT, "node label already exists", false);
        }
        throw error;
      }
    });
  }

  async getNode(nodeId: string): Promise<NodeRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM adc_nodes WHERE node_id = $1", [nodeId]);
    return result.rows[0] ? nodeFromRow(result.rows[0]) : undefined;
  }

  async listNodes(accountId: string): Promise<NodeRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM adc_nodes WHERE account_id = $1 AND deleted_at IS NULL ORDER BY created_at",
      [accountId]
    );
    return result.rows.map(nodeFromRow);
  }

  async listNodesByIds(accountId: string, nodeIds: string[]): Promise<NodeRecord[]> {
    if (!nodeIds.length) return [];
    const result = await this.pool.query(
      "SELECT * FROM adc_nodes WHERE account_id = $1 AND node_id = ANY($2::text[])",
      [accountId, nodeIds]
    );
    return result.rows.map(nodeFromRow);
  }

  async updateNodePresence(
    nodeId: string,
    capability: CapabilityAdvertisement,
    now: Date
  ): Promise<NodeRecord | undefined> {
    const result = await this.pool.query(
      `UPDATE adc_nodes
       SET capability = CASE
             WHEN last_seen_at IS NULL OR last_seen_at <= $3 THEN $2
             ELSE capability
           END,
           last_seen_at = CASE
             WHEN last_seen_at IS NULL OR last_seen_at <= $3 THEN $3
             ELSE last_seen_at
           END
       WHERE node_id = $1 AND status = 'active'
       RETURNING *`,
      [nodeId, capability, now.toISOString()]
    );
    return result.rows[0] ? nodeFromRow(result.rows[0]) : undefined;
  }

  async touchNodePresences(nodeIds: string[], now: Date): Promise<void> {
    if (!nodeIds.length) return;
    await this.pool.query(
      `UPDATE adc_nodes
       SET last_seen_at = CASE
         WHEN last_seen_at IS NULL OR last_seen_at < $2 THEN $2
         ELSE last_seen_at
       END
       WHERE node_id = ANY($1::text[]) AND status = 'active' AND capability IS NOT NULL`,
      [[...new Set(nodeIds)], now.toISOString()]
    );
  }

  async rotateNodeKey(nodeId: string, publicKey: string, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE adc_nodes
       SET public_key = $2,
           last_seen_at = CASE
             WHEN last_seen_at IS NULL OR last_seen_at < $3 THEN $3
             ELSE last_seen_at
           END
       WHERE node_id = $1 AND status = 'active'`,
      [nodeId, publicKey, now.toISOString()]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async revokeNode(nodeId: string, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE adc_nodes SET status = 'revoked', last_seen_at = $2, revision = revision + 1
       WHERE node_id = $1 AND status = 'active'`,
      [nodeId, now.toISOString()]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async putProject(project: ProjectRecord, createOnly = false, audit?: AuditEvent): Promise<void> {
    await new ProjectManagement(this.pool).putProject(project, createOnly, audit);
  }
  async updateProject(
    accountId: string,
    projectId: string,
    label: string,
    revision: number,
    audit: AuditEvent
  ): Promise<ProjectRecord> {
    return new ProjectManagement(this.pool).updateProject(
      accountId,
      projectId,
      label,
      revision,
      audit
    );
  }
  async deleteProject(
    accountId: string,
    projectId: string,
    revision: number,
    audit: AuditEvent
  ): Promise<void> {
    await new ProjectManagement(this.pool).deleteProject(accountId, projectId, revision, audit);
  }
  async updateRoot(
    accountId: string,
    projectId: string,
    rootId: string,
    changes: { label: string; writable: boolean },
    revision: number,
    audit: AuditEvent
  ): Promise<RootBindingRecord> {
    return new ProjectManagement(this.pool).updateRoot(
      accountId,
      projectId,
      rootId,
      changes,
      revision,
      audit
    );
  }
  async deleteRoot(
    accountId: string,
    projectId: string,
    rootId: string,
    revision: number,
    audit: AuditEvent
  ): Promise<void> {
    await new ProjectManagement(this.pool).deleteRoot(
      accountId,
      projectId,
      rootId,
      revision,
      audit
    );
  }

  async updateNode(
    accountId: string,
    nodeId: string,
    changes: Pick<NodeRecord, "label" | "description" | "accessPolicy">,
    revision: number,
    audit: AuditEvent
  ): Promise<NodeRecord> {
    try {
      return await transaction(this.pool, async (client) => {
        const result = await client.query(
          `UPDATE adc_nodes
           SET label = $3,
               description = COALESCE($6, description),
               access_policy = $4,
               revision = revision + 1
           WHERE account_id = $1 AND node_id = $2 AND revision = $5
             AND deleted_at IS NULL AND status = 'active' RETURNING *`,
          [
            accountId,
            nodeId,
            changes.label,
            changes.accessPolicy ?? null,
            revision,
            changes.description ?? null
          ]
        );
        if (!result.rowCount)
          throw new ProtocolError("conflict", "Device changed. Refresh and try again.", false);
        await insertAudit(client, audit);
        return nodeFromRow(result.rows[0]!);
      });
    } catch (error: any) {
      if (error?.code === "23505")
        throw new ProtocolError("conflict", "A device with this name already exists.", false);
      throw error;
    }
  }

  async deleteNode(
    accountId: string,
    nodeId: string,
    revision: number,
    audit: AuditEvent
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE adc_nodes SET status = 'revoked', deleted_at = $4, revision = revision + 1
         WHERE account_id = $1 AND node_id = $2 AND revision = $3 AND deleted_at IS NULL`,
        [accountId, nodeId, revision, audit.createdAt]
      );
      if (!result.rowCount)
        throw new ProtocolError("conflict", "Device changed. Refresh and try again.", false);
      await cancelResourceWork(client, accountId, "node", nodeId, audit.createdAt);
      await insertAudit(client, audit);
    });
  }

  async getProject(projectId: string): Promise<ProjectRecord | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM adc_projects WHERE project_id = $1 AND deleted_at IS NULL",
      [projectId]
    );
    const row = result.rows[0];
    return row ? projectFromRow(row) : undefined;
  }

  async listProjects(accountId: string): Promise<ProjectRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM adc_projects WHERE account_id = $1 AND deleted_at IS NULL ORDER BY created_at",
      [accountId]
    );
    return result.rows.map(projectFromRow);
  }

  async putRoot(
    root: RootBindingRecord,
    createOnly = false,
    audit?: AuditEvent
  ): Promise<RootBindingRecord> {
    return new ProjectManagement(this.pool).putRoot(root, createOnly, audit);
  }

  async listRoots(projectId: string): Promise<RootBindingRecord[]> {
    const result = await this.pool.query(
      `SELECT r.* FROM adc_roots r JOIN adc_projects p ON p.project_id = r.project_id
       WHERE r.project_id = $1 AND r.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY r.created_at`,
      [projectId]
    );
    return result.rows.map(rootFromRow);
  }

  async listRootsForAccount(accountId: string): Promise<RootBindingRecord[]> {
    const result = await this.pool.query(
      `SELECT r.* FROM adc_roots r
       JOIN adc_projects p ON p.project_id = r.project_id
       WHERE p.account_id = $1 AND p.deleted_at IS NULL AND r.deleted_at IS NULL
       ORDER BY r.created_at`,
      [accountId]
    );
    return result.rows.map(rootFromRow);
  }

  async putGrant(grant: AgentGrantRecord, createOnly = false): Promise<void> {
    await transaction(this.pool, async (client) => {
      await lockProjectGrant(client, grant);
      const result = await client.query(
        `INSERT INTO adc_agent_grants
       (grant_id, account_id, actor_id, profile, node_ids, root_ids, allowed_tools, revoked_at, created_at, name, project_id, root_access, approval_policy, responsible_user_id, resource_bindings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $15, $16)
       ON CONFLICT (grant_id) DO UPDATE SET
         profile = EXCLUDED.profile,
         node_ids = EXCLUDED.node_ids,
         root_ids = EXCLUDED.root_ids,
         allowed_tools = EXCLUDED.allowed_tools,
         name = EXCLUDED.name,
         root_access = EXCLUDED.root_access,
         approval_policy = EXCLUDED.approval_policy,
         resource_bindings = EXCLUDED.resource_bindings,
         revision = adc_agent_grants.revision + 1
       WHERE adc_agent_grants.account_id = EXCLUDED.account_id
         AND adc_agent_grants.actor_id = EXCLUDED.actor_id
         AND adc_agent_grants.responsible_user_id IS NOT DISTINCT FROM EXCLUDED.responsible_user_id
         AND adc_agent_grants.project_id IS NOT DISTINCT FROM EXCLUDED.project_id
         AND adc_agent_grants.revoked_at IS NULL
         AND NOT $14
       RETURNING grant_id`,
        [
          grant.grantId,
          grant.accountId,
          grant.actorId,
          grant.profile,
          JSON.stringify(grant.nodeIds),
          JSON.stringify(grant.rootIds),
          JSON.stringify(grant.allowedTools),
          grant.revokedAt ?? null,
          grant.createdAt,
          grant.name ?? "Agent",
          grant.projectId ?? null,
          grant.rootAccess ?? "selected",
          grant.approvalPolicy ?? null,
          createOnly,
          grant.responsibleUserId ?? null,
          JSON.stringify(grant.resourceBindings ?? [])
        ]
      );
      if (!result.rowCount)
        throw new ProtocolError("conflict", "Grant is unavailable or revoked.", false);
    });
  }

  async getGrant(grantId: string): Promise<AgentGrantRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM adc_agent_grants WHERE grant_id = $1", [
      grantId
    ]);
    return result.rows[0] ? grantFromRow(result.rows[0]) : undefined;
  }

  async listGrants(accountId: string): Promise<AgentGrantRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM adc_agent_grants
       WHERE account_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [accountId]
    );
    return result.rows.map(grantFromRow);
  }

  async revokeGrant(accountId: string, grantId: string, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE adc_agent_grants SET revoked_at = COALESCE(revoked_at, $3), revision = revision + 1
       WHERE account_id = $1 AND grant_id = $2 AND deleted_at IS NULL`,
      [accountId, grantId, now.toISOString()]
    );
    return !!result.rowCount;
  }

  async updateGrant(
    grant: AgentGrantRecord,
    revision: number,
    audit: AuditEvent
  ): Promise<AgentGrantRecord> {
    await transaction(this.pool, async (client) => {
      await lockProjectGrant(client, grant);
      const result = await client.query(
        `UPDATE adc_agent_grants SET name = $3, project_id = $4, profile = $5,
          node_ids = $6, root_ids = $7, root_access = $8, approval_policy = $9,
          allowed_tools = $10, resource_bindings = $12, revision = revision + 1
         WHERE account_id = $1 AND grant_id = $2 AND revision = $11
           AND revoked_at IS NULL AND deleted_at IS NULL`,
        [
          grant.accountId,
          grant.grantId,
          grant.name ?? "Agent",
          grant.projectId ?? null,
          grant.profile,
          JSON.stringify(grant.nodeIds),
          JSON.stringify(grant.rootIds),
          grant.rootAccess ?? "selected",
          grant.approvalPolicy ?? null,
          JSON.stringify(grant.allowedTools),
          revision,
          JSON.stringify(grant.resourceBindings ?? [])
        ]
      );
      if (!result.rowCount)
        throw new ProtocolError("conflict", "Authorization changed. Refresh and try again.", false);
      await insertAudit(client, audit);
    });
    return { ...grant, revision: revision + 1 };
  }

  async deleteGrant(
    accountId: string,
    grantId: string,
    revision: number,
    audit: AuditEvent
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE adc_agent_grants SET revoked_at = COALESCE(revoked_at, $4), deleted_at = $4, revision = revision + 1
         WHERE account_id = $1 AND grant_id = $2 AND revision = $3 AND deleted_at IS NULL`,
        [accountId, grantId, revision, audit.createdAt]
      );
      if (!result.rowCount)
        throw new ProtocolError("conflict", "Authorization changed. Refresh and try again.", false);
      await cancelResourceWork(client, accountId, "grant", grantId, audit.createdAt);
      await insertAudit(client, audit);
    });
  }

  async putApproval(approval: ApprovalRecord): Promise<ApprovalRecord> {
    return transaction(this.pool, async (client) => {
      await storageLock(client);
      await lockStorageAccount(
        client,
        approval.accountId,
        approval.invocation.delegation?.resourceAccountId
      );
      const existing = await client.query("SELECT * FROM adc_approvals WHERE invocation_id = $1", [
        approval.invocation.invocationId
      ]);
      if (existing.rows[0]) {
        if (existing.rows[0].storage_details_retired_at)
          throw new ProtocolError(ErrorCodes.EXPIRED, "Approval details have expired", false);
        assertSameInvocation(existing.rows[0].invocation, approval.invocation);
        return approvalFromRow(existing.rows[0]);
      }
      assertMetadataBudget(
        { ...approval, invocation: { ...approval.invocation, args: undefined } },
        this.retention
      );
      if (
        jsonBytes(approval.invocation.args) > this.retention.maxInvocationBytes ||
        !(await availableStorage(
          client,
          approval.accountId,
          jsonBytes(approval.invocation.args),
          this.retention
        ))
      )
        throw quotaError();
      await assertDelegationCurrent(client, approval.invocation, approval.nodeId);
      const result = await client.query(
        `INSERT INTO adc_approvals
       (approval_id, invocation_id, account_id, node_id, placement_reason, invocation,
        policy_decision, status, created_at, expires_at, resolved_at, required_consents, consents, input_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (invocation_id) DO UPDATE
       SET invocation_id = EXCLUDED.invocation_id
       RETURNING *`,
        [
          approval.approvalId,
          approval.invocation.invocationId,
          approval.accountId,
          approval.nodeId,
          approval.placementReason,
          approval.invocation,
          approval.policyDecision,
          approval.status,
          approval.createdAt,
          approval.expiresAt,
          approval.resolvedAt ?? null,
          JSON.stringify(approval.requiredConsents ?? []),
          JSON.stringify(approval.consents ?? []),
          jsonBytes(approval.invocation.args)
        ]
      );
      const persisted = approvalFromRow(result.rows[0]!);
      assertSameInvocation(persisted.invocation, approval.invocation);
      return persisted;
    });
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM adc_approvals WHERE approval_id = $1", [
      approvalId
    ]);
    return result.rows[0] ? approvalFromRow(result.rows[0]) : undefined;
  }

  async getApprovalByInvocation(invocationId: string): Promise<ApprovalRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM adc_approvals WHERE invocation_id = $1", [
      invocationId
    ]);
    return result.rows[0] ? approvalFromRow(result.rows[0]) : undefined;
  }

  async listApprovals(accountId: string): Promise<ApprovalRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM adc_approvals WHERE account_id = $1 ORDER BY created_at DESC",
      [accountId]
    );
    return result.rows.map(approvalFromRow);
  }

  async listApprovalsPage(accountId: string, options: ApprovalPageOptions): Promise<ApprovalPage> {
    const values: unknown[] = [accountId];
    const visible =
      "(account_id = $1 OR required_consents @> jsonb_build_array(jsonb_build_object('accountId', $1::text, 'role', 'resource')))";
    const conditions = [visible];
    let userCondition = "";
    if (options.responsibleUserId) {
      values.push(options.responsibleUserId);
      userCondition = ` AND (invocation->'delegation'->>'requesterUserId' = $${values.length}
        ${options.includeResourceConsent ? "OR required_consents @> jsonb_build_array(jsonb_build_object('accountId',$1::text,'role','resource'))" : ""})`;
      conditions.push(userCondition.slice(5));
    }
    if (options.status === "pending") {
      values.push(options.now);
      conditions.push(`status = 'pending' AND expires_at > $${values.length}::timestamptz`);
    } else if (options.status === "resolved") {
      values.push(options.now);
      conditions.push(`NOT (status = 'pending' AND expires_at > $${values.length}::timestamptz)`);
    }
    if (options.before) {
      values.push(options.before.createdAt, options.before.itemId);
      conditions.push(
        `(created_at, approval_id) < ($${values.length - 1}::timestamptz, $${values.length})`
      );
    }
    values.push(options.limit + 1);
    const [result, count] = await Promise.all([
      this.pool.query(
        `SELECT * FROM adc_approvals
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC, approval_id DESC
         LIMIT $${values.length}`,
        values
      ),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM adc_approvals
         WHERE ${visible} AND status = 'pending' AND expires_at > $2::timestamptz
           ${
             options.responsibleUserId
               ? `AND (invocation->'delegation'->>'requesterUserId' = $3
             ${options.includeResourceConsent ? "OR required_consents @> jsonb_build_array(jsonb_build_object('accountId',$1::text,'role','resource'))" : ""})`
               : ""
           }`,
        [accountId, options.now, ...(options.responsibleUserId ? [options.responsibleUserId] : [])]
      )
    ]);
    const page = result.rows.slice(0, options.limit).map((row) => {
      const approval = approvalFromRow(row);
      return approval.status === "pending" && approval.expiresAt <= options.now
        ? ({ ...approval, status: "expired" } satisfies ApprovalRecord)
        : approval;
    });
    return {
      approvals: page,
      pendingCount: Number(count.rows[0]?.count ?? 0),
      ...(result.rows.length > options.limit && page.length
        ? {
            nextCursor: {
              createdAt: page.at(-1)!.createdAt,
              itemId: page.at(-1)!.approvalId
            }
          }
        : {})
    };
  }

  async resolveApproval(
    approvalId: string,
    resolution: "approved" | "denied",
    now: Date
  ): Promise<ApprovalRecord | undefined> {
    const result = await this.pool.query(
      `UPDATE adc_approvals
       SET status = CASE WHEN expires_at <= $3 THEN 'expired' ELSE $2 END,
           resolved_at = $3
       WHERE approval_id = $1 AND status = 'pending'
       RETURNING *`,
      [approvalId, resolution, now.toISOString()]
    );
    return result.rows[0] ? approvalFromRow(result.rows[0]) : undefined;
  }

  async enqueue(dispatch: DispatchRecord, audit: AuditEvent): Promise<DispatchRecord> {
    return transaction(this.pool, (client) =>
      insertDispatch(client, dispatch, audit, this.retention)
    );
  }

  async approveAndEnqueue(
    approvalId: string,
    dispatch: DispatchRecord,
    audit: AuditEvent,
    now: Date
  ): Promise<DispatchRecord | undefined> {
    return transaction(this.pool, async (client) => {
      await storageLock(client);
      await lockStorageAccount(
        client,
        dispatch.invocation.accountId,
        dispatch.invocation.delegation?.resourceAccountId
      );
      await assertDelegationCurrent(client, dispatch.invocation, dispatch.nodeId);
      const result = await client.query(
        `SELECT * FROM adc_approvals WHERE approval_id = $1 AND account_id = $2 FOR UPDATE`,
        [approvalId, dispatch.invocation.accountId]
      );
      const approval = result.rows[0];
      if (!approval || approval.status !== "pending" || new Date(approval.expires_at) <= now)
        return;
      if (
        (approval.required_consents ?? []).some(
          (required: { accountId: string; userId?: string }) =>
            !(approval.consents ?? []).some(
              (consent: { accountId: string; userId: string }) =>
                consent.accountId === required.accountId &&
                (!required.userId || required.userId === consent.userId)
            )
        )
      )
        return;
      for (const required of approval.required_consents ?? []) {
        const matching = (approval.consents ?? []).filter(
          (consent: { accountId: string; userId: string }) =>
            consent.accountId === required.accountId &&
            (!required.userId || required.userId === consent.userId)
        );
        let valid = false;
        for (const consent of matching)
          if (await consentIsAuthorized(client, required.accountId, consent.userId, required.role))
            valid = true;
        if (!valid) return;
      }
      assertSameInvocation(approval.invocation, dispatch.invocation);
      const queued = await insertDispatch(client, dispatch, audit, this.retention);
      await client.query(
        `UPDATE adc_approvals SET status = 'approved', resolved_at = $2 WHERE approval_id = $1`,
        [approvalId, now.toISOString()]
      );
      await client.query(
        `INSERT INTO adc_audit_events (event_id, account_id, invocation_id, event_type, payload, created_at)
         VALUES ($1, $2, $3, 'approval.approved', $4, $5)`,
        [
          createId("dsp"),
          dispatch.invocation.accountId,
          dispatch.invocation.invocationId,
          { approvalId, dispatchId: queued.dispatchId },
          now.toISOString()
        ]
      );
      return queued;
    });
  }

  async createTransfer(
    transfer: TransferRecord,
    dispatches: DispatchRecord[],
    audits: AuditEvent[]
  ): Promise<TransferRecord> {
    return transaction(this.pool, async (client) => {
      await storageLock(client);
      const invocation = transfer.invocation;
      await lockStorageAccount(
        client,
        invocation.accountId,
        invocation.delegation?.resourceAccountId
      );
      // Serialize admission per account across replicas; retries do not consume a new slot.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        invocation.accountId
      ]);
      const active = await client.query(
        `SELECT count(*)::int AS count FROM adc_transfers
         WHERE account_id = $1 AND status IN ('awaiting_approval', 'queued', 'transferring', 'verifying')
           AND (invocation->>'expiresAt')::timestamptz > NOW()
           AND NOT (invocation_id = $2 OR (actor_id = $3 AND idempotency_key = $4))`,
        [
          invocation.accountId,
          invocation.invocationId,
          invocation.actor.id,
          invocation.idempotencyKey ?? ""
        ]
      );
      if (active.rows[0]!.count >= 8) {
        throw new ProtocolError(
          ErrorCodes.CONFLICT,
          "account transfer concurrency limit reached",
          true
        );
      }
      const inserted = await client.query(
        `INSERT INTO adc_transfers
         (transfer_id, invocation_id, account_id, actor_id, grant_id, idempotency_key,
          input_hash, invocation, args, status, bytes_transferred, created_at, updated_at,
          byte_size, chunk_count, content_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT DO NOTHING RETURNING *`,
        [
          transfer.transferId,
          invocation.invocationId,
          invocation.accountId,
          invocation.actor.id,
          invocation.authorization.grantId,
          invocation.idempotencyKey ?? null,
          invocationInputHash(invocation),
          invocation,
          transfer.args,
          transfer.status,
          transfer.bytesTransferred,
          transfer.createdAt,
          transfer.updatedAt,
          transfer.byteSize ?? null,
          transfer.chunkCount ?? null,
          transfer.contentSha256 ?? null
        ]
      );
      if (!inserted.rowCount) {
        const existing = await client.query(
          `SELECT * FROM adc_transfers WHERE invocation_id = $1 OR
           (account_id = $2 AND actor_id = $3 AND idempotency_key = $4)`,
          [
            invocation.invocationId,
            invocation.accountId,
            invocation.actor.id,
            invocation.idempotencyKey ?? null
          ]
        );
        if (existing.rows.length !== 1)
          throw new ProtocolError(ErrorCodes.CONFLICT, "Transfer key is unavailable.", false);
        const persisted = transferFromRow(existing.rows[0]!);
        assertSameInvocation(persisted.invocation, invocation);
        return persisted;
      }
      for (const [index, dispatch] of dispatches.entries()) {
        await insertDispatch(client, dispatch, audits[index]!, this.retention);
      }
      const updated =
        dispatches.length > 0
          ? await client.query(
              `UPDATE adc_transfers
               SET source_dispatch_id = $2, destination_dispatch_id = $3
               WHERE transfer_id = $1 RETURNING *`,
              [
                transfer.transferId,
                "nodeId" in transfer.args.source ? dispatches[0]!.dispatchId : null,
                dispatches.at(-1)!.dispatchId
              ]
            )
          : inserted;
      return transferFromRow(updated.rows[0]!);
    });
  }

  async approveAndStartTransfer(
    approvalId: string,
    transferId: string,
    dispatches: DispatchRecord[],
    audits: AuditEvent[],
    now: Date
  ): Promise<TransferRecord | undefined> {
    return transaction(this.pool, async (client) => {
      await storageLock(client);
      const account = await client.query(
        "SELECT account_id, invocation FROM adc_transfers WHERE transfer_id = $1",
        [transferId]
      );
      if (!account.rows[0]) return undefined;
      await lockStorageAccount(
        client,
        account.rows[0].account_id,
        account.rows[0].invocation.delegation?.resourceAccountId
      );
      const approvalResult = await client.query(
        "SELECT * FROM adc_approvals WHERE approval_id = $1 FOR UPDATE",
        [approvalId]
      );
      const transferResult = await client.query(
        "SELECT * FROM adc_transfers WHERE transfer_id = $1 FOR UPDATE",
        [transferId]
      );
      const approval = approvalResult.rows[0];
      const transfer = transferResult.rows[0];
      if (
        !approval ||
        !transfer ||
        approval.invocation_id !== transfer.invocation_id ||
        approval.status !== "pending" ||
        new Date(approval.expires_at) <= now ||
        transfer.status !== "awaiting_approval"
      )
        return;
      for (const [index, dispatch] of dispatches.entries()) {
        await insertDispatch(client, dispatch, audits[index]!, this.retention);
      }
      await client.query(
        `UPDATE adc_approvals SET status = 'approved', resolved_at = $2
         WHERE approval_id = $1`,
        [approvalId, now.toISOString()]
      );
      await client.query(
        `INSERT INTO adc_audit_events
         (event_id, account_id, invocation_id, event_type, payload, created_at)
         VALUES ($1, $2, $3, 'approval.approved', $4, $5)`,
        [
          createId("dsp"),
          transfer.account_id,
          transfer.invocation_id,
          { approvalId, transferId },
          now.toISOString()
        ]
      );
      const updated = await client.query(
        `UPDATE adc_transfers
         SET status = 'queued', source_dispatch_id = $2, destination_dispatch_id = $3,
             updated_at = $4
         WHERE transfer_id = $1 RETURNING *`,
        [
          transferId,
          "nodeId" in transfer.args.source ? dispatches[0]!.dispatchId : null,
          dispatches.at(-1)!.dispatchId,
          now.toISOString()
        ]
      );
      return transferFromRow(updated.rows[0]!);
    });
  }

  async getTransferById(transferId: string): Promise<TransferRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM adc_transfers WHERE transfer_id = $1", [
      transferId
    ]);
    return result.rows[0] ? transferFromRow(result.rows[0]) : undefined;
  }

  async getTransferByInvocation(invocationId: string): Promise<TransferRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM adc_transfers WHERE invocation_id = $1", [
      invocationId
    ]);
    return result.rows[0] ? transferFromRow(result.rows[0]) : undefined;
  }

  async getTransferByDispatch(dispatchId: string): Promise<TransferRecord | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM adc_transfers
       WHERE source_dispatch_id = $1 OR destination_dispatch_id = $1`,
      [dispatchId]
    );
    return result.rows[0] ? transferFromRow(result.rows[0]) : undefined;
  }

  async getTransferByIdempotency(
    accountId: string,
    actorId: string,
    key: string
  ): Promise<TransferRecord | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM adc_transfers WHERE account_id = $1 AND actor_id = $2 AND idempotency_key = $3",
      [accountId, actorId, key]
    );
    return result.rows[0] ? transferFromRow(result.rows[0]) : undefined;
  }

  async listTransferCleanupCandidates(before: Date, limit: number): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT transfer_id FROM adc_transfers
       WHERE storage_cleaned_at IS NULL AND CASE WHEN status IN ('succeeded', 'failed', 'denied', 'cancelled', 'unknown_outcome')
                  THEN COALESCE(completed_at, updated_at)
                  ELSE (invocation->>'expiresAt')::timestamptz END <= $1
       ORDER BY updated_at LIMIT $2`,
      [before.toISOString(), limit]
    );
    return result.rows.map((row) => row.transfer_id as string);
  }

  async markTransferCleaned(transferId: string): Promise<void> {
    await this.pool.query(
      "UPDATE adc_transfers SET storage_cleaned_at = NOW() WHERE transfer_id = $1",
      [transferId]
    );
  }

  async prepareTransfer(
    transferId: string,
    sourceNodeId: string,
    metadata: { byteSize: number; chunkCount: number }
  ): Promise<TransferRecord | undefined> {
    return transaction(this.pool, async (client) => {
      const current = await client.query(
        `SELECT * FROM adc_transfers
         WHERE transfer_id = $1 AND args->'source'->>'nodeId' = $2 FOR UPDATE`,
        [transferId, sourceNodeId]
      );
      const transfer = current.rows[0];
      if (!transfer || !["queued", "transferring", "verifying"].includes(transfer.status)) return;
      if (
        transfer.byte_size !== null &&
        (Number(transfer.byte_size) !== metadata.byteSize ||
          transfer.chunk_count !== metadata.chunkCount)
      ) {
        throw new ProtocolError(ErrorCodes.CONFLICT, "transfer metadata changed", false);
      }
      const result = await client.query(
        `UPDATE adc_transfers
         SET byte_size = $2, chunk_count = $3, status = 'transferring', updated_at = NOW()
         WHERE transfer_id = $1 RETURNING *`,
        [transferId, metadata.byteSize, metadata.chunkCount]
      );
      return transferFromRow(result.rows[0]!);
    });
  }

  async finalizeTransferSource(
    transferId: string,
    sourceNodeId: string,
    contentSha256: string
  ): Promise<TransferRecord | undefined> {
    return transaction(this.pool, async (client) => {
      const current = await client.query(
        `SELECT * FROM adc_transfers
         WHERE transfer_id = $1 AND args->'source'->>'nodeId' = $2 FOR UPDATE`,
        [transferId, sourceNodeId]
      );
      const transfer = current.rows[0];
      if (!transfer || !["transferring", "verifying"].includes(transfer.status)) return;
      if (transfer.content_sha256 && transfer.content_sha256 !== contentSha256) {
        throw new ProtocolError(ErrorCodes.CONFLICT, "transfer digest changed", false);
      }
      const result = await client.query(
        `UPDATE adc_transfers SET content_sha256 = $2, updated_at = NOW()
         WHERE transfer_id = $1 RETURNING *`,
        [transferId, contentSha256]
      );
      return transferFromRow(result.rows[0]!);
    });
  }

  async updateTransferProgress(
    transferId: string,
    destinationNodeId: string,
    bytesTransferred: number,
    status: "transferring" | "verifying" = "transferring"
  ): Promise<TransferRecord | undefined> {
    const result = await this.pool.query(
      `UPDATE adc_transfers
       SET bytes_transferred = GREATEST(bytes_transferred, $3),
           status = CASE WHEN status = 'verifying' THEN status ELSE $4 END,
           updated_at = NOW()
       WHERE transfer_id = $1 AND args->'destination'->>'nodeId' = $2
         AND byte_size IS NOT NULL AND $3 <= byte_size
         AND status NOT IN ('succeeded', 'failed', 'denied', 'cancelled', 'unknown_outcome')
       RETURNING *`,
      [transferId, destinationNodeId, bytesTransferred, status]
    );
    return result.rows[0] ? transferFromRow(result.rows[0]) : undefined;
  }

  async reconcileTransfer(dispatchId: string, now: Date): Promise<TransferRecord | undefined> {
    return transaction(this.pool, async (client) => {
      const current = await client.query(
        `SELECT * FROM adc_transfers
         WHERE source_dispatch_id = $1 OR destination_dispatch_id = $1 FOR UPDATE`,
        [dispatchId]
      );
      const transfer = current.rows[0];
      if (!transfer) return;
      const dispatches = await client.query(
        "SELECT dispatch_id, status, result FROM adc_dispatches WHERE dispatch_id = ANY($1::text[])",
        [[transfer.source_dispatch_id, transfer.destination_dispatch_id].filter(Boolean)]
      );
      const byId = new Map(dispatches.rows.map((row) => [row.dispatch_id, row]));
      const source = byId.get(transfer.source_dispatch_id);
      const destination = byId.get(transfer.destination_dispatch_id);
      let status = transfer.status as string;
      let error = transfer.error;
      if (destination?.status === "succeeded") {
        status = "succeeded";
      } else {
        const failed = [destination, source].find((candidate) =>
          ["failed", "denied", "cancelled", "unknown_outcome"].includes(candidate?.status ?? "")
        );
        if (failed) {
          status = failed.status;
          error = {
            code: failed.result?.error?.code ?? failed.status,
            message: failed.result?.error?.message ?? `transfer ${failed.status}`
          };
        }
      }
      const terminal = ["succeeded", "failed", "denied", "cancelled", "unknown_outcome"].includes(
        status
      );
      const updated = await client.query(
        `UPDATE adc_transfers
         SET status = $2,
             bytes_transferred = CASE WHEN $2 = 'succeeded' THEN COALESCE(byte_size, bytes_transferred)
                                      ELSE bytes_transferred END,
             error = $3, updated_at = $4,
             completed_at = CASE WHEN $5 THEN $4 ELSE completed_at END
         WHERE transfer_id = $1 RETURNING *`,
        [transfer.transfer_id, status, error ?? null, now.toISOString(), terminal]
      );
      return transferFromRow(updated.rows[0]!);
    });
  }

  async requestCancelTransfer(transferId: string, now: Date): Promise<TransferRecord | undefined> {
    return transaction(this.pool, async (client) => {
      const current = await client.query(
        "SELECT * FROM adc_transfers WHERE transfer_id = $1 FOR UPDATE",
        [transferId]
      );
      const transfer = current.rows[0];
      if (!transfer) return;
      const ids = [transfer.source_dispatch_id, transfer.destination_dispatch_id].filter(Boolean);
      if (ids.length) {
        await client.query(
          `UPDATE adc_dispatches
           SET status = CASE WHEN status IN ('queued', 'leased') THEN 'cancelled'
                             WHEN status = 'running' THEN 'cancel_requested' ELSE status END,
               updated_at = $2
           WHERE dispatch_id = ANY($1::text[])
             AND status IN ('queued', 'leased', 'running')`,
          [ids, now.toISOString()]
        );
      }
      const immediatelyCancelled = ["awaiting_approval", "queued"].includes(transfer.status);
      const updated = await client.query(
        `UPDATE adc_transfers SET status = CASE WHEN $2 THEN 'cancelled' ELSE status END,
         updated_at = $3, completed_at = CASE WHEN $2 THEN $3 ELSE completed_at END
         WHERE transfer_id = $1 RETURNING *`,
        [transferId, immediatelyCancelled, now.toISOString()]
      );
      return transferFromRow(updated.rows[0]!);
    });
  }

  async denyTransfer(transferId: string, now: Date): Promise<TransferRecord | undefined> {
    const result = await this.pool.query(
      `UPDATE adc_transfers SET status = 'denied', updated_at = $2, completed_at = $2
       WHERE transfer_id = $1 AND status = 'awaiting_approval' RETURNING *`,
      [transferId, now.toISOString()]
    );
    return result.rows[0] ? transferFromRow(result.rows[0]) : undefined;
  }

  async claim(nodeId: string, now: Date, leaseMs: number): Promise<DispatchRecord | undefined> {
    const leaseToken = randomBytes(24).toString("base64url");
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT dispatch_id FROM adc_dispatches
         WHERE node_id = $1 AND (
           status = 'queued' OR
           (status IN ('leased', 'running', 'cancel_requested') AND lease_expires_at <= $2)
         )
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE adc_dispatches d
       SET status = CASE WHEN d.status = 'queued' THEN 'leased' ELSE d.status END,
           lease_token = $3, lease_expires_at = $4, updated_at = $2
       FROM candidate
       WHERE d.dispatch_id = candidate.dispatch_id
       RETURNING d.*`,
      [nodeId, now.toISOString(), leaseToken, leaseExpiresAt.toISOString()]
    );
    return result.rows[0] ? dispatchFromRow(result.rows[0]) : undefined;
  }

  async acknowledge(
    dispatchId: string,
    leaseToken: string,
    now: Date
  ): Promise<DispatchRecord | undefined> {
    const result = await this.pool.query(
      `UPDATE adc_dispatches
       SET status = CASE WHEN status = 'cancel_requested' THEN status ELSE 'running' END,
           updated_at = $3
       WHERE dispatch_id = $1 AND status IN ('leased', 'running', 'cancel_requested') AND lease_token = $2
         AND lease_expires_at > $3
       RETURNING *`,
      [dispatchId, leaseToken, now.toISOString()]
    );
    return result.rows[0] ? dispatchFromRow(result.rows[0]) : undefined;
  }

  async renewLease(
    dispatchId: string,
    leaseToken: string,
    now: Date,
    leaseMs: number
  ): Promise<DispatchRecord | undefined> {
    const result = await this.pool.query(
      `UPDATE adc_dispatches
       SET lease_expires_at = $4, updated_at = $3
       WHERE dispatch_id = $1 AND status IN ('running', 'cancel_requested') AND lease_token = $2
         AND lease_expires_at > $3
       RETURNING *`,
      [dispatchId, leaseToken, now.toISOString(), new Date(now.getTime() + leaseMs).toISOString()]
    );
    return result.rows[0] ? dispatchFromRow(result.rows[0]) : undefined;
  }

  async complete(
    dispatchId: string,
    leaseToken: string,
    result: InvocationResult,
    receipt: Receipt | undefined,
    now: Date
  ): Promise<DispatchRecord | undefined> {
    return transaction(this.pool, async (client) => {
      await storageLock(client);
      const account = await client.query(
        "SELECT account_id, invocation FROM adc_dispatches WHERE dispatch_id = $1",
        [dispatchId]
      );
      if (!account.rows[0]) return undefined;
      await lockStorageAccount(
        client,
        account.rows[0].account_id,
        account.rows[0].invocation.delegation?.resourceAccountId,
        false
      );
      const current = await client.query(
        "SELECT * FROM adc_dispatches WHERE dispatch_id = $1 FOR UPDATE",
        [dispatchId]
      );
      const row = current.rows[0];
      if (!row) {
        return undefined;
      }
      if (["succeeded", "failed", "denied", "cancelled", "unknown_outcome"].includes(row.status)) {
        return dispatchFromRow(row);
      }
      if (row.lease_token !== leaseToken) {
        return undefined;
      }
      if (isSideEffectTool(row.invocation.tool) && !receipt) {
        throw new ProtocolError(
          ErrorCodes.INVALID_REQUEST,
          "side-effecting completion requires a receipt",
          false
        );
      }
      const status =
        result.status === "succeeded"
          ? "succeeded"
          : result.status === "cancelled"
            ? "cancelled"
            : result.status === "unknown_outcome"
              ? "unknown_outcome"
              : result.status === "denied"
                ? "denied"
                : "failed";
      const metadata = { ...result };
      delete metadata.output;
      assertMetadataBudget({ metadata, receipt }, this.retention);
      const bytes = jsonBytes(result.output);
      const hash = bodyHash(result.output);
      const reason =
        bytes > this.retention.maxResultBytes
          ? "size_exceeded"
          : !(await availableStorage(client, row.account_id, bytes, this.retention))
            ? "quota_exceeded"
            : undefined;
      const stored = reason ? retireResult(result, now, reason, bytes, hash) : result;
      const temporary =
        bytes > this.retention.maxMetadataBytes ||
        ["file.read", "screen.capture", "camera.capture"].includes(row.invocation.tool);
      const expiresAt = new Date(
        now.getTime() + (temporary ? this.retention.temporaryTtlMs : this.retention.detailTtlMs)
      ).toISOString();
      const updated = await client.query(
        `UPDATE adc_dispatches
         SET status = $3, result = $4, receipt = $5, updated_at = $6,
           result_bytes = $7, result_sha256 = $8, result_expires_at = $9,
           result_retired_at = $10, result_initialized = true
         WHERE dispatch_id = $1 AND lease_token = $2
         RETURNING *`,
        [
          dispatchId,
          leaseToken,
          status,
          stored,
          receipt ?? null,
          now.toISOString(),
          reason ? 0 : bytes,
          hash,
          expiresAt,
          reason ? now.toISOString() : null
        ]
      );
      await client.query(
        `UPDATE adc_artifacts SET expires_at = LEAST(expires_at, $2::timestamptz +
          $3 * interval '1 millisecond') WHERE invocation_id = $1 AND retired_at IS NULL`,
        [row.invocation_id, now.toISOString(), this.retention.temporaryTtlMs]
      );
      await client.query(
        `INSERT INTO adc_audit_events
         (event_id, account_id, invocation_id, event_type, payload, created_at)
         VALUES ($1, $2, $3, 'dispatch.completed', $4, $5)`,
        [
          createId("dsp"),
          row.account_id,
          row.invocation_id,
          { dispatchId, nodeId: row.node_id, status, receiptId: receipt?.receiptId },
          now.toISOString()
        ]
      );
      return dispatchFromRow(updated.rows[0]!);
    });
  }

  async requestCancel(dispatchId: string, now: Date): Promise<DispatchRecord | undefined> {
    const result = await this.pool.query(
      `UPDATE adc_dispatches
       SET status = CASE
             WHEN status IN ('queued', 'leased') THEN 'cancelled'
             ELSE 'cancel_requested'
           END,
           updated_at = $2
       WHERE dispatch_id = $1
         AND status NOT IN ('succeeded', 'failed', 'denied', 'cancelled', 'unknown_outcome')
       RETURNING *`,
      [dispatchId, now.toISOString()]
    );
    if (result.rows[0]) {
      return dispatchFromRow(result.rows[0]);
    }
    return this.getDispatchById(dispatchId);
  }

  async getDispatchById(dispatchId: string): Promise<DispatchRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM adc_dispatches WHERE dispatch_id = $1", [
      dispatchId
    ]);
    return result.rows[0] ? dispatchFromRow(result.rows[0]) : undefined;
  }

  async getDispatchByInvocation(invocationId: string): Promise<DispatchRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM adc_dispatches WHERE invocation_id = $1", [
      invocationId
    ]);
    return result.rows[0] ? dispatchFromRow(result.rows[0]) : undefined;
  }

  async listDispatchesByInvocationIds(
    accountId: string,
    invocationIds: string[]
  ): Promise<DispatchRecord[]> {
    if (!invocationIds.length) return [];
    const result = await this.pool.query(
      `SELECT * FROM adc_dispatches
       WHERE account_id = $1 AND invocation_id = ANY($2::text[])`,
      [accountId, invocationIds]
    );
    return result.rows.map(dispatchFromRow);
  }

  async listAudit(accountId: string, invocationId?: string): Promise<AuditEvent[]> {
    const result = invocationId
      ? await this.pool.query(
          `SELECT * FROM adc_audit_events
           WHERE account_id = $1 AND invocation_id = $2 ORDER BY created_at`,
          [accountId, invocationId]
        )
      : await this.pool.query(
          "SELECT * FROM adc_audit_events WHERE account_id = $1 ORDER BY created_at",
          [accountId]
        );
    return result.rows.map(auditFromRow);
  }

  async listAuditPage(accountId: string, options: AuditPageOptions): Promise<AuditPage> {
    const values: unknown[] = [accountId];
    const conditions = ["account_id = $1"];
    if (options.invocationId) {
      values.push(options.invocationId);
      conditions.push(`invocation_id = $${values.length}`);
    }
    if (options.eventTypePrefix) {
      values.push(options.eventTypePrefix);
      conditions.push(`split_part(event_type, '.', 1) = $${values.length}`);
    }
    if (options.before) {
      values.push(options.before.createdAt, options.before.itemId);
      conditions.push(
        `(created_at, event_id) < ($${values.length - 1}::timestamptz, $${values.length})`
      );
    }
    values.push(options.limit + 1);
    const result = await this.pool.query(
      `SELECT * FROM adc_audit_events
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, event_id DESC
       LIMIT $${values.length}`,
      values
    );
    const events = result.rows.slice(0, options.limit).map(auditFromRow);
    return {
      events,
      ...(result.rows.length > options.limit && events.length
        ? {
            nextCursor: {
              createdAt: events.at(-1)!.createdAt,
              itemId: events.at(-1)!.eventId
            }
          }
        : {})
    };
  }

  async getAccountResourceSummary(
    accountId: string,
    onlineAfter: string,
    now: string
  ): Promise<AccountResourceSummary> {
    const result = await this.pool.query<{
      active_nodes: string;
      online_nodes: string;
      active_grants: string;
      pending_approvals: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM adc_nodes
          WHERE account_id = $1 AND deleted_at IS NULL AND status = 'active')::text
           AS active_nodes,
         (SELECT COUNT(*) FROM adc_nodes
          WHERE account_id = $1 AND deleted_at IS NULL AND status = 'active'
            AND last_seen_at >= $2::timestamptz)::text AS online_nodes,
         (SELECT COUNT(*) FROM adc_agent_grants
          WHERE account_id = $1 AND deleted_at IS NULL AND revoked_at IS NULL)::text
           AS active_grants,
         (SELECT COUNT(*) FROM adc_approvals
          WHERE account_id = $1 AND status = 'pending'
            AND expires_at > $3::timestamptz)::text AS pending_approvals`,
      [accountId, onlineAfter, now]
    );
    const row = result.rows[0]!;
    return {
      activeNodes: Number(row.active_nodes),
      onlineNodes: Number(row.online_nodes),
      activeGrants: Number(row.active_grants),
      pendingApprovals: Number(row.pending_approvals)
    };
  }

  async putAudit(event: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO adc_audit_events
       (event_id, account_id, invocation_id, event_type, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.eventId,
        event.accountId,
        event.invocationId ?? null,
        event.type,
        event.payload,
        event.createdAt
      ]
    );
  }

  async putArtifact(artifact: ArtifactRecord, persistData?: () => Promise<void>): Promise<void> {
    await transaction(this.pool, async (client) => {
      await storageLock(client);
      const resource = await client.query("SELECT account_id FROM adc_nodes WHERE node_id = $1", [
        artifact.nodeId
      ]);
      await lockStorageAccount(
        client,
        artifact.accountId,
        resource.rows[0]?.account_id === artifact.accountId
          ? undefined
          : resource.rows[0]?.account_id,
        false
      );
      await client.query("SELECT 1 FROM adc_nodes WHERE node_id = $1 FOR KEY SHARE", [
        artifact.nodeId
      ]);
      const previous = await client.query(
        "SELECT * FROM adc_artifacts WHERE artifact_id = $1 FOR UPDATE",
        [artifact.artifactId]
      );
      if (previous.rows[0]) {
        const existing = previous.rows[0];
        if (
          existing.content_sha256 !== artifact.sha256 ||
          existing.account_id !== artifact.accountId ||
          existing.invocation_id !== artifact.invocationId ||
          existing.node_id !== artifact.nodeId ||
          Number(existing.byte_size) !== artifact.byteSize ||
          existing.content_type !== artifact.contentType
        ) {
          throw new ProtocolError(
            ErrorCodes.CONFLICT,
            "artifact id was already used with different content",
            false
          );
        }
        if (existing.retired_at)
          throw new ProtocolError(ErrorCodes.EXPIRED, "artifact content has expired", false);
        return;
      }
      const owner = await client.query(
        "SELECT * FROM adc_dispatches WHERE invocation_id = $1 FOR UPDATE",
        [artifact.invocationId]
      );
      if (
        owner.rows[0] &&
        !["queued", "leased", "running", "cancel_requested"].includes(owner.rows[0].status)
      ) {
        throw new ProtocolError(ErrorCodes.EXPIRED, "dispatch no longer accepts artifacts", false);
      }
      if (
        artifact.byteSize > this.retention.maxResultBytes ||
        !(await availableStorage(client, artifact.accountId, artifact.byteSize, this.retention))
      )
        throw quotaError();
      await persistData?.();
      await client.query(
        `INSERT INTO adc_artifacts
       (artifact_id, account_id, invocation_id, node_id, content_type, content_sha256,
        byte_size, data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (artifact_id) DO NOTHING`,
        [
          artifact.artifactId,
          artifact.accountId,
          artifact.invocationId,
          artifact.nodeId,
          artifact.contentType,
          artifact.sha256,
          artifact.byteSize,
          artifact.data,
          artifact.createdAt
        ]
      );
    });
  }

  async getArtifact(artifactId: string): Promise<ArtifactRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM adc_artifacts WHERE artifact_id = $1", [
      artifactId
    ]);
    const row = result.rows[0];
    return row
      ? {
          artifactId: row.artifact_id,
          accountId: row.account_id,
          invocationId: row.invocation_id,
          nodeId: row.node_id,
          contentType: row.content_type,
          sha256: row.content_sha256,
          byteSize: Number(row.byte_size),
          data: Buffer.from(row.data),
          createdAt: iso(row.created_at),
          ...(row.expires_at ? { expiresAt: iso(row.expires_at) } : {}),
          ...(row.consumed_at ? { consumedAt: iso(row.consumed_at) } : {}),
          ...(row.retired_at ? { retiredAt: iso(row.retired_at) } : {})
        }
      : undefined;
  }

  async consumeNodeNonce(nodeId: string, nonce: string, expiresAt: Date): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      await client.query("DELETE FROM adc_node_nonces WHERE expires_at <= NOW()");
      const result = await client.query(
        `INSERT INTO adc_node_nonces (node_id, nonce, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [nodeId, nonce, expiresAt.toISOString()]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}

async function insertAudit(client: PoolClient, event: AuditEvent) {
  await client.query(
    `INSERT INTO adc_audit_events (event_id, account_id, invocation_id, event_type, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      event.eventId,
      event.accountId,
      event.invocationId ?? null,
      event.type,
      event.payload,
      event.createdAt
    ]
  );
}

async function cancelResourceWork(
  client: PoolClient,
  accountId: string,
  kind: "node" | "grant",
  id: string,
  now: string
) {
  const predicate =
    kind === "node" ? "node_id = $2" : "invocation->'authorization'->>'grantId' = $2";
  await client.query(
    `UPDATE adc_dispatches SET status = CASE WHEN status IN ('queued', 'leased') THEN 'cancelled' ELSE 'cancel_requested' END,
     updated_at = $3 WHERE account_id = $1 AND ${predicate} AND status IN ('queued', 'leased', 'running')`,
    [accountId, id, now]
  );
  await client.query(
    `UPDATE adc_approvals SET status = 'denied', resolved_at = $3
     WHERE account_id = $1 AND ${predicate} AND status = 'pending'`,
    [accountId, id, now]
  );
}

async function insertDispatch(
  client: PoolClient,
  dispatch: DispatchRecord,
  audit: AuditEvent,
  policy = storagePolicy()
) {
  const invocation = dispatch.invocation;
  await storageLock(client);
  await lockStorageAccount(client, invocation.accountId, invocation.delegation?.resourceAccountId);
  assertMetadataBudget(
    { ...invocation, args: undefined, policy: dispatch.policyDecision, audit },
    policy
  );
  if (jsonBytes(invocation.args) > policy.maxInvocationBytes) {
    throw new ProtocolError(
      ErrorCodes.INVALID_REQUEST,
      "Invocation payload exceeds storage limit; use file.transfer for large files",
      false
    );
  }
  // Do not reject a replay for lack of capacity: its durable record already exists.
  const previous = await client.query(
    `SELECT * FROM adc_dispatches WHERE invocation_id = $1 OR
      (account_id = $2 AND actor_id = $3 AND idempotency_key = $4)`,
    [
      invocation.invocationId,
      invocation.accountId,
      invocation.actor.id,
      invocation.idempotencyKey ?? null
    ]
  );
  if (previous.rows.length) {
    if (previous.rows.length !== 1)
      throw new ProtocolError(ErrorCodes.CONFLICT, "Invocation key is unavailable", false);
    assertSameInvocation(previous.rows[0]!.invocation, invocation, previous.rows[0]!.input_hash);
    return dispatchFromRow(previous.rows[0]!);
  }
  if (
    !(await availableStorage(
      client,
      invocation.accountId,
      jsonBytes(invocation.args),
      policy,
      invocation.invocationId
    ))
  )
    throw quotaError();
  await assertDelegationCurrent(client, invocation, dispatch.nodeId);
  const inserted = await client.query(
    `INSERT INTO adc_dispatches
     (dispatch_id, invocation_id, account_id, actor_id, node_id, idempotency_key,
      input_hash, invocation, policy_decision, status, created_at, updated_at, input_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT DO NOTHING RETURNING *`,
    [
      dispatch.dispatchId,
      invocation.invocationId,
      invocation.accountId,
      invocation.actor.id,
      dispatch.nodeId,
      invocation.idempotencyKey ?? null,
      invocationInputHash(invocation),
      invocation,
      dispatch.policyDecision,
      dispatch.status,
      dispatch.createdAt,
      dispatch.updatedAt,
      jsonBytes(invocation.args)
    ]
  );
  if (!inserted.rowCount) {
    const existing = await client.query(
      `SELECT * FROM adc_dispatches WHERE invocation_id = $1 OR
       (account_id = $2 AND actor_id = $3 AND idempotency_key = $4)`,
      [
        invocation.invocationId,
        invocation.accountId,
        invocation.actor.id,
        invocation.idempotencyKey ?? null
      ]
    );
    if (existing.rows.length !== 1)
      throw new ProtocolError("conflict", "Invocation key is unavailable.", false);
    const persisted = dispatchFromRow(existing.rows[0]!);
    assertSameInvocation(persisted.invocation, invocation, existing.rows[0]!.input_hash);
    return persisted;
  }
  await client.query(
    `INSERT INTO adc_audit_events (event_id, account_id, invocation_id, event_type, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      audit.eventId,
      audit.accountId,
      audit.invocationId ?? null,
      audit.type,
      audit.payload,
      audit.createdAt
    ]
  );
  return dispatchFromRow(inserted.rows[0]!);
}

/** Serializes admission with relationship revocation across control-plane replicas. */
async function assertDelegationCurrent(
  client: PoolClient,
  invocation: import("@adc/protocol").Invocation,
  nodeId: string
) {
  const delegation = invocation.delegation;
  if (!delegation) return;
  await lockStorageAccount(client, invocation.accountId, delegation.resourceAccountId);
  const deny = () => new ProtocolError("denied", "Resource authorization changed.", false);
  if (Date.parse(delegation.expiresAt) <= Date.now()) throw deny();
  const node = await client.query("SELECT * FROM adc_nodes WHERE node_id = $1 FOR SHARE", [nodeId]);
  if (
    !node.rows[0] ||
    node.rows[0].status !== "active" ||
    node.rows[0].deleted_at ||
    node.rows[0].account_id !== delegation.resourceAccountId ||
    node.rows[0].resource_class !== "physical"
  )
    throw deny();
  const grant = await client.query("SELECT * FROM adc_agent_grants WHERE grant_id = $1 FOR SHARE", [
    invocation.authorization.grantId
  ]);
  if (
    !grant.rows[0] ||
    grant.rows[0].revoked_at ||
    grant.rows[0].revision !== delegation.grantRevision ||
    grant.rows[0].account_id !== invocation.accountId ||
    grant.rows[0].responsible_user_id !== delegation.requesterUserId
  )
    throw deny();
  if (delegation.bindingId) {
    const binding = await client.query(
      "SELECT * FROM adc_resource_bindings WHERE binding_id = $1 FOR SHARE",
      [delegation.bindingId]
    );
    const row = binding.rows[0];
    if (
      !row ||
      row.state !== "active" ||
      row.revision !== delegation.bindingRevision ||
      (delegation.bindingKind === "team" && row.kind !== "team") ||
      row.node_id !== nodeId ||
      row.recipient_account_id !== invocation.accountId ||
      row.resource_account_id !== delegation.resourceAccountId ||
      (row.kind === "share" && row.recipient_user_id !== delegation.requesterUserId) ||
      (row.record.expiresAt && Date.parse(row.record.expiresAt) <= Date.now())
    )
      throw deny();
  }
  if (delegation.membershipRevision) {
    const member = await client.query(
      "SELECT * FROM adc_team_members WHERE account_id = $1 AND user_id = $2 FOR SHARE",
      [invocation.accountId, delegation.requesterUserId]
    );
    if (
      !member.rows[0] ||
      member.rows[0].state !== "active" ||
      member.rows[0].revision !== delegation.membershipRevision
    )
      throw deny();
  }
}
