import { randomBytes } from "node:crypto";
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
import { assertSameInvocation } from "./dispatch-identity.ts";

const terminalStatuses = new Set(["succeeded", "failed", "denied", "cancelled", "unknown_outcome"]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function newestFirst(
  left: { createdAt: string },
  leftId: string,
  right: { createdAt: string },
  rightId: string
): number {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt) || rightId.localeCompare(leftId);
}

function isBefore(
  item: { createdAt: string },
  itemId: string,
  cursor: { createdAt: string; itemId: string }
): boolean {
  const itemTime = Date.parse(item.createdAt);
  const cursorTime = Date.parse(cursor.createdAt);
  return itemTime < cursorTime || (itemTime === cursorTime && itemId < cursor.itemId);
}

export class MemoryStore implements Store {
  private readonly accounts = new Map<string, AccountRecord>();
  private readonly pairingCodes = new Map<string, PairingCodeRecord>();
  private readonly nodes = new Map<string, NodeRecord>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly roots = new Map<string, RootBindingRecord>();
  private readonly grants = new Map<string, AgentGrantRecord>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly approvalByInvocation = new Map<string, string>();
  private readonly dispatches = new Map<string, DispatchRecord>();
  private readonly dispatchByInvocation = new Map<string, string>();
  private readonly dispatchByIdempotency = new Map<string, string>();
  private readonly transfers = new Map<string, TransferRecord>();
  private readonly cleanedTransfers = new Set<string>();
  private readonly transferByInvocation = new Map<string, string>();
  private readonly transferByIdempotency = new Map<string, string>();
  private readonly audit: AuditEvent[] = [];
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly nonces = new Map<string, number>();

  async migrate(): Promise<void> {}
  async close(): Promise<void> {}

  async putAccount(account: AccountRecord): Promise<void> {
    this.accounts.set(account.accountId, clone(account));
  }

  async getAccount(accountId: string): Promise<AccountRecord | undefined> {
    const account = this.accounts.get(accountId);
    return account ? clone(account) : undefined;
  }

  async putPairingCode(code: PairingCodeRecord): Promise<void> {
    this.pairingCodes.set(code.codeHash, clone(code));
  }

  async pairNode(input: PairNodeInput): Promise<PairNodeResult | undefined> {
    const code = this.pairingCodes.get(input.codeHash);
    if (!code || code.usedAt || Date.parse(code.expiresAt) <= input.now.getTime()) {
      return undefined;
    }
    const replacedNodeIds: string[] = [];
    for (const node of this.nodes.values()) {
      if (
        node.accountId === code.accountId &&
        node.status === "active" &&
        !node.deletedAt &&
        !node.lastSeenAt &&
        node.label === input.node.label
      ) {
        node.status = "revoked";
        node.deletedAt = input.now.toISOString();
        node.revision = (node.revision ?? 1) + 1;
        replacedNodeIds.push(node.nodeId);
      }
    }
    if (
      [...this.nodes.values()].some(
        (node) =>
          node.accountId === code.accountId &&
          node.status === "active" &&
          !node.deletedAt &&
          node.label === input.node.label
      )
    ) {
      throw new ProtocolError(ErrorCodes.CONFLICT, "node label already exists", false);
    }
    code.usedAt = input.now.toISOString();
    const node: NodeRecord = { ...input.node, accountId: code.accountId, revision: 1 };
    this.nodes.set(node.nodeId, clone(node));
    return { node: clone(node), replacedNodeIds };
  }

  async getNode(nodeId: string): Promise<NodeRecord | undefined> {
    const node = this.nodes.get(nodeId);
    return node ? clone(node) : undefined;
  }

  async listNodes(accountId: string): Promise<NodeRecord[]> {
    return [...this.nodes.values()]
      .filter((node) => node.accountId === accountId && !node.deletedAt)
      .map((node) => clone(node));
  }

  async listNodesByIds(accountId: string, nodeIds: string[]): Promise<NodeRecord[]> {
    const selected = new Set(nodeIds);
    return [...this.nodes.values()]
      .filter((node) => node.accountId === accountId && selected.has(node.nodeId))
      .map((node) => clone(node));
  }

  async updateNodePresence(
    nodeId: string,
    capability: CapabilityAdvertisement,
    now: Date
  ): Promise<NodeRecord | undefined> {
    const node = this.nodes.get(nodeId);
    if (!node || node.status === "revoked") {
      return undefined;
    }
    if (!node.lastSeenAt || Date.parse(node.lastSeenAt) <= now.getTime()) {
      node.capability = clone(capability);
      node.lastSeenAt = now.toISOString();
    }
    return clone(node);
  }

  async touchNodePresences(nodeIds: string[], now: Date): Promise<void> {
    for (const nodeId of new Set(nodeIds)) {
      const node = this.nodes.get(nodeId);
      if (
        node?.status === "active" &&
        node.capability &&
        (!node.lastSeenAt || Date.parse(node.lastSeenAt) < now.getTime())
      )
        node.lastSeenAt = now.toISOString();
    }
  }

