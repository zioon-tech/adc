import type { Pool, PoolClient, QueryResultRow } from "pg";
import { ProtocolError } from "@adc/protocol";
import type { AgentGrantRecord, AuditEvent, ProjectRecord, RootBindingRecord } from "./types.ts";

const conflict = (message: string): never => { throw new ProtocolError("conflict", message, false); };
const changed = () => conflict("Project changed. Refresh and try again.");
const unused = () => conflict("Remove the affected Agent authorizations before changing or deleting this resource.");

export function projectFromRow(row: QueryResultRow): ProjectRecord {
  return { projectId: row.project_id, accountId: row.account_id, label: row.label, revision: row.revision,
    createdAt: new Date(row.created_at).toISOString(), ...(row.deleted_at ? { deletedAt: new Date(row.deleted_at).toISOString() } : {}) };
}
export function rootFromRow(row: QueryResultRow): RootBindingRecord {
  return { rootId: row.root_id, projectId: row.project_id, nodeId: row.node_id, label: row.label,
    writable: row.writable, revision: row.revision, createdAt: new Date(row.created_at).toISOString(),
    ...(row.deleted_at ? { deletedAt: new Date(row.deleted_at).toISOString() } : {}) };
}

async function lockProject(client: PoolClient, projectId: string, accountId?: string, revision?: number) {
  const result = await client.query("SELECT * FROM adc_projects WHERE project_id = $1 FOR UPDATE", [projectId]);
  const row = result.rows[0];
  if (!row || row.deleted_at || accountId !== undefined && row.account_id !== accountId || revision !== undefined && row.revision !== revision) changed();
  return row!;
}
async function assertUnused(client: PoolClient, projectId: string, rootId?: string) {
  const result = await client.query(
    `SELECT 1 FROM adc_agent_grants WHERE project_id = $1 AND revoked_at IS NULL AND deleted_at IS NULL
     AND ($2::text IS NULL OR root_ids ? $2) LIMIT 1`, [projectId, rootId ?? null]);
  if (result.rowCount) unused();
}
async function auditEvent(client: PoolClient, event?: AuditEvent) {
  if (event) await client.query(
    "INSERT INTO adc_audit_events (event_id, account_id, event_type, payload, created_at) VALUES ($1,$2,$3,$4,$5)",
    [event.eventId, event.accountId, event.type, event.payload, event.createdAt]);
}
async function mutate<T>(pool: Pool, action: (client: PoolClient) => Promise<T>, duplicateMessage: string): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error: any) {
    await client.query("ROLLBACK");
    if (error?.code === "23505") conflict(duplicateMessage);
    throw error;
  } finally { client.release(); }
}

/** Hold the project lock through the grant write so deletion and grant creation cannot race. */
export async function lockProjectGrant(client: PoolClient, grant: AgentGrantRecord) {
  if (!grant.projectId) return;
  await lockProject(client, grant.projectId, grant.accountId);
  const roots = await client.query("SELECT root_id, node_id FROM adc_roots WHERE project_id = $1 AND deleted_at IS NULL", [grant.projectId]);
  if (grant.rootAccess === "all" || grant.rootIds.some(rootId => !roots.rows.some(root => root.root_id === rootId && grant.nodeIds.includes(root.node_id))))
    conflict("Project folders changed. Refresh and try again.");
}

export class ProjectManagement {
  constructor(private readonly pool: Pool) {}

  putProject(project: ProjectRecord, createOnly: boolean, audit?: AuditEvent) {
    return mutate(this.pool, async client => {
      const result = await client.query(
        `INSERT INTO adc_projects (project_id, account_id, label, created_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (project_id) DO UPDATE SET label = EXCLUDED.label, revision = adc_projects.revision + 1
         WHERE adc_projects.account_id = EXCLUDED.account_id AND adc_projects.deleted_at IS NULL AND NOT $5 RETURNING *`,
        [project.projectId, project.accountId, project.label, project.createdAt, createOnly]);
      if (!result.rowCount) conflict("Project ID is unavailable.");
      await auditEvent(client, audit);
    }, "A project with this name already exists.");
  }

  updateProject(accountId: string, projectId: string, label: string, revision: number, audit: AuditEvent) {
    return mutate(this.pool, async client => {
      await lockProject(client, projectId, accountId, revision);
      const result = await client.query("UPDATE adc_projects SET label = $2, revision = revision + 1 WHERE project_id = $1 RETURNING *", [projectId, label]);
      await auditEvent(client, audit);
      return projectFromRow(result.rows[0]!);
    }, "A project with this name already exists.");
  }

