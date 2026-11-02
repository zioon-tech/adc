import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createId, ProtocolError, type CollaborationScope } from "@adc/protocol";
import { hashToken } from "./identity-store.ts";
import { consentIsAuthorized } from "./consent-authority.ts";
import type {
  CollaborationInvitation, ResourceBinding, TeamAccount, TeamMembership, TeamRole
} from "./types.ts";

export const normalizeInvitationEmail = (email: string) => email.trim().toLowerCase();
const missing = () => new ProtocolError("not_found", "Collaboration resource was not found.", false);
const conflict = () => new ProtocolError("conflict", "Permissions changed. Refresh and try again.", false);
const denied = () => new ProtocolError("denied", "This operation is not permitted.", false);
const iso = (value: Date | string) => new Date(value).toISOString();

function membership(row: Record<string, any>): TeamMembership {
  return {
    accountId: row.account_id, userId: row.user_id, role: row.role,
    state: row.state, revision: row.revision, rules: row.rules, createdAt: iso(row.created_at)
  };
}

/** All relationship mutations, their audit and invalidation commit together. */
export class CollaborationStore {
  constructor(readonly pool: Pool) {}

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") throw conflict();
      throw error;
    } finally {
      client.release();
    }
  }

  private async event(
    client: PoolClient, accountId: string, userId: string, type: string, payload: Record<string, unknown>
  ) {
    const eventId = createId("dsp");
    await client.query(
      `INSERT INTO adc_audit_events(event_id, account_id, event_type, payload, created_at)
       VALUES ($1, $2, $3, $4, NOW())`, [eventId, accountId, type, { ...payload, userId }]
    );
    await client.query(
      `INSERT INTO adc_collaboration_outbox(event_id, account_id, user_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5)`, [eventId, accountId, userId, type, payload]
    );
  }

  async accountKind(accountId: string): Promise<"personal" | "team" | undefined> {
    const result = await this.pool.query("SELECT kind FROM adc_accounts WHERE account_id = $1", [accountId]);
    return result.rows[0]?.kind;
  }

  async member(accountId: string, userId: string): Promise<TeamMembership | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM adc_team_members WHERE account_id = $1 AND user_id = $2 AND state = 'active'",
      [accountId, userId]
    );
    return result.rows[0] ? membership(result.rows[0]) : undefined;
  }

  private async manager(client: PoolClient, accountId: string, userId: string, ownerOnly = false) {
    // Account lock also serializes invite acceptance against membership removal.
    const account = await client.query("SELECT * FROM adc_accounts WHERE account_id = $1 FOR UPDATE", [accountId]);
    const row = account.rows[0];
    if (!row) throw missing();
    if (row.kind === "personal") {
      if (row.user_id !== userId) throw denied();
      return;
    }
    const members = await client.query(
      "SELECT * FROM adc_team_members WHERE account_id = $1 AND user_id = $2 AND state = 'active' FOR UPDATE",
      [accountId, userId]
    );
    if (!members.rows[0] || !(ownerOnly ? ["owner"] : ["owner", "admin"]).includes(members.rows[0].role))
      throw denied();
  }

  async listTeams(userId: string): Promise<TeamAccount[]> {
    const result = await this.pool.query(
      `SELECT m.*, a.name FROM adc_team_members m JOIN adc_accounts a ON a.account_id = m.account_id
       WHERE m.user_id = $1 AND m.state = 'active' AND a.kind = 'team' ORDER BY m.created_at`, [userId]
    );
    return result.rows.map((row) => ({
      accountId: row.account_id, kind: "team", name: row.name, membership: membership(row)
    }));
  }

  async createTeam(userId: string, name: string): Promise<TeamAccount> {
    return this.transaction(async (client) => {
      const accountId = createId("acct");
      await client.query(
        "INSERT INTO adc_accounts(account_id, kind, name, created_at) VALUES ($1, 'team', $2, NOW())",
        [accountId, name]
      );
      const result = await client.query(
        `INSERT INTO adc_team_members(account_id, user_id, role, state)
         VALUES ($1, $2, 'owner', 'active') RETURNING *`, [accountId, userId]
      );
      await this.event(client, accountId, userId, "team.created", { name });
      return { accountId, kind: "team", name, membership: membership(result.rows[0]!) };
    });
  }

  async listMembers(accountId: string, userId: string) {
    if (!await this.member(accountId, userId)) throw missing();
    const result = await this.pool.query(
      `SELECT m.*, u.name, u.email FROM adc_team_members m
       LEFT JOIN adc_auth_users u ON u.id = m.user_id
       WHERE m.account_id = $1 ORDER BY m.created_at`, [accountId]
    );
    return result.rows.map((row) => ({
      ...membership(row), name: row.name ?? "", email: row.email ?? ""
    }));
  }

  async changeMember(
    accountId: string, actorUserId: string, userId: string, revision: number,
    changes: { role: TeamRole; state: "active" | "removed"; rules: TeamMembership["rules"] }
  ): Promise<TeamMembership> {
    return this.transaction(async (client) => {
      await this.manager(client, accountId, actorUserId, changes.role === "admin");
      const current = await client.query(
        "SELECT * FROM adc_team_members WHERE account_id = $1 AND user_id = $2 FOR UPDATE", [accountId, userId]
      );
      if (!current.rows[0]) throw missing();
      if (current.rows[0].role === "owner" &&
          (changes.role !== "owner" || changes.state !== "active" || userId !== actorUserId)) throw denied();
      if (changes.role === "owner") await this.manager(client, accountId, actorUserId, true);
      if (changes.role === "owner" && current.rows[0].role !== "owner") throw denied();
      // Admins cannot alter another admin or restore a removed membership.
      if (current.rows[0].role === "admin") await this.manager(client, accountId, actorUserId, true);
      if (current.rows[0].revision !== revision || current.rows[0].state !== "active") throw conflict();
      const updated = await client.query(
        `UPDATE adc_team_members SET role = $3, state = $4, rules = $5, revision = revision + 1
         WHERE account_id = $1 AND user_id = $2 RETURNING *`,
        [accountId, userId, changes.role, changes.state, JSON.stringify(changes.rules)]
      );
      if (changes.state === "removed") {
        await client.query(
          `UPDATE adc_agent_grants SET revoked_at = COALESCE(revoked_at, NOW()), revision = revision + 1
           WHERE account_id = $1 AND responsible_user_id = $2`, [accountId, userId]
        );
      }
      await this.invalidate(client, { accountId, userId });
      await this.event(client, accountId, actorUserId, "team.member.updated", { memberUserId: userId, ...changes });
      return membership(updated.rows[0]!);
    });
  }

  async leaveTeam(accountId: string, userId: string, revision: number) {
    return this.transaction(async (client) => {
      await client.query("SELECT account_id FROM adc_accounts WHERE account_id = $1 FOR UPDATE", [accountId]);
      const changed = await client.query(
        `UPDATE adc_team_members SET state = 'removed', revision = revision + 1
         WHERE account_id = $1 AND user_id = $2 AND revision = $3 AND state = 'active'
           AND role <> 'owner' RETURNING *`, [accountId, userId, revision]
      );
      if (!changed.rows[0]) throw conflict();
      await client.query(
        `UPDATE adc_agent_grants SET revoked_at = COALESCE(revoked_at, NOW()), revision = revision + 1
         WHERE account_id = $1 AND responsible_user_id = $2`, [accountId, userId]
      );
      await this.invalidate(client, { accountId, userId });
      await this.event(client, accountId, userId, "team.member.left", {});
      return membership(changed.rows[0]);
    });
  }

  async getBinding(bindingId: string): Promise<ResourceBinding | undefined> {
    const result = await this.pool.query("SELECT record FROM adc_resource_bindings WHERE binding_id = $1", [bindingId]);
    return result.rows[0]?.record;
  }

  async bindings(accountId: string, direction: "received" | "owned"): Promise<ResourceBinding[]> {
    const result = await this.pool.query(
      `SELECT record FROM adc_resource_bindings WHERE ${direction === "received" ? "recipient_account_id" : "resource_account_id"} = $1
       ORDER BY record->>'createdAt' DESC`, [accountId]
    );
    return result.rows.map((row) => row.record);
  }

  private async saveBinding(client: PoolClient, binding: ResourceBinding) {
    await client.query(
      `INSERT INTO adc_resource_bindings(binding_id, kind, node_id, resource_account_id,
        recipient_account_id, recipient_user_id, state, revision, record)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(binding_id) DO UPDATE SET state = EXCLUDED.state, revision = EXCLUDED.revision,
         record = EXCLUDED.record`,
      [binding.bindingId, binding.kind, binding.nodeId, binding.resourceAccountId,
        binding.recipientAccountId, binding.recipientUserId ?? null, binding.state, binding.revision, binding]
    );
    await client.query(
      "INSERT INTO adc_binding_revisions(binding_id, revision, record) VALUES ($1,$2,$3)",
      [binding.bindingId, binding.revision, binding]
    );
  }

  async linkTeamDevice(
    actorUserId: string, resourceAccountId: string, teamAccountId: string, nodeId: string,
    scope: CollaborationScope
  ): Promise<ResourceBinding> {
    return this.transaction(async (client) => {
      // Stable account order avoids two teams linking devices to each other deadlocking.
      for (const id of [...new Set([resourceAccountId, teamAccountId])].sort())
        await this.manager(client, id, actorUserId);
      const team = await client.query("SELECT kind FROM adc_accounts WHERE account_id = $1", [teamAccountId]);
      if (team.rows[0]?.kind !== "team" || teamAccountId === resourceAccountId) throw denied();
      const nodes = await client.query(
        `SELECT node_id FROM adc_nodes WHERE node_id = $1 AND account_id = $2
         AND status = 'active' AND deleted_at IS NULL FOR UPDATE`, [nodeId, resourceAccountId]
      );
      if (!nodes.rows[0]) throw missing();
      const binding: ResourceBinding = {
        bindingId: `binding_${randomBytes(16).toString("hex")}`, kind: "team", nodeId,
        resourceAccountId, recipientAccountId: teamAccountId, scope,
        expiresAt: null, revision: 1, state: "active", createdAt: new Date().toISOString()
      };
      await this.saveBinding(client, binding);
      await this.event(client, resourceAccountId, actorUserId, "team.device.linked", { bindingId: binding.bindingId, teamAccountId, nodeId });
      return binding;
    });
  }

  private async saveInvitation(client: PoolClient, invitation: CollaborationInvitation, tokenHash?: string) {
    if (tokenHash) {
      await client.query(
        `INSERT INTO adc_collaboration_invitations(invitation_id, sender_account_id, recipient_email,
          token_hash, state, revision, expires_at, record) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [invitation.invitationId, invitation.senderAccountId, invitation.recipientEmail,
          tokenHash, invitation.state, invitation.revision, invitation.expiresAt, invitation]
      );
    } else {
      await client.query(
        `UPDATE adc_collaboration_invitations SET state = $2, revision = $3, record = $4
         WHERE invitation_id = $1`,
        [invitation.invitationId, invitation.state, invitation.revision, invitation]
      );
    }
  }

  async invite(input: Omit<CollaborationInvitation, "invitationId" | "state" | "revision" | "createdAt">) {
    return this.transaction(async (client) => {
      await this.manager(client, input.senderAccountId, input.senderUserId, input.role === "admin");
      if (input.kind === "member") {
        if (input.teamAccountId !== input.senderAccountId) throw denied();
        const team = await client.query("SELECT kind FROM adc_accounts WHERE account_id = $1", [input.teamAccountId]);
        if (team.rows[0]?.kind !== "team") throw denied();
      } else {
        const node = await client.query(
          `SELECT node_id FROM adc_nodes WHERE node_id = $1 AND account_id = $2
           AND status = 'active' AND deleted_at IS NULL FOR UPDATE`, [input.nodeId, input.senderAccountId]
        );
        if (!node.rows[0]) throw missing();
      }
      const invitation: CollaborationInvitation = {
        ...input, recipientEmail: normalizeInvitationEmail(input.recipientEmail),
        invitationId: `invite_${randomBytes(16).toString("hex")}`, state: "pending",
        revision: 1, createdAt: new Date().toISOString()
      };
      const token = randomBytes(32).toString("base64url");
      await this.saveInvitation(client, invitation, hashToken(token));
      await this.event(client, input.senderAccountId, input.senderUserId, "collaboration.invited", {
        invitationId: invitation.invitationId, kind: input.kind, recipientEmail: invitation.recipientEmail
      });
      return { invitation, token };
    });
  }

  async invitations(accountId: string, verifiedEmail?: string, userId?: string) {
    const result = await this.pool.query(
      `SELECT record FROM adc_collaboration_invitations
       WHERE sender_account_id = $1 OR recipient_email = $2 OR record->>'targetUserId' = $3
       ORDER BY record->>'createdAt' DESC`,
      [accountId, verifiedEmail ? normalizeInvitationEmail(verifiedEmail) : null, userId ?? null]
    );
    return result.rows.map((row) => row.record as CollaborationInvitation);
  }

  async invitationPreview(invitationId: string, email: string, token?: string, userId?: string) {
    const result = await this.pool.query(
      `SELECT i.record, a.name AS sender_name, t.name AS team_name, n.label AS node_label
       FROM adc_collaboration_invitations i
       JOIN adc_accounts a ON a.account_id = i.sender_account_id
       LEFT JOIN adc_accounts t ON t.account_id = i.record->>'teamAccountId'
       LEFT JOIN adc_nodes n ON n.node_id = i.record->>'nodeId'
       WHERE i.invitation_id = $1
       AND ((i.record->>'targetUserId' IS NULL AND i.recipient_email = $2) OR i.record->>'targetUserId' = $4)
       AND i.state = 'pending' AND i.expires_at > NOW()
       AND ($3::text IS NULL OR i.token_hash = $3)`,
      [invitationId, normalizeInvitationEmail(email), token ? hashToken(token) : null, userId ?? null]
    );
    if (!result.rows[0]) throw missing();
    const row = result.rows[0];
    return { ...row.record as CollaborationInvitation, senderName: row.sender_name,
      ...(row.team_name ? { teamName: row.team_name } : {}), ...(row.node_label ? { nodeLabel: row.node_label } : {}) };
  }

  async respondInvitation(
    invitationId: string, user: { userId: string; accountId: string; verifiedEmail: string },
    revision: number, decision: "accept" | "decline", token?: string
  ): Promise<{ invitation: CollaborationInvitation; binding?: ResourceBinding; membership?: TeamMembership }> {
    return this.transaction(async (client) => {
      // Lock source account before invitation to match all manager mutations.
      const source = await client.query(
        "SELECT sender_account_id FROM adc_collaboration_invitations WHERE invitation_id = $1", [invitationId]
      );
      if (!source.rows[0]) throw missing();
      await client.query("SELECT account_id FROM adc_accounts WHERE account_id = $1 FOR UPDATE", [source.rows[0].sender_account_id]);
      const result = await client.query(
        `SELECT * FROM adc_collaboration_invitations WHERE invitation_id = $1
         AND (recipient_email = $2 OR record->>'targetUserId' = $4)
         AND ($3::text IS NULL OR token_hash = $3) FOR UPDATE`,
        [invitationId, normalizeInvitationEmail(user.verifiedEmail), token ? hashToken(token) : null, user.userId]
      );
      const row = result.rows[0];
      if (!row) throw missing();
      let invitation = row.record as CollaborationInvitation;
      if (invitation.targetUserId && invitation.targetUserId !== user.userId) throw missing();
      if (invitation.state === "accepted" && invitation.acceptedUserId === user.userId && decision === "accept")
        return {
          invitation,
          ...(invitation.acceptedBindingId ? { binding: await this.bindingIn(client, invitation.acceptedBindingId) } : {})
        };
      if (invitation.state !== "pending" || row.revision !== revision || new Date(row.expires_at).getTime() <= Date.now())
        throw conflict();
      await this.manager(client, invitation.senderAccountId, invitation.senderUserId, invitation.role === "admin");
      let acceptedBinding: ResourceBinding | undefined;
      let acceptedMember: TeamMembership | undefined;
      if (decision === "accept" && invitation.kind === "member") {
        const inserted = await client.query(
          `INSERT INTO adc_team_members(account_id, user_id, role, state)
           VALUES ($1,$2,$3,'active')
           ON CONFLICT(account_id, user_id) DO UPDATE SET state = 'active', role = EXCLUDED.role,
             rules = '[]'::jsonb, revision = adc_team_members.revision + 1
           WHERE adc_team_members.state = 'removed' RETURNING *`,
          [invitation.teamAccountId, user.userId, invitation.role ?? "member"]
        );
        if (!inserted.rows[0]) throw conflict();
        acceptedMember = membership(inserted.rows[0]);
      } else if (decision === "accept") {
        const node = await client.query(
          `SELECT node_id FROM adc_nodes WHERE node_id = $1 AND account_id = $2
           AND status = 'active' AND deleted_at IS NULL FOR UPDATE`, [invitation.nodeId, invitation.senderAccountId]
        );
        if (!node.rows[0] || !invitation.scope || invitation.senderAccountId === user.accountId) throw denied();
        const expiresAt = invitation.kind === "scope" ? invitation.bindingExpiresAt ?? null
          : invitation.durationDays == null ? null
          : new Date(Date.now() + invitation.durationDays * 86_400_000).toISOString();
        if (invitation.kind === "scope") {
          const previous = await this.bindingIn(client, invitation.bindingId!, true);
          if (previous.state !== "active" || previous.revision !== invitation.bindingRevision ||
              previous.recipientUserId !== user.userId || previous.recipientAccountId !== user.accountId ||
              (previous.expiresAt && Date.parse(previous.expiresAt) <= Date.now()) ||
              (expiresAt && Date.parse(expiresAt) <= Date.now())) throw conflict();
          acceptedBinding = { ...previous, scope: invitation.scope, expiresAt, revision: previous.revision + 1 };
          await this.invalidate(client, { bindingId: previous.bindingId });
        } else {
          acceptedBinding = {
            bindingId: `binding_${randomBytes(16).toString("hex")}`, kind: "share",
            nodeId: invitation.nodeId!, resourceAccountId: invitation.senderAccountId,
            recipientAccountId: user.accountId, recipientUserId: user.userId,
            scope: invitation.scope, expiresAt, revision: 1, state: "active", createdAt: new Date().toISOString()
          };
        }
        await this.saveBinding(client, acceptedBinding);
      }
      invitation = {
        ...invitation, state: decision === "accept" ? "accepted" : "declined",
        revision: invitation.revision + 1, acceptedUserId: user.userId, acceptedAccountId: user.accountId,
        ...(acceptedBinding ? { acceptedBindingId: acceptedBinding.bindingId } : {})
      };
      await this.saveInvitation(client, invitation);
      await this.event(client, invitation.senderAccountId, user.userId, `collaboration.${invitation.state}`, {
        invitationId, ...(acceptedBinding ? { bindingId: acceptedBinding.bindingId } : {})
      });
      return { invitation, ...(acceptedBinding ? { binding: acceptedBinding } : {}),
        ...(acceptedMember ? { membership: acceptedMember } : {}) };
    });
  }

  private async bindingIn(client: PoolClient, bindingId: string, lock = false): Promise<ResourceBinding> {
    const result = await client.query(
      `SELECT record FROM adc_resource_bindings WHERE binding_id = $1${lock ? " FOR UPDATE" : ""}`, [bindingId]
    );
    if (!result.rows[0]) throw missing();
    return result.rows[0].record;
  }

  async revokeInvitation(accountId: string, userId: string, invitationId: string, revision: number) {
    return this.transaction(async (client) => {
      await this.manager(client, accountId, userId);
      const result = await client.query(
        "SELECT record FROM adc_collaboration_invitations WHERE invitation_id = $1 AND sender_account_id = $2 FOR UPDATE",
        [invitationId, accountId]
      );
      const previous = result.rows[0]?.record as CollaborationInvitation | undefined;
      if (!previous) throw missing();
      if (previous.state !== "pending" || previous.revision !== revision) throw conflict();
      const invitation = { ...previous, state: "revoked" as const, revision: revision + 1 };
      await this.saveInvitation(client, invitation);
      await this.event(client, accountId, userId, "collaboration.invitation.revoked", { invitationId });
      return invitation;
    });
  }

  async changeBinding(
    accountId: string, userId: string, bindingId: string, revision: number,
    changes: { scope?: CollaborationScope; expiresAt?: string | null; state?: ResourceBinding["state"] },
    leave = false, requireRecipientManager = false
  ): Promise<ResourceBinding> {
    return this.transaction(async (client) => {
      const source = await this.bindingIn(client, bindingId);
      if (!leave) {
        if (source.resourceAccountId !== accountId) throw missing();
        if (source.kind === "team") for (const locked of [...new Set([source.resourceAccountId, source.recipientAccountId])].sort())
          await client.query("SELECT account_id FROM adc_accounts WHERE account_id = $1 FOR UPDATE", [locked]);
        await this.manager(client, accountId, userId);
        if (requireRecipientManager) await this.manager(client, source.recipientAccountId, userId);
      } else {
        if (source.recipientAccountId !== accountId || (source.kind === "share" && source.recipientUserId !== userId)) throw missing();
        for (const locked of [...new Set([source.resourceAccountId, source.recipientAccountId])].sort())
          await client.query("SELECT account_id FROM adc_accounts WHERE account_id = $1 FOR UPDATE", [locked]);
        if (source.kind === "team") await this.manager(client, accountId, userId);
      }
      const previous = await this.bindingIn(client, bindingId, true);
      if (previous.revision !== revision || previous.state === "revoked") throw conflict();
      const updated: ResourceBinding = { ...previous, ...changes, revision: previous.revision + 1 };
      await this.saveBinding(client, updated);
      await this.invalidate(client, { bindingId });
      await this.event(client, previous.resourceAccountId, userId, leave ? "share.left" : "binding.updated", { bindingId, state: updated.state, revision: updated.revision });
      return updated;
    });
  }

  private async invalidate(client: PoolClient, filter: { bindingId?: string; accountId?: string; userId?: string }) {
    const where = filter.bindingId
      ? "invocation->'delegation'->>'bindingId' = $1"
      : `(account_id = $1 AND invocation->'delegation'->>'requesterUserId' = $2)
         OR invocation_id IN (SELECT invocation_id FROM adc_approvals
           WHERE required_consents @> jsonb_build_array(jsonb_build_object('accountId',$1::text,'role','resource'))
             AND consents @> jsonb_build_array(jsonb_build_object('accountId',$1::text,'userId',$2::text)))`;
    const values = filter.bindingId ? [filter.bindingId] : [filter.accountId, filter.userId];
    await client.query(
      `UPDATE adc_dispatches SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancel_requested' END,
         result = CASE WHEN status = 'queued' THEN jsonb_build_object(
           'schemaVersion','0.1','invocationId',invocation_id,'attemptId',invocation->>'attemptId',
           'status','cancelled','error',jsonb_build_object('code','denied','message','Resource authorization changed.','retryable',false))
           ELSE result END, updated_at = NOW()
       WHERE (${where}) AND status IN ('queued','leased','running','cancel_requested')`, values
    );
    await client.query(
      `UPDATE adc_approvals SET status = 'denied', resolved_at = NOW() WHERE (${where}) AND status = 'pending'`, values
    );
  }

  async workForResource(accountId: string, limit = 100) {
    const result = await this.pool.query(
      `SELECT dispatch_id, node_id, invocation_id, status, created_at, updated_at,
         invocation->>'tool' AS tool, invocation->'actor' AS actor,
         invocation->'delegation' AS delegation, policy_decision
       FROM adc_dispatches WHERE invocation->'delegation'->>'resourceAccountId' = $1
       ORDER BY created_at DESC LIMIT $2`, [accountId, limit]
    );
    // No requester conversation, arbitrary arguments, outputs or credentials.
    return result.rows;
  }

  async consentApproval(approvalId: string, accountId: string, userId: string) {
    return this.transaction(async (client) => {
      const source = await client.query("SELECT account_id, invocation->'delegation'->>'resourceAccountId' AS resource_account_id FROM adc_approvals WHERE approval_id = $1", [approvalId]);
      if (!source.rows[0]) throw missing();
      for (const id of [...new Set([source.rows[0].account_id, source.rows[0].resource_account_id])].filter(Boolean).sort())
        await client.query("SELECT account_id FROM adc_accounts WHERE account_id = $1 FOR UPDATE", [id]);
      const result = await client.query(
        "SELECT required_consents, consents, status, expires_at FROM adc_approvals WHERE approval_id = $1 FOR UPDATE",
        [approvalId]
      );
      const row = result.rows[0];
      const required = row?.required_consents as Array<{ accountId: string; userId?: string; role: "requester" | "resource" }> | undefined;
      const matching = required?.filter(entry => entry.accountId === accountId && (!entry.userId || entry.userId === userId));
      if (!matching?.length)
        throw missing();
      for (const entry of matching) if (!await consentIsAuthorized(client, accountId, userId, entry.role)) throw denied();
      if (row.status !== "pending" || new Date(row.expires_at).getTime() <= Date.now()) throw conflict();
      const consents: Array<{ accountId: string; userId: string; approvedAt: string }> = [];
      for (const consent of row.consents) {
        const entries = required!.filter(entry => entry.accountId === consent.accountId && (!entry.userId || entry.userId === consent.userId));
        let valid = !!entries.length;
        for (const entry of entries) if (!await consentIsAuthorized(client, entry.accountId, consent.userId, entry.role)) valid = false;
        if (valid) consents.push(consent);
      }
      if (!consents.some((entry) => entry.accountId === accountId && entry.userId === userId)) {
        consents.push({ accountId, userId, approvedAt: new Date().toISOString() });
        await this.event(client, accountId, userId, "approval.consent", { approvalId });
      }
      await client.query("UPDATE adc_approvals SET consents = $2 WHERE approval_id = $1", [approvalId, JSON.stringify(consents)]);
      return required!.every((entry) => consents.some((consent) =>
        consent.accountId === entry.accountId && (!entry.userId || entry.userId === consent.userId)));
    });
  }
}