  async rotateNodeKey(nodeId: string, publicKey: string, now: Date): Promise<boolean> {
    const node = this.nodes.get(nodeId);
    if (!node || node.status !== "active") {
      return false;
    }
    node.publicKey = publicKey;
    if (!node.lastSeenAt || Date.parse(node.lastSeenAt) < now.getTime())
      node.lastSeenAt = now.toISOString();
    return true;
  }

  async revokeNode(nodeId: string, now: Date): Promise<boolean> {
    const node = this.nodes.get(nodeId);
    if (!node || node.status === "revoked") {
      return false;
    }
    node.status = "revoked";
    node.revision = (node.revision ?? 1) + 1;
    node.lastSeenAt = now.toISOString();
    return true;
  }

  async putProject(project: ProjectRecord, createOnly = false, audit?: AuditEvent): Promise<void> {
    const existing = this.projects.get(project.projectId);
    if (existing && (createOnly || existing.deletedAt || existing.accountId !== project.accountId)) {
      throw new ProtocolError("conflict", "Project ID is unavailable.", false);
    }
    this.projectNameAvailable(project.accountId, project.projectId, project.label);
    this.projects.set(project.projectId, { ...clone(project), revision: existing ? (existing.revision ?? 1) + 1 : 1 });
    if (audit) this.audit.push(clone(audit));
  }

  private projectNameAvailable(accountId: string, projectId: string, label: string) {
    if ([...this.projects.values()].some(p => p.accountId === accountId && p.projectId !== projectId && !p.deletedAt && p.label === label))
      throw new ProtocolError("conflict", "A project with this name already exists.", false);
  }

  private activeProject(accountId: string, projectId: string, revision?: number) {
    const project = this.projects.get(projectId);
    if (!project || project.accountId !== accountId || project.deletedAt || revision !== undefined && (project.revision ?? 1) !== revision)
      throw new ProtocolError("conflict", "Project changed. Refresh and try again.", false);
    return project;
  }

  private assertProjectUnused(projectId: string, rootId?: string) {
    if ([...this.grants.values()].some(g => g.projectId === projectId && !g.revokedAt && !g.deletedAt && (!rootId || g.rootIds.includes(rootId))))
      throw new ProtocolError("conflict", "Remove the affected Agent authorizations before changing or deleting this resource.", false);
  }

  async updateProject(accountId: string, projectId: string, label: string, revision: number, audit: AuditEvent): Promise<ProjectRecord> {
    const project = this.activeProject(accountId, projectId, revision);
    this.projectNameAvailable(accountId, projectId, label);
    Object.assign(project, { label, revision: revision + 1 });
    this.audit.push(clone(audit));
    return clone(project);
  }

  async deleteProject(accountId: string, projectId: string, revision: number, audit: AuditEvent): Promise<void> {
    const project = this.activeProject(accountId, projectId, revision);
    this.assertProjectUnused(projectId);
    Object.assign(project, { deletedAt: audit.createdAt, revision: revision + 1 });
    for (const root of this.roots.values()) if (root.projectId === projectId && !root.deletedAt)
      Object.assign(root, { deletedAt: audit.createdAt, revision: (root.revision ?? 1) + 1 });
    this.audit.push(clone(audit));
  }

  async updateNode(
    accountId: string,
    nodeId: string,
    changes: Pick<NodeRecord, "label" | "description" | "accessPolicy">,
    revision: number,
    audit: AuditEvent
  ): Promise<NodeRecord> {
    const node = this.nodes.get(nodeId);
    if (
      !node ||
      node.accountId !== accountId ||
      node.status !== "active" ||
      node.deletedAt ||
      (node.revision ?? 1) !== revision
    )
      throw new ProtocolError("conflict", "Device changed. Refresh and try again.", false);
    if (
      [...this.nodes.values()].some(
        (other) =>
          other.nodeId !== nodeId &&
          other.accountId === accountId &&
          !other.deletedAt &&
          other.label === changes.label
      )
    )
      throw new ProtocolError("conflict", "A device with this name already exists.", false);
    const patch: Partial<NodeRecord> = { label: changes.label };
    if (changes.description !== undefined) patch.description = changes.description;
    if (changes.accessPolicy !== undefined) patch.accessPolicy = changes.accessPolicy;
    Object.assign(node, clone(patch), { revision: revision + 1 });
    this.audit.push(clone(audit));
    return clone(node);
  }

