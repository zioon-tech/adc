import type {
  CapabilityAdvertisement,
  Invocation,
  InvocationResult,
  PolicyDecision,
  Receipt,
  FileTransferArgs,
  NodePlatform,
  ToolId,
  Delegation
} from "@adc/protocol";
import type { CollaborationScope } from "@adc/protocol";

export type TeamRole = "owner" | "admin" | "member";
export interface TeamMembership {
  accountId: string;
  userId: string;
  role: TeamRole;
  revision: number;
  state: "active" | "removed";
  rules: { nodeId: string; scope: CollaborationScope }[];
  createdAt: string;
}
export interface TeamAccount {
  accountId: string;
  kind: "team";
  name: string;
  membership: TeamMembership;
}
export interface ResourceBinding {
  bindingId: string;
  kind: "share" | "team";
  nodeId: string;
  resourceAccountId: string;
  recipientAccountId: string;
  recipientUserId?: string;
  scope: CollaborationScope;
  expiresAt: string | null;
  revision: number;
  state: "active" | "paused" | "revoked";
  createdAt: string;
}
export interface CollaborationInvitation {
  invitationId: string;
  kind: "member" | "share" | "scope";
  senderAccountId: string;
  senderUserId: string;
  recipientEmail: string;
  teamAccountId?: string;
  role?: Exclude<TeamRole, "owner">;
  nodeId?: string;
  bindingId?: string;
  bindingRevision?: number;
  scope?: CollaborationScope;
  durationDays?: number | null;
  /** Scope proposals retain an absolute deadline, independent of acceptance. */
  bindingExpiresAt?: string | null;
  expiresAt: string;
  revision: number;
  state: "pending" | "accepted" | "declined" | "revoked";
  acceptedUserId?: string;
  acceptedAccountId?: string;
  acceptedBindingId?: string;
  targetUserId?: string;
  createdAt: string;
}

export interface AccountRecord {
  accountId: string;
  ownerTokenHash: string;
  createdAt: string;
}

export interface PairingCodeRecord {
  codeHash: string;
  accountId: string;
  expiresAt: string;
  usedAt?: string;
}

export interface NodeRecord {
  nodeId: string;
  accountId: string;
  /** Request-specific projection, never persisted as Node ownership. */
  resourceAuthorization?: Delegation;
  /** Set only by pairing/provisioning on the control plane. */
  resourceClass?: "physical" | "managed" | "platform";
  label: string;
  /** Free-form owner note shown to harness plugins and consoles. */
  description?: string;
  publicKey: string;
  platform: NodePlatform;
  status: "active" | "revoked";
  accessPolicy?: NodeAccessPolicy;
  revision?: number;
  deletedAt?: string;
  capability?: CapabilityAdvertisement;
  lastSeenAt?: string;
  createdAt: string;
}

export interface NodeAccessPolicy {
  rootAccess: "all" | "selected";
  rootIds: string[];
  readOnlyRootIds: string[];
  allowExecution: boolean;
  maxConcurrency: number;
}

export interface ProjectRecord {
  projectId: string;
  accountId: string;
  label: string;
  createdAt: string;
  revision?: number;
  deletedAt?: string;
}

export interface RootBindingRecord {
  rootId: string;
  projectId: string;
  nodeId: string;
  label: string;
  writable: boolean;
  createdAt: string;
  revision?: number;
  deletedAt?: string;
}

export interface AgentGrantRecord {
  grantId: string;
  accountId: string;
  name?: string;
  projectId?: string;
  actorId: string;
  /** Immutable responsible human; required for team and delegated resources. */
  responsibleUserId?: string;
  resourceBindings?: { nodeId: string; bindingId: string; scope?: CollaborationScope }[];
  profile: "read-only" | "workspace-write" | "approve-required" | "unattended";
  nodeIds: string[];
  rootIds: string[];
  rootAccess?: "selected" | "all";
  approvalPolicy?: "never" | "writes" | "execute" | "always";
  allowedTools: ToolId[];
  revokedAt?: string;
  deletedAt?: string;
  revision?: number;
  createdAt: string;
}

export type DispatchStatus =
  | "queued"
  | "leased"
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled"
  | "unknown_outcome";