  deleteProject(accountId: string, projectId: string, revision: number, audit: AuditEvent) {
    return mutate(this.pool, async client => {
      await lockProject(client, projectId, accountId, revision);
      await assertUnused(client, projectId);
      await client.query("UPDATE adc_projects SET deleted_at = $2, revision = revision + 1 WHERE project_id = $1", [projectId, audit.createdAt]);
      await client.query("UPDATE adc_roots SET deleted_at = $2, revision = revision + 1 WHERE project_id = $1 AND deleted_at IS NULL", [projectId, audit.createdAt]);
      await auditEvent(client, audit);
    }, "Project ID is unavailable.");
  }

  putRoot(root: RootBindingRecord, createOnly: boolean, audit?: AuditEvent) {
    return mutate(this.pool, async client => {
      const before = await client.query("SELECT project_id FROM adc_roots WHERE root_id = $1", [root.rootId]);
      const previousProjectId = before.rows[0]?.project_id as string | undefined;
      // Lock both groups in a stable order when restoring a removed folder into another project.
      for (const projectId of [...new Set([root.projectId, previousProjectId].filter((id): id is string => !!id))].sort()) {
        if (projectId === root.projectId) await lockProject(client, projectId);
        else await client.query("SELECT project_id FROM adc_projects WHERE project_id = $1 FOR UPDATE", [projectId]);
      }
      const previous = await client.query("SELECT * FROM adc_roots WHERE root_id = $1 FOR UPDATE", [root.rootId]);
      const existing = previous.rows[0];
      if (existing && (existing.project_id !== previousProjectId || existing.node_id !== root.nodeId || !existing.deleted_at && (createOnly || existing.project_id !== root.projectId)))
        conflict("Folder is already bound to a project or device.");
      if (existing && (existing.deleted_at || existing.writable !== root.writable)) await assertUnused(client, existing.project_id, root.rootId);
      const result = await client.query(
        `INSERT INTO adc_roots (root_id, project_id, node_id, label, writable, created_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (root_id) DO UPDATE SET label = EXCLUDED.label, writable = EXCLUDED.writable,
           project_id = EXCLUDED.project_id, deleted_at = NULL, revision = adc_roots.revision + 1
         WHERE (adc_roots.project_id = EXCLUDED.project_id OR adc_roots.deleted_at IS NOT NULL)
           AND adc_roots.node_id = EXCLUDED.node_id RETURNING *`,
        [root.rootId, root.projectId, root.nodeId, root.label, root.writable, root.createdAt]);
      if (!result.rowCount) conflict("Folder is already bound to a project or device.");
      await auditEvent(client, audit);
      return rootFromRow(result.rows[0]!);
    }, "A folder with this name already exists on this device.");
  }

  updateRoot(accountId: string, projectId: string, rootId: string, changes: { label: string; writable: boolean }, revision: number, audit: AuditEvent) {
    return mutate(this.pool, async client => {
      await lockProject(client, projectId, accountId);
      const previous = await client.query("SELECT * FROM adc_roots WHERE project_id = $1 AND root_id = $2 AND deleted_at IS NULL AND revision = $3 FOR UPDATE", [projectId, rootId, revision]);
      if (!previous.rowCount) conflict("Folder changed. Refresh and try again.");
      if (previous.rows[0]!.writable !== changes.writable) await assertUnused(client, projectId, rootId);
      const result = await client.query("UPDATE adc_roots SET label = $2, writable = $3, revision = revision + 1 WHERE root_id = $1 RETURNING *", [rootId, changes.label, changes.writable]);
      await auditEvent(client, audit);
      return rootFromRow(result.rows[0]!);
    }, "A folder with this name already exists on this device.");
  }

  deleteRoot(accountId: string, projectId: string, rootId: string, revision: number, audit: AuditEvent) {
    return mutate(this.pool, async client => {
      await lockProject(client, projectId, accountId);
      await assertUnused(client, projectId, rootId);
      const result = await client.query("UPDATE adc_roots SET deleted_at = $4, revision = revision + 1 WHERE project_id = $1 AND root_id = $2 AND revision = $3 AND deleted_at IS NULL", [projectId, rootId, revision, audit.createdAt]);
      if (!result.rowCount) conflict("Folder changed. Refresh and try again.");
      await auditEvent(client, audit);
    }, "Folder is unavailable.");
  }
}