  async deleteNode(
    accountId: string,
    nodeId: string,
    revision: number,
    audit: AuditEvent
  ): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (
      !node ||
      node.accountId !== accountId ||
      node.deletedAt ||
      (node.revision ?? 1) !== revision
    )
      throw new ProtocolError("conflict", "Device changed. Refresh and try again.", false);
    Object.assign(node, { status: "revoked", deletedAt: audit.createdAt, revision: revision + 1 });
    this.cancelResourceWork(accountId, "node", nodeId, audit.createdAt);
    this.audit.push(clone(audit));
  }

  async getProject(projectId: string): Promise<ProjectRecord | undefined> {
    const project = this.projects.get(projectId);
    return project && !project.deletedAt ? clone(project) : undefined;
  }

  async listProjects(accountId: string): Promise<ProjectRecord[]> {
    return [...this.projects.values()]
      .filter((project) => project.accountId === accountId && !project.deletedAt)
      .map((project) => clone(project));
  }

  async putRoot(root: RootBindingRecord, createOnly = false, audit?: AuditEvent): Promise<RootBindingRecord> {
    const existing = this.roots.get(root.rootId);
    const project = this.projects.get(root.projectId);
    if (!project || project.deletedAt) throw new ProtocolError("conflict", "Project changed. Refresh and try again.", false);
    if (existing && (existing.nodeId !== root.nodeId || !existing.deletedAt && (createOnly || existing.projectId !== root.projectId))) {
      throw new ProtocolError(
        ErrorCodes.CONFLICT,
        "root id is already bound to another project or device",
        false
      );
    }
    if (existing && (existing.deletedAt || existing.writable !== root.writable)) this.assertProjectUnused(existing.projectId, root.rootId);
    this.rootNameAvailable(root);
    this.roots.set(root.rootId, { ...clone(root), revision: existing ? (existing.revision ?? 1) + 1 : 1 });
    if (audit) this.audit.push(clone(audit));
    return clone(this.roots.get(root.rootId)!);
  }

  private rootNameAvailable(root: RootBindingRecord) {
    if ([...this.roots.values()].some(r => r.projectId === root.projectId && r.nodeId === root.nodeId && r.rootId !== root.rootId && !r.deletedAt && r.label === root.label))
      throw new ProtocolError("conflict", "A folder with this name already exists on this device.", false);
  }

  private activeRoot(accountId: string, projectId: string, rootId: string, revision: number) {
    this.activeProject(accountId, projectId);
    const root = this.roots.get(rootId);
    if (!root || root.projectId !== projectId || root.deletedAt || (root.revision ?? 1) !== revision)
      throw new ProtocolError("conflict", "Folder changed. Refresh and try again.", false);
    return root;
  }

  async updateRoot(accountId: string, projectId: string, rootId: string, changes: { label: string; writable: boolean }, revision: number, audit: AuditEvent): Promise<RootBindingRecord> {
    const root = this.activeRoot(accountId, projectId, rootId, revision);
    if (root.writable !== changes.writable) this.assertProjectUnused(projectId, rootId);
    this.rootNameAvailable({ ...root, ...changes });
    Object.assign(root, clone(changes), { revision: revision + 1 });
    this.audit.push(clone(audit));
    return clone(root);
  }

  async deleteRoot(accountId: string, projectId: string, rootId: string, revision: number, audit: AuditEvent): Promise<void> {
    const root = this.activeRoot(accountId, projectId, rootId, revision);
    this.assertProjectUnused(projectId, rootId);
    Object.assign(root, { deletedAt: audit.createdAt, revision: revision + 1 });
    this.audit.push(clone(audit));
  }

  async listRoots(projectId: string): Promise<RootBindingRecord[]> {
    return [...this.roots.values()]
      .filter((root) => root.projectId === projectId && !root.deletedAt && !this.projects.get(projectId)?.deletedAt)
      .map((root) => clone(root));
  }

  async listRootsForAccount(accountId: string): Promise<RootBindingRecord[]> {
    const projectIds = new Set(
      [...this.projects.values()]
        .filter((project) => project.accountId === accountId && !project.deletedAt)
        .map((project) => project.projectId)
    );
    return [...this.roots.values()]
      .filter((root) => projectIds.has(root.projectId) && !root.deletedAt)
      .map((root) => clone(root));
  }

  async putGrant(grant: AgentGrantRecord, createOnly = false): Promise<void> {
    this.validateProjectGrant(grant);
    const existing = this.grants.get(grant.grantId);
    if (
      existing &&
      (createOnly ||
        existing.accountId !== grant.accountId ||
        existing.actorId !== grant.actorId ||
        existing.projectId !== grant.projectId ||
        existing.revokedAt)
    ) {
      throw new ProtocolError("conflict", "Grant is unavailable or revoked.", false);
    }
    this.grants.set(grant.grantId, {
      ...clone(grant),
      revision: existing ? (existing.revision ?? 1) + 1 : 1
    });
  }

  async getGrant(grantId: string): Promise<AgentGrantRecord | undefined> {
    const grant = this.grants.get(grantId);
    return grant ? clone(grant) : undefined;
  }

  async listGrants(accountId: string): Promise<AgentGrantRecord[]> {
    return [...this.grants.values()]
      .filter((grant) => grant.accountId === accountId && !grant.deletedAt)
      .map(clone);
  }

  async revokeGrant(accountId: string, grantId: string, now: Date): Promise<boolean> {
    const grant = this.grants.get(grantId);
    if (!grant || grant.accountId !== accountId || grant.deletedAt) return false;
    grant.revokedAt ??= now.toISOString();
    grant.revision = (grant.revision ?? 1) + 1;
    return true;
  }

  async updateGrant(
    grant: AgentGrantRecord,
    revision: number,
    audit: AuditEvent
  ): Promise<AgentGrantRecord> {
    this.validateProjectGrant(grant);
    const existing = this.grants.get(grant.grantId);
    if (
      !existing ||
      existing.accountId !== grant.accountId ||
      existing.revokedAt ||
      existing.deletedAt ||
      (existing.revision ?? 1) !== revision
    )
      throw new ProtocolError("conflict", "Authorization changed. Refresh and try again.", false);
    const updated = { ...clone(grant), revision: revision + 1 };
    this.grants.set(grant.grantId, updated);
    this.audit.push(clone(audit));
    return clone(updated);
  }

  private validateProjectGrant(grant: AgentGrantRecord) {
    if (!grant.projectId) return;
    this.activeProject(grant.accountId, grant.projectId);
    if (grant.rootAccess === "all" || grant.rootIds.some(rootId => {
      const root = this.roots.get(rootId);
      return !root || root.deletedAt || root.projectId !== grant.projectId || !grant.nodeIds.includes(root.nodeId);
    })) throw new ProtocolError("conflict", "Project folders changed. Refresh and try again.", false);
  }

  async deleteGrant(
    accountId: string,
    grantId: string,
    revision: number,
    audit: AuditEvent
  ): Promise<void> {
    const grant = this.grants.get(grantId);
    if (
      !grant ||
      grant.accountId !== accountId ||
      grant.deletedAt ||
      (grant.revision ?? 1) !== revision
    )
      throw new ProtocolError("conflict", "Authorization changed. Refresh and try again.", false);
    grant.revokedAt ??= audit.createdAt;
    grant.deletedAt = audit.createdAt;
    grant.revision = revision + 1;
    this.cancelResourceWork(accountId, "grant", grantId, audit.createdAt);
    this.audit.push(clone(audit));
  }

  private cancelResourceWork(accountId: string, kind: "node" | "grant", id: string, now: string) {
    const matches = (item: {
      nodeId: string;
      invocation: { accountId: string; authorization: { grantId: string } };
    }) =>
      item.invocation.accountId === accountId &&
      (kind === "node" ? item.nodeId === id : item.invocation.authorization.grantId === id);
    for (const dispatch of this.dispatches.values()) {
      if (!matches(dispatch) || !["queued", "leased", "running"].includes(dispatch.status))
        continue;
      dispatch.status = dispatch.status === "running" ? "cancel_requested" : "cancelled";
      dispatch.updatedAt = now;
    }
    for (const approval of this.approvals.values()) {
      if (!matches(approval) || approval.status !== "pending") continue;
      approval.status = "denied";
      approval.resolvedAt = now;
    }
  }

  async putApproval(approval: ApprovalRecord): Promise<ApprovalRecord> {
    const existingId = this.approvalByInvocation.get(approval.invocation.invocationId);
    if (existingId) {
      assertSameInvocation(this.approvals.get(existingId)!.invocation, approval.invocation);
      return clone(this.approvals.get(existingId)!);
    }
    this.approvals.set(approval.approvalId, clone(approval));
    this.approvalByInvocation.set(approval.invocation.invocationId, approval.approvalId);
    return clone(approval);
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    const approval = this.approvals.get(approvalId);
    return approval ? clone(approval) : undefined;
  }

  async getApprovalByInvocation(invocationId: string): Promise<ApprovalRecord | undefined> {
    const approvalId = this.approvalByInvocation.get(invocationId);
    if (!approvalId) return;
    return this.getApproval(approvalId);
  }

  async listApprovals(accountId: string): Promise<ApprovalRecord[]> {
    return [...this.approvals.values()]
      .filter((approval) => approval.accountId === accountId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((approval) => clone(approval));
  }

  async listApprovalsPage(accountId: string, options: ApprovalPageOptions): Promise<ApprovalPage> {
    const now = Date.parse(options.now);
    const effective = [...this.approvals.values()]
      .filter((approval) => approval.accountId === accountId)
      .map((approval) =>
        approval.status === "pending" && Date.parse(approval.expiresAt) <= now
          ? ({ ...approval, status: "expired" } satisfies ApprovalRecord)
          : approval
      );
    const pendingCount = effective.filter((approval) => approval.status === "pending").length;
    const filtered = effective
      .filter(
        (approval) =>
          !options.status ||
          (options.status === "pending"
            ? approval.status === "pending"
            : approval.status !== "pending")
      )
      .filter(
        (approval) => !options.before || isBefore(approval, approval.approvalId, options.before)
      )
      .sort((left, right) => newestFirst(left, left.approvalId, right, right.approvalId));
    const approvals = filtered.slice(0, options.limit);
    return {
      approvals: approvals.map((approval) => clone(approval)),
      pendingCount,
      ...(filtered.length > options.limit && approvals.length
        ? {
            nextCursor: {
              createdAt: approvals.at(-1)!.createdAt,
              itemId: approvals.at(-1)!.approvalId
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
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.status !== "pending") {
      return undefined;
    }
    approval.status = Date.parse(approval.expiresAt) <= now.getTime() ? "expired" : resolution;
    approval.resolvedAt = now.toISOString();
    return clone(approval);
  }

  async enqueue(dispatch: DispatchRecord, audit: AuditEvent): Promise<DispatchRecord> {
    const existingByInvocation = this.dispatchByInvocation.get(dispatch.invocation.invocationId);
    if (existingByInvocation) {
      assertSameInvocation(
        this.dispatches.get(existingByInvocation)!.invocation,
        dispatch.invocation
      );
      return clone(this.dispatches.get(existingByInvocation)!);
    }

    const idempotencyKey = dispatch.invocation.idempotencyKey;
    if (idempotencyKey) {
      const key = `${dispatch.invocation.accountId}:${dispatch.invocation.actor.id}:${idempotencyKey}`;
      const existingId = this.dispatchByIdempotency.get(key);
      if (existingId) {
        const existing = this.dispatches.get(existingId)!;
        assertSameInvocation(existing.invocation, dispatch.invocation);
        return clone(existing);
      }
      this.dispatchByIdempotency.set(key, dispatch.dispatchId);
    }

    this.dispatches.set(dispatch.dispatchId, clone(dispatch));
    this.dispatchByInvocation.set(dispatch.invocation.invocationId, dispatch.dispatchId);
    this.audit.push(clone(audit));
    return clone(dispatch);
  }

  async approveAndEnqueue(
    approvalId: string,
    dispatch: DispatchRecord,
    audit: AuditEvent,
    now: Date
  ): Promise<DispatchRecord | undefined> {
    const approval = this.approvals.get(approvalId);
    if (
      !approval ||
      approval.accountId !== dispatch.invocation.accountId ||
      approval.status !== "pending" ||
      Date.parse(approval.expiresAt) <= now.getTime()
    )
      return;
    assertSameInvocation(approval.invocation, dispatch.invocation);
    approval.status = "approved";
    try {
      const queued = await this.enqueue(dispatch, audit);
      approval.resolvedAt = now.toISOString();
      this.audit.push({
        eventId: createId("dsp"),
        accountId: approval.accountId,
        invocationId: approval.invocation.invocationId,
        type: "approval.approved",
        payload: { approvalId, dispatchId: queued.dispatchId },
        createdAt: now.toISOString()
      });
      return queued;
    } catch (error) {
      approval.status = "pending";
      throw error;
    }
  }

  async createTransfer(
    transfer: TransferRecord,
    dispatches: DispatchRecord[],
    audits: AuditEvent[]
  ): Promise<TransferRecord> {
    const existingId = this.transferByInvocation.get(transfer.invocation.invocationId);
    if (existingId) {
      const existing = this.transfers.get(existingId)!;
      assertSameInvocation(existing.invocation, transfer.invocation);
      return clone(existing);
    }
    const idempotencyKey = transfer.invocation.idempotencyKey;
    if (idempotencyKey) {
      const key = `${transfer.invocation.accountId}:${transfer.invocation.actor.id}:${idempotencyKey}`;
      const duplicateId = this.transferByIdempotency.get(key);
      if (duplicateId) {
        const existing = this.transfers.get(duplicateId)!;
        assertSameInvocation(existing.invocation, transfer.invocation);
        return clone(existing);
      }
    }
    const active = [...this.transfers.values()].filter(
      (item) =>
        item.invocation.accountId === transfer.invocation.accountId &&
        !terminalStatuses.has(item.status) &&
        Date.parse(item.invocation.expiresAt) > Date.now()
    );
    if (active.length >= 8) {
      throw new ProtocolError(
        ErrorCodes.CONFLICT,
        "account transfer concurrency limit reached",
        true
      );
    }
    if (idempotencyKey) {
      this.transferByIdempotency.set(
        `${transfer.invocation.accountId}:${transfer.invocation.actor.id}:${idempotencyKey}`,
        transfer.transferId
      );
    }
    this.transfers.set(transfer.transferId, clone(transfer));
    this.transferByInvocation.set(transfer.invocation.invocationId, transfer.transferId);
    for (const [index, dispatch] of dispatches.entries()) {
      await this.enqueue(dispatch, audits[index]!);
    }
    return clone(this.transfers.get(transfer.transferId)!);
  }

  async approveAndStartTransfer(
    approvalId: string,
    transferId: string,
    dispatches: DispatchRecord[],
    audits: AuditEvent[],
    now: Date
  ): Promise<TransferRecord | undefined> {
    const approval = this.approvals.get(approvalId);
    const transfer = this.transfers.get(transferId);
    if (
      !approval ||
      !transfer ||
      approval.invocation.invocationId !== transfer.invocation.invocationId ||
      approval.status !== "pending" ||
      Date.parse(approval.expiresAt) <= now.getTime() ||
      transfer.status !== "awaiting_approval"
    )
      return;
    approval.status = "approved";
    try {
      for (const [index, dispatch] of dispatches.entries()) {
        await this.enqueue(dispatch, audits[index]!);
      }
      if ("nodeId" in transfer.args.source) transfer.sourceDispatchId = dispatches[0]!.dispatchId;
      transfer.destinationDispatchId = dispatches.at(-1)!.dispatchId;
      transfer.status = "queued";
      transfer.updatedAt = now.toISOString();
      approval.resolvedAt = now.toISOString();
      this.audit.push({
        eventId: createId("dsp"),
        accountId: approval.accountId,
        invocationId: approval.invocation.invocationId,
        type: "approval.approved",
        payload: { approvalId, transferId },
        createdAt: now.toISOString()
      });
      return clone(transfer);
    } catch (error) {
      approval.status = "pending";
      throw error;
    }
  }

  async getTransferById(transferId: string): Promise<TransferRecord | undefined> {
    const transfer = this.transfers.get(transferId);
    return transfer ? clone(transfer) : undefined;
  }

  async getTransferByInvocation(invocationId: string): Promise<TransferRecord | undefined> {
    const id = this.transferByInvocation.get(invocationId);
    return id ? clone(this.transfers.get(id)!) : undefined;
  }

  async getTransferByDispatch(dispatchId: string): Promise<TransferRecord | undefined> {
    const transfer = [...this.transfers.values()].find(
      (candidate) =>
        candidate.sourceDispatchId === dispatchId || candidate.destinationDispatchId === dispatchId
    );
    return transfer ? clone(transfer) : undefined;
  }

  async getTransferByIdempotency(
    accountId: string,
    actorId: string,
    key: string
  ): Promise<TransferRecord | undefined> {
    const id = this.transferByIdempotency.get(`${accountId}:${actorId}:${key}`);
    return id ? this.getTransferById(id) : undefined;
  }

  async prepareTransfer(
    transferId: string,
    sourceNodeId: string,
    metadata: { byteSize: number; chunkCount: number }
  ): Promise<TransferRecord | undefined> {
    const transfer = this.transfers.get(transferId);
    if (
      !transfer ||
      !("nodeId" in transfer.args.source) ||
      transfer.args.source.nodeId !== sourceNodeId ||
      !["queued", "transferring", "verifying"].includes(transfer.status)
    )
      return;
    if (
      transfer.byteSize !== undefined &&
      (transfer.byteSize !== metadata.byteSize || transfer.chunkCount !== metadata.chunkCount)
    ) {
      throw new ProtocolError(ErrorCodes.CONFLICT, "transfer metadata changed", false);
    }
    transfer.byteSize = metadata.byteSize;
    transfer.chunkCount = metadata.chunkCount;
    transfer.status = "transferring";
    transfer.updatedAt = new Date().toISOString();
    return clone(transfer);
  }

  async finalizeTransferSource(
    transferId: string,
    sourceNodeId: string,
    contentSha256: string
  ): Promise<TransferRecord | undefined> {
    const transfer = this.transfers.get(transferId);
    if (
      !transfer ||
      !("nodeId" in transfer.args.source) ||
      transfer.args.source.nodeId !== sourceNodeId ||
      !["transferring", "verifying"].includes(transfer.status)
    )
      return;
    if (transfer.contentSha256 && transfer.contentSha256 !== contentSha256) {
      throw new ProtocolError(ErrorCodes.CONFLICT, "transfer digest changed", false);
    }
    transfer.contentSha256 = contentSha256;
    transfer.updatedAt = new Date().toISOString();
    return clone(transfer);
  }

  async updateTransferProgress(
    transferId: string,
    destinationNodeId: string,
    bytesTransferred: number,
    status: "transferring" | "verifying" = "transferring"
  ): Promise<TransferRecord | undefined> {
    const transfer = this.transfers.get(transferId);
    if (
      !transfer ||
      transfer.args.destination.nodeId !== destinationNodeId ||
      transfer.byteSize === undefined ||
      bytesTransferred > transfer.byteSize ||
      terminalStatuses.has(transfer.status)
    )
      return;
    transfer.bytesTransferred = Math.max(transfer.bytesTransferred, bytesTransferred);
    if (transfer.status !== "verifying") transfer.status = status;
    transfer.updatedAt = new Date().toISOString();
    return clone(transfer);
  }

  async reconcileTransfer(dispatchId: string, now: Date): Promise<TransferRecord | undefined> {
    const transfer = [...this.transfers.values()].find(
      (candidate) =>
        candidate.sourceDispatchId === dispatchId || candidate.destinationDispatchId === dispatchId
    );
    if (!transfer) return;
    const source = transfer.sourceDispatchId
      ? this.dispatches.get(transfer.sourceDispatchId)
      : undefined;
    const destination = transfer.destinationDispatchId
      ? this.dispatches.get(transfer.destinationDispatchId)
      : undefined;
    if (destination?.status === "succeeded") {
      transfer.status = "succeeded";
      transfer.bytesTransferred = transfer.byteSize ?? transfer.bytesTransferred;
    } else {
      const failure = [destination, source].find(
        (candidate) =>
          candidate &&
          ["failed", "denied", "cancelled", "unknown_outcome"].includes(candidate.status)
      );
      if (failure) {
        transfer.status = failure.status as "failed" | "denied" | "cancelled" | "unknown_outcome";
        transfer.error = {
          code: failure.result?.error?.code ?? failure.status,
          message: failure.result?.error?.message ?? `transfer ${failure.status}`
        };
      }
    }
    transfer.updatedAt = now.toISOString();
    if (terminalStatuses.has(transfer.status)) transfer.completedAt = now.toISOString();
    return clone(transfer);
  }

  async requestCancelTransfer(transferId: string, now: Date): Promise<TransferRecord | undefined> {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    for (const dispatchId of [transfer.sourceDispatchId, transfer.destinationDispatchId].filter(
      (value): value is string => !!value
    )) {
      await this.requestCancel(dispatchId, now);
    }
    if (transfer.status === "awaiting_approval" || transfer.status === "queued") {
      transfer.status = "cancelled";
      transfer.completedAt = now.toISOString();
    }
    transfer.updatedAt = now.toISOString();
    return clone(transfer);
  }

  async listTransferCleanupCandidates(before: Date, limit: number): Promise<string[]> {
    return [...this.transfers.values()]
      .filter(
        (transfer) =>
          !this.cleanedTransfers.has(transfer.transferId) &&
          (terminalStatuses.has(transfer.status)
            ? Date.parse(transfer.completedAt ?? transfer.updatedAt)
            : Date.parse(transfer.invocation.expiresAt)) <= before.getTime()
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit)
      .map((transfer) => transfer.transferId);
  }

  async markTransferCleaned(transferId: string): Promise<void> {
    this.cleanedTransfers.add(transferId);
  }

  async denyTransfer(transferId: string, now: Date): Promise<TransferRecord | undefined> {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.status !== "awaiting_approval") return;
    transfer.status = "denied";
    transfer.completedAt = now.toISOString();
    transfer.updatedAt = now.toISOString();
    return clone(transfer);
  }

  async claim(nodeId: string, now: Date, leaseMs: number): Promise<DispatchRecord | undefined> {
    const candidate = [...this.dispatches.values()]
      .filter(
        (dispatch) =>
          dispatch.nodeId === nodeId &&
          (dispatch.status === "queued" ||
            (["leased", "running", "cancel_requested"].includes(dispatch.status) &&
              dispatch.leaseExpiresAt !== undefined &&
              Date.parse(dispatch.leaseExpiresAt) <= now.getTime()))
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (!candidate) {
      return undefined;
    }
    if (candidate.status === "queued") candidate.status = "leased";
    candidate.leaseToken = randomBytes(24).toString("base64url");
    candidate.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    candidate.updatedAt = now.toISOString();
    return clone(candidate);
  }

  async acknowledge(
    dispatchId: string,
    leaseToken: string,
    now: Date
  ): Promise<DispatchRecord | undefined> {
    const dispatch = this.dispatches.get(dispatchId);
    if (
      !dispatch ||
      !["leased", "running", "cancel_requested"].includes(dispatch.status) ||
      dispatch.leaseToken !== leaseToken ||
      !dispatch.leaseExpiresAt ||
      Date.parse(dispatch.leaseExpiresAt) <= now.getTime()
    ) {
      return undefined;
    }
    if (dispatch.status !== "cancel_requested") dispatch.status = "running";
    dispatch.updatedAt = now.toISOString();
    return clone(dispatch);
  }

  async renewLease(
    dispatchId: string,
    leaseToken: string,
    now: Date,
    leaseMs: number
  ): Promise<DispatchRecord | undefined> {
    const dispatch = this.dispatches.get(dispatchId);
    if (
      !dispatch ||
      !["running", "cancel_requested"].includes(dispatch.status) ||
      dispatch.leaseToken !== leaseToken ||
      !dispatch.leaseExpiresAt ||
      Date.parse(dispatch.leaseExpiresAt) <= now.getTime()
    ) {
      return undefined;
    }
    dispatch.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    dispatch.updatedAt = now.toISOString();
    return clone(dispatch);
  }

  async complete(
    dispatchId: string,
    leaseToken: string,
    result: InvocationResult,
    receipt: Receipt | undefined,
    now: Date
  ): Promise<DispatchRecord | undefined> {
    const dispatch = this.dispatches.get(dispatchId);
    if (!dispatch) {
      return undefined;
    }
    if (terminalStatuses.has(dispatch.status)) {
      return clone(dispatch);
    }
    if (dispatch.leaseToken !== leaseToken) {
      return undefined;
    }
    if (isSideEffectTool(dispatch.invocation.tool) && !receipt) {
      throw new ProtocolError(
        ErrorCodes.INVALID_REQUEST,
        "side-effecting completion requires a receipt",
        false
      );
    }
    dispatch.status =
      result.status === "succeeded"
        ? "succeeded"
        : result.status === "cancelled"
          ? "cancelled"
          : result.status === "unknown_outcome"
            ? "unknown_outcome"
            : result.status === "denied"
              ? "denied"
              : "failed";
    dispatch.result = clone(result);
    if (receipt) {
      dispatch.receipt = clone(receipt);
    }
    dispatch.updatedAt = now.toISOString();
    this.audit.push({
      eventId: createId("dsp"),
      accountId: dispatch.invocation.accountId,
      invocationId: dispatch.invocation.invocationId,
      type: "dispatch.completed",
      payload: {
        dispatchId,
        nodeId: dispatch.nodeId,
        status: dispatch.status,
        receiptId: receipt?.receiptId
      },
      createdAt: now.toISOString()
    });
    return clone(dispatch);
  }

  async requestCancel(dispatchId: string, now: Date): Promise<DispatchRecord | undefined> {
    const dispatch = this.dispatches.get(dispatchId);
    if (!dispatch) {
      return undefined;
    }
    if (!terminalStatuses.has(dispatch.status)) {
      dispatch.status = ["queued", "leased"].includes(dispatch.status)
        ? "cancelled"
        : "cancel_requested";
      dispatch.updatedAt = now.toISOString();
    }
    return clone(dispatch);
  }

  async getDispatchById(dispatchId: string): Promise<DispatchRecord | undefined> {
    const dispatch = this.dispatches.get(dispatchId);
    return dispatch ? clone(dispatch) : undefined;
  }

  async getDispatchByInvocation(invocationId: string): Promise<DispatchRecord | undefined> {
    const id = this.dispatchByInvocation.get(invocationId);
    return id ? clone(this.dispatches.get(id)!) : undefined;
  }

  async listDispatchesByInvocationIds(
    accountId: string,
    invocationIds: string[]
  ): Promise<DispatchRecord[]> {
    const selected = new Set(invocationIds);
    return [...this.dispatches.values()]
      .filter(
        (dispatch) =>
          dispatch.invocation.accountId === accountId &&
          selected.has(dispatch.invocation.invocationId)
      )
      .map((dispatch) => clone(dispatch));
  }

  async listAudit(accountId: string, invocationId?: string): Promise<AuditEvent[]> {
    return this.audit
      .filter(
        (event) =>
          event.accountId === accountId &&
          (invocationId === undefined || event.invocationId === invocationId)
      )
      .map((event) => clone(event));
  }

  async listAuditPage(accountId: string, options: AuditPageOptions): Promise<AuditPage> {
    const filtered = this.audit
      .filter(
        (event) =>
          event.accountId === accountId &&
          (options.invocationId === undefined || event.invocationId === options.invocationId) &&
          (options.eventTypePrefix === undefined ||
            event.type.startsWith(`${options.eventTypePrefix}.`)) &&
          (!options.before || isBefore(event, event.eventId, options.before))
      )
      .sort((left, right) => newestFirst(left, left.eventId, right, right.eventId));
    const events = filtered.slice(0, options.limit);
    return {
      events: events.map((event) => clone(event)),
      ...(filtered.length > options.limit && events.length
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
    const activeNodes = [...this.nodes.values()].filter(
      (node) => node.accountId === accountId && !node.deletedAt && node.status === "active"
    );
    return {
      activeNodes: activeNodes.length,
      onlineNodes: activeNodes.filter((node) => !!node.lastSeenAt && node.lastSeenAt >= onlineAfter)
        .length,
      activeGrants: [...this.grants.values()].filter(
        (grant) => grant.accountId === accountId && !grant.deletedAt && !grant.revokedAt
      ).length,
      pendingApprovals: [...this.approvals.values()].filter(
        (approval) =>
          approval.accountId === accountId &&
          approval.status === "pending" &&
          approval.expiresAt > now
      ).length
    };
  }

  async putAudit(event: AuditEvent): Promise<void> {
    this.audit.push(clone(event));
  }

  async putArtifact(artifact: ArtifactRecord): Promise<void> {
    const existing = this.artifacts.get(artifact.artifactId);
    if (
      existing &&
      (existing.sha256 !== artifact.sha256 ||
        existing.accountId !== artifact.accountId ||
        existing.invocationId !== artifact.invocationId)
    ) {
      throw new ProtocolError(
        ErrorCodes.CONFLICT,
        "artifact id was already used with different content",
        false
      );
    }
    this.artifacts.set(artifact.artifactId, {
      ...clone(artifact),
      data: Buffer.from(artifact.data)
    });
  }

  async getArtifact(artifactId: string): Promise<ArtifactRecord | undefined> {
    const artifact = this.artifacts.get(artifactId);
    return artifact
      ? {
          ...clone(artifact),
          data: Buffer.from(artifact.data)
        }
      : undefined;
  }

  async consumeNodeNonce(nodeId: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const now = Date.now();
    for (const [key, expiry] of this.nonces) {
      if (expiry <= now) {
        this.nonces.delete(key);
      }
    }
    const key = `${nodeId}:${nonce}`;
    if (this.nonces.has(key)) {
      return false;
    }
    this.nonces.set(key, expiresAt.getTime());
    return true;
  }
}