export interface DispatchRecord {
  dispatchId: string;
  invocation: Invocation;
  nodeId: string;
  policyDecision: PolicyDecision;
  status: DispatchStatus;
  leaseToken?: string;
  leaseExpiresAt?: string;
  result?: InvocationResult;
  receipt?: Receipt;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  eventId: string;
  accountId: string;
  invocationId?: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PageCursor {
  createdAt: string;
  itemId: string;
}

export interface AuditPageOptions {
  limit: number;
  before?: PageCursor;
  invocationId?: string;
  eventTypePrefix?: string;
}

export interface AuditPage {
  events: AuditEvent[];
  nextCursor?: PageCursor;
}

export interface ArtifactRecord {
  artifactId: string;
  accountId: string;
  invocationId: string;
  nodeId: string;
  contentType: string;
  sha256: string;
  byteSize: number;
  data: Buffer;
  createdAt: string;
}

export type TransferStatus =
  | "awaiting_approval"
  | "queued"
  | "transferring"
  | "verifying"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled"
  | "unknown_outcome";

export interface TransferRecord {
  transferId: string;
  invocation: Invocation;
  args: FileTransferArgs;
  status: TransferStatus;
  sourceDispatchId?: string;
  destinationDispatchId?: string;
  byteSize?: number;
  chunkCount?: number;
  contentSha256?: string;
  bytesTransferred: number;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ApprovalRecord {
  approvalId: string;
  accountId: string;
  invocation: Invocation;
  nodeId: string;
  placementReason: string;
  policyDecision: PolicyDecision;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  requiredConsents?: Array<{ accountId: string; userId?: string; role: "requester" | "resource" }>;
  consents?: Array<{ accountId: string; userId: string; approvedAt: string }>;
}

export interface ApprovalPageOptions {
  includeResourceConsent?: boolean;
  limit: number;
  before?: PageCursor;
  status?: "pending" | "resolved";
  now: string;
  responsibleUserId?: string;
}

export interface ApprovalPage {
  approvals: ApprovalRecord[];
  nextCursor?: PageCursor;
  pendingCount: number;
}

export interface AccountResourceSummary {
  activeNodes: number;
  onlineNodes: number;
  activeGrants: number;
  pendingApprovals: number;
}

export interface PairNodeInput {
  codeHash: string;
  node: Omit<NodeRecord, "accountId"> & { accountId?: string };
  now: Date;
}

export interface PairNodeResult {
  node: NodeRecord;
  replacedNodeIds: string[];
}

export interface Store {
  migrate(): Promise<void>;
  close(): Promise<void>;
  putAccount(account: AccountRecord): Promise<void>;
  getAccount(accountId: string): Promise<AccountRecord | undefined>;
  putPairingCode(code: PairingCodeRecord): Promise<void>;
  pairNode(input: PairNodeInput): Promise<PairNodeResult | undefined>;
  getNode(nodeId: string): Promise<NodeRecord | undefined>;
  listNodes(accountId: string): Promise<NodeRecord[]>;
  listNodesByIds(accountId: string, nodeIds: string[]): Promise<NodeRecord[]>;
  updateNodePresence(
    nodeId: string,
    capability: CapabilityAdvertisement,
    now: Date
  ): Promise<NodeRecord | undefined>;
  touchNodePresences(nodeIds: string[], now: Date): Promise<void>;
  rotateNodeKey(nodeId: string, publicKey: string, now: Date): Promise<boolean>;
  revokeNode(nodeId: string, now: Date): Promise<boolean>;
  updateNode(
    accountId: string,
    nodeId: string,
    changes: Pick<NodeRecord, "label" | "accessPolicy">,
    revision: number,
    audit: AuditEvent
  ): Promise<NodeRecord>;
  deleteNode(accountId: string, nodeId: string, revision: number, audit: AuditEvent): Promise<void>;
  putProject(project: ProjectRecord, createOnly?: boolean, audit?: AuditEvent): Promise<void>;
  updateProject(accountId: string, projectId: string, label: string, revision: number, audit: AuditEvent): Promise<ProjectRecord>;
  deleteProject(accountId: string, projectId: string, revision: number, audit: AuditEvent): Promise<void>;
  getProject(projectId: string): Promise<ProjectRecord | undefined>;
  listProjects(accountId: string): Promise<ProjectRecord[]>;
  putRoot(root: RootBindingRecord, createOnly?: boolean, audit?: AuditEvent): Promise<RootBindingRecord>;
  updateRoot(accountId: string, projectId: string, rootId: string, changes: { label: string; writable: boolean }, revision: number, audit: AuditEvent): Promise<RootBindingRecord>;
  deleteRoot(accountId: string, projectId: string, rootId: string, revision: number, audit: AuditEvent): Promise<void>;
  listRoots(projectId: string): Promise<RootBindingRecord[]>;
  listRootsForAccount(accountId: string): Promise<RootBindingRecord[]>;
  putGrant(grant: AgentGrantRecord, createOnly?: boolean): Promise<void>;
  updateGrant(
    grant: AgentGrantRecord,
    revision: number,
    audit: AuditEvent
  ): Promise<AgentGrantRecord>;
  deleteGrant(
    accountId: string,
    grantId: string,
    revision: number,
    audit: AuditEvent
  ): Promise<void>;
  getGrant(grantId: string): Promise<AgentGrantRecord | undefined>;
  listGrants(accountId: string): Promise<AgentGrantRecord[]>;
  revokeGrant(accountId: string, grantId: string, now: Date): Promise<boolean>;
  putApproval(approval: ApprovalRecord): Promise<ApprovalRecord>;
  getApproval(approvalId: string): Promise<ApprovalRecord | undefined>;
  getApprovalByInvocation(invocationId: string): Promise<ApprovalRecord | undefined>;
  listApprovals(accountId: string): Promise<ApprovalRecord[]>;
  listApprovalsPage(accountId: string, options: ApprovalPageOptions): Promise<ApprovalPage>;
  resolveApproval(
    approvalId: string,
    decision: "approved" | "denied",
    now: Date
  ): Promise<ApprovalRecord | undefined>;
  approveAndEnqueue(
    approvalId: string,
    dispatch: DispatchRecord,
    audit: AuditEvent,
    now: Date
  ): Promise<DispatchRecord | undefined>;
  createTransfer(
    transfer: TransferRecord,
    dispatches: DispatchRecord[],
    audits: AuditEvent[]
  ): Promise<TransferRecord>;
  approveAndStartTransfer(
    approvalId: string,
    transferId: string,
    dispatches: DispatchRecord[],
    audits: AuditEvent[],
    now: Date
  ): Promise<TransferRecord | undefined>;
  getTransferById(transferId: string): Promise<TransferRecord | undefined>;
  getTransferByInvocation(invocationId: string): Promise<TransferRecord | undefined>;
  getTransferByIdempotency(
    accountId: string,
    actorId: string,
    key: string
  ): Promise<TransferRecord | undefined>;
  getTransferByDispatch(dispatchId: string): Promise<TransferRecord | undefined>;
  prepareTransfer(
    transferId: string,
    sourceNodeId: string,
    metadata: { byteSize: number; chunkCount: number }
  ): Promise<TransferRecord | undefined>;
  finalizeTransferSource(
    transferId: string,
    sourceNodeId: string,
    contentSha256: string
  ): Promise<TransferRecord | undefined>;
  updateTransferProgress(
    transferId: string,
    destinationNodeId: string,
    bytesTransferred: number,
    status?: "transferring" | "verifying"
  ): Promise<TransferRecord | undefined>;
  reconcileTransfer(dispatchId: string, now: Date): Promise<TransferRecord | undefined>;
  requestCancelTransfer(transferId: string, now: Date): Promise<TransferRecord | undefined>;
  denyTransfer(transferId: string, now: Date): Promise<TransferRecord | undefined>;
  listTransferCleanupCandidates(before: Date, limit: number): Promise<string[]>;
  markTransferCleaned(transferId: string): Promise<void>;
  enqueue(dispatch: DispatchRecord, audit: AuditEvent): Promise<DispatchRecord>;
  claim(nodeId: string, now: Date, leaseMs: number): Promise<DispatchRecord | undefined>;
  acknowledge(
    dispatchId: string,
    leaseToken: string,
    now: Date
  ): Promise<DispatchRecord | undefined>;
  renewLease(
    dispatchId: string,
    leaseToken: string,
    now: Date,
    leaseMs: number
  ): Promise<DispatchRecord | undefined>;
  complete(
    dispatchId: string,
    leaseToken: string,
    result: InvocationResult,
    receipt: Receipt | undefined,
    now: Date
  ): Promise<DispatchRecord | undefined>;
  requestCancel(dispatchId: string, now: Date): Promise<DispatchRecord | undefined>;
  getDispatchById(dispatchId: string): Promise<DispatchRecord | undefined>;
  getDispatchByInvocation(invocationId: string): Promise<DispatchRecord | undefined>;
  listDispatchesByInvocationIds(
    accountId: string,
    invocationIds: string[]
  ): Promise<DispatchRecord[]>;
  listAudit(accountId: string, invocationId?: string): Promise<AuditEvent[]>;
  listAuditPage(accountId: string, options: AuditPageOptions): Promise<AuditPage>;
  getAccountResourceSummary(
    accountId: string,
    onlineAfter: string,
    now: string
  ): Promise<AccountResourceSummary>;
  putAudit(event: AuditEvent): Promise<void>;
  putArtifact(artifact: ArtifactRecord): Promise<void>;
  getArtifact(artifactId: string): Promise<ArtifactRecord | undefined>;
  consumeNodeNonce(nodeId: string, nonce: string, expiresAt: Date): Promise<boolean>;
}
