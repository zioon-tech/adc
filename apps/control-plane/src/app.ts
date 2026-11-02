import { createHash, createPublicKey, randomBytes, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import { z } from "zod";
import { verifyNodeRequest } from "@adc/client/node";
import { registerCors } from "./cors.ts";
import {
  androidPreviewInfo,
  registerAndroidDistributionRoutes,
  type AndroidDistribution
} from "./android-distribution.ts";
import {
  type AgentGrantRecord,
  type ApprovalRecord,
  type AuditEvent,
  type DispatchRecord,
  type NodeRecord,
  type PageCursor,
  type Store,
  type TransferRecord
} from "@adc/db";
import { evaluatePolicy, requiresApproval, sha256 } from "@adc/policy";
import { createMcpServer } from "@adc/mcp-adapter";
import {
  ArtifactIdSchema,
  CapabilitySchema,
  ErrorCodes,
  FileTransferArgsSchema,
  InvocationIdSchema,
  InvocationSchema,
  NodePlatformSchema,
  ProtocolError,
  ResultSchema,
  TransferIdSchema,
  ToolIdSchema,
  ToolNameSchema,
  WaitMsSchema,
  absolutePathForToolArgs,
  assertInvocationCurrent,
  createId,
  isBuiltinTool,
  isSideEffectTool,
  type AdcError,
  type Invocation,
  type InvocationResult,
  type PolicyDecision
} from "@adc/protocol";
import {
  assertSameOrigin,
  grantContext,
  registerAuthenticationRoutes,
  type AccessService,
  type Principal
} from "./access.ts";
import { registerAccountRoutes } from "./account-routes.ts";
import { CollaborationAuthorization, principalUserId } from "./collaboration.ts";
import { registerCollaborationRoutes } from "./collaboration-routes.ts";
import {
  defaultNodeAccessPolicy,
  effectiveCapability,
  GrantSettingsSchema,
  MAX_NODE_MAX_CONCURRENCY,
  nodeMaxConcurrency,
  registerResourceManagement,
  validateGrantResources
} from "./resource-management.ts";
import {
  currentNodeDistributionInfo,
  latestNodeRelease,
  nodeReleaseUpdate,
  registerDistributionRoutes,
  type NodeDistribution,
  type NodeReleaseSummary
} from "./distribution.ts";
import { NodeWakeHub } from "./node-wake.ts";
import { TaskWaitHub } from "./task-wait.ts";
import { PublicSite, type HostedAnalyticsOptions } from "./public-site.ts";
import type { AssetStore } from "./asset-store.ts";
import type { TransferBlobStore } from "./transfer-store.ts";
import type { DirectTransferStore } from "./object-transfer-store.ts";
import { registerSkillDistributionRoutes, type SkillDistribution } from "./skill-distribution.ts";
import {
  registerPluginDistributionRoutes,
  type PluginDistribution
} from "./plugin-distribution.ts";

export interface ControlPlaneOptions {
  store: Store;
  access: AccessService;
  logger?: boolean;
  now?: () => Date;
  presenceTtlMs?: number;
  leaseMs?: number;
  consoleDirectory?: string;
  nodeDistribution?: NodeDistribution;
  androidDistribution?: AndroidDistribution;
  skillDistribution?: SkillDistribution;
  pluginDistribution?: PluginDistribution;
  trustProxy?: string[];
  /** Opt-in cross-origin origins for API consumers. See registerCors(). */
  corsOrigins?: string[] | "*";
  analytics?: HostedAnalyticsOptions;
  assetStore?: AssetStore;
  transferStore?: TransferBlobStore;
  directTransferStore?: DirectTransferStore;
  maxTransferBytes?: number;
}

function invocationPath(invocation: Invocation, node: NodeRecord | undefined): string | undefined {
  if (!isBuiltinTool(invocation.tool)) return undefined;
  const args = invocation.args as Record<string, unknown>;
  const absolute = absolutePathForToolArgs(invocation.tool, args);
  if (absolute) return absolute;
  const rootId = typeof args.rootId === "string" ? args.rootId : undefined;
  const rootPath = node?.capability?.roots.find((root) => root.rootId === rootId)?.path;
  if (!rootPath) return undefined;
  const relativePath = invocation.tool.startsWith("file.") ? args.path : args.cwd;
  if (typeof relativePath !== "string" || relativePath === "") return rootPath;
  return rootPath === "/" ? `/${relativePath}` : `${rootPath}/${relativePath}`;
}

function transferPath(invocation: Invocation, nodes: Map<string, NodeRecord>): string | undefined {
  if (invocation.tool !== "file.transfer") return;
  const parsed = FileTransferArgsSchema.safeParse(invocation.args);
  if (!parsed.success) return;
  const endpointPath = (endpoint: typeof parsed.data.source) => {
    if (!("nodeId" in endpoint)) return `Agent: ${endpoint.path}`;
    const rootPath = nodes
      .get(endpoint.nodeId)
      ?.capability?.roots.find((root) => root.rootId === endpoint.rootId)?.path;
    if (!rootPath) return endpoint.path;
    return rootPath === "/" ? `/${endpoint.path}` : `${rootPath}/${endpoint.path}`;
  };
  return `${endpointPath(parsed.data.source)} -> ${endpointPath(parsed.data.destination)}`;
}

const PageCursorSchema = z
  .object({
    createdAt: z.string().datetime(),
    itemId: z.string().min(1).max(160)
  })
  .strict();
const AuditCategorySchema = z.enum([
  "dispatch",
  "approval",
  "task",
  "node",
  "grant",
  "credential",
  "oauth"
]);

function encodePageCursor(cursor: PageCursor | undefined): string | null {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString("base64url") : null;
}

function decodePageCursor(value: string | undefined): PageCursor | undefined {
  if (!value) return;
  try {
    return PageCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new ProtocolError(ErrorCodes.INVALID_REQUEST, "pagination cursor is invalid", false);
  }
}

async function auditView(
  store: Store,
  accountId: string,
  events: AuditEvent[]
): Promise<AuditEvent[]> {
  const invocationIds = [
    ...new Set(
      events.map((event) => event.invocationId).filter((id): id is string => typeof id === "string")
    )
  ];
  const dispatches = await store.listDispatchesByInvocationIds(accountId, invocationIds);
  const dispatchByInvocation = new Map(
    dispatches.map((dispatch) => [dispatch.invocation.invocationId, dispatch])
  );
  const nodes = new Map(
    (
      await store.listNodesByIds(accountId, [
        ...new Set(dispatches.map((dispatch) => dispatch.nodeId))
      ])
    ).map((node) => [node.nodeId, node])
  );
  return events.map((event) => {
    const dispatch = event.invocationId ? dispatchByInvocation.get(event.invocationId) : undefined;
    if (!dispatch) return event;
    const path = invocationPath(dispatch.invocation, nodes.get(dispatch.nodeId));
    return {
      ...event,
      payload: {
        ...event.payload,
        nodeId: dispatch.nodeId,
        tool: dispatch.invocation.tool,
        ...(path ? { path } : {})
      }
    };
  });
}

async function approvalView(
  store: Store,
  accountId: string,
  approvals: ApprovalRecord[],
  requesterUserId?: string
) {
  const transferNodeIds = approvals.flatMap((approval) => {
    const parsed = FileTransferArgsSchema.safeParse(approval.invocation.args);
    return approval.invocation.tool === "file.transfer" && parsed.success
      ? [
          ...("nodeId" in parsed.data.source ? [parsed.data.source.nodeId] : []),
          parsed.data.destination.nodeId
        ]
      : [];
  });
  const nodes = new Map(
    (
      await store.listNodesByIds(accountId, [
        ...new Set([...approvals.map((approval) => approval.nodeId), ...transferNodeIds])
      ])
    ).map((node) => [node.nodeId, node])
  );
  return approvals.map((approval) => {
    const path =
      transferPath(approval.invocation, nodes) ??
      invocationPath(approval.invocation, nodes.get(approval.nodeId));
    if (approval.accountId !== accountId || (requesterUserId && approval.invocation.delegation?.requesterUserId !== requesterUserId)) {
      const args = approval.invocation.args as Record<string, unknown>;
      return {
        approvalId: approval.approvalId, accountId, nodeId: approval.nodeId,
        status: approval.status, createdAt: approval.createdAt, expiresAt: approval.expiresAt,
        requiredConsents: approval.requiredConsents, consents: approval.consents,
        invocation: {
          invocationId: approval.invocation.invocationId, tool: approval.invocation.tool,
          args: Object.fromEntries(Object.entries(args).filter(([key]) =>
            ["rootId", "path", "cwd", "command", "templateId", "timeoutMs"].includes(key)))
        },
        contentHash: sha256(args), ...(path ? { path } : {})
      };
    }
    return { ...approval, ...(path ? { path } : {}) };
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function apiError(
  reply: FastifyReply,
  statusCode: number,
  code: AdcError["code"],
  message: string,
  retryable = false,
  details?: Record<string, unknown>
) {
  return reply.code(statusCode).send({
    error: {
      code,
      message,
      retryable,
      ...(details ? { details } : {})
    }
  });
}

function jobIdForDispatch(dispatchId: string): string {
  return `job_${dispatchId.slice("dsp_".length)}`;
}

function dispatchIdForJob(jobId: string): string | undefined {
  return /^job_[a-z0-9][a-z0-9_-]{2,127}$/.test(jobId)
    ? `dsp_${jobId.slice("job_".length)}`
    : undefined;
}

function queuedResult(dispatch: DispatchRecord): InvocationResult {
  if (dispatch.status === "cancelled")
    return ResultSchema.parse({
      schemaVersion: "0.1",
      invocationId: dispatch.invocation.invocationId,
      attemptId: dispatch.invocation.attemptId,
      status: "cancelled",
      error: {
        code: ErrorCodes.CANCELLED,
        message: "Task was cancelled before execution.",
        retryable: false
      },
      jobId: jobIdForDispatch(dispatch.dispatchId)
    });
  return ResultSchema.parse({
    schemaVersion: "0.1",
    invocationId: dispatch.invocation.invocationId,
    attemptId: dispatch.invocation.attemptId,
    status:
      dispatch.status === "running" ||
      dispatch.status === "leased" ||
      dispatch.status === "cancel_requested"
        ? "running"
        : "queued",
    jobId: jobIdForDispatch(dispatch.dispatchId)
  });
}

function domainResult(
  invocation: Invocation,
  status: "denied" | "approval_required" | "offline",
  error: AdcError
): InvocationResult {
  return ResultSchema.parse({
    schemaVersion: "0.1",
    invocationId: invocation.invocationId,
    attemptId: invocation.attemptId,
    status,
    error
  });
}

function jobIdForTransfer(transferId: string): string {
  return `job_${transferId}`;
}

function transferIdForJob(jobId: string): string | undefined {
  const candidate = jobId.startsWith("job_") ? jobId.slice("job_".length) : "";
  return TransferIdSchema.safeParse(candidate).success ? candidate : undefined;
}

function transferResult(transfer: TransferRecord): InvocationResult {
  const output = {
    transferId: transfer.transferId,
    expiresAt: transfer.invocation.expiresAt,
    status: transfer.status,
    source: transfer.args.source,
    destination: transfer.args.destination,
    bytesTransferred: transfer.bytesTransferred,
    ...(transfer.byteSize === undefined ? {} : { byteSize: transfer.byteSize }),
    ...(transfer.chunkCount === undefined ? {} : { chunkCount: transfer.chunkCount }),
    ...(transfer.contentSha256 ? { contentSha256: transfer.contentSha256 } : {})
  };
  if (["queued", "awaiting_approval"].includes(transfer.status)) {
    return ResultSchema.parse({
      schemaVersion: "0.1",
      invocationId: transfer.invocation.invocationId,
      attemptId: transfer.invocation.attemptId,
      status: "queued",
      output,
      jobId: jobIdForTransfer(transfer.transferId)
    });
  }
  if (["transferring", "verifying"].includes(transfer.status)) {
    return ResultSchema.parse({
      schemaVersion: "0.1",
      invocationId: transfer.invocation.invocationId,
      attemptId: transfer.invocation.attemptId,
      status: "running",
      output,
      jobId: jobIdForTransfer(transfer.transferId)
    });
  }
  if (transfer.status === "succeeded") {
    return ResultSchema.parse({
      schemaVersion: "0.1",
      invocationId: transfer.invocation.invocationId,
      attemptId: transfer.invocation.attemptId,
      status: "succeeded",
      output,
      jobId: jobIdForTransfer(transfer.transferId)
    });
  }
  const status = transfer.status;
  const code =
    status === "cancelled"
      ? ErrorCodes.CANCELLED
      : status === "denied"
        ? ErrorCodes.DENIED
        : status === "unknown_outcome"
          ? ErrorCodes.UNKNOWN_OUTCOME
          : ErrorCodes.EXECUTION_FAILED;
  return ResultSchema.parse({
    schemaVersion: "0.1",
    invocationId: transfer.invocation.invocationId,
    attemptId: transfer.invocation.attemptId,
    status,
    output,
    error: {
      code: transfer.error?.code ?? code,
      message: transfer.error?.message ?? `transfer ${status}`,
      retryable: false
    },
    jobId: jobIdForTransfer(transfer.transferId)
  });
}

export async function createControlPlane(options: ControlPlaneOptions): Promise<FastifyInstance> {
  const now = options.now ?? (() => new Date());
  const presenceTtlMs = options.presenceTtlMs ?? 45_000;
  const leaseMs = options.leaseMs ?? 30_000;
  const maxTransferBytes = options.maxTransferBytes ?? 1024 * 1024 * 1024;
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 36 * 1024 * 1024,
    trustProxy: options.trustProxy ?? false
  });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );
  const analyticsOrigin = options.analytics
    ? new URL(options.analytics.scriptUrl).origin
    : undefined;
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 1024 },
    preClose(done) {
      for (const socket of this.websocketServer.clients) socket.terminate();
      this.websocketServer.close(done);
    }
  });
  if (options.corsOrigins) registerCors(app, { origins: options.corsOrigins });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    reply.header("x-frame-options", "DENY");
    if (
      request.url.startsWith("/api/") ||
      request.url.startsWith("/mcp") ||
      request.url === "/metrics"
    ) {
      reply.header("cache-control", "no-store");
    }
    reply.header(
      "content-security-policy",
      `default-src 'self'; script-src 'self'${analyticsOrigin ? ` ${analyticsOrigin}` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${analyticsOrigin ? ` ${analyticsOrigin}` : ""}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
    );
    return payload;
  });
  const metrics = new Registry();
  collectDefaultMetrics({ register: metrics, prefix: "adc_" });
  const pairingCounter = new Counter({
    name: "adc_pairing_total",
    help: "Device pairing outcomes.",
    labelNames: ["outcome"],
    registers: [metrics]
  });
  const pollCounter = new Counter({
    name: "adc_node_poll_total",
    help: "Authenticated device polls.",
    labelNames: ["outcome"],
    registers: [metrics]
  });
  const invocationCounter = new Counter({
    name: "adc_invocation_total",
    help: "Invocation policy and terminal outcomes.",
    labelNames: ["outcome", "tool"],
    registers: [metrics]
  });
  const wakeConnectionGauge = new Gauge({
    name: "adc_node_wake_connections",
    help: "Authenticated Node WebSocket wake connections.",
    registers: [metrics]
  });
  const wakeCounter = new Counter({
    name: "adc_node_wake_total",
    help: "Node wake delivery attempts.",
    labelNames: ["outcome"],
    registers: [metrics]
  });
  const wakeHub = new NodeWakeHub({
    now,
    onConnectionCount: (count) => wakeConnectionGauge.set(count),
    onError: (error) => requestLogError(app, error),
    touchPresence: (nodeIds) => options.store.touchNodePresences(nodeIds, now())
  });
  const wakeNode = (nodeId: string) => {
    wakeCounter.inc({ outcome: wakeHub.wake(nodeId) ? "attempted" : "offline" });
  };
  const countInvocation = (outcome: string, tool: string) =>
    invocationCounter.inc({ outcome, tool: isBuiltinTool(tool) ? tool : "mcp.custom" });

  await options.store.migrate();
  if (options.access.authentication) {
    await options.access.authentication.migrate();
    registerAuthenticationRoutes(app, options.access);
  }
  const principals = new WeakMap<FastifyRequest, Principal>();
  const nodeAccounts = new WeakMap<FastifyRequest, string>();
  const nodeWakeGenerations = new WeakMap<FastifyRequest, number>();
  const accountOf = (request: FastifyRequest) => principals.get(request)!.accountId;
  const collaboration = options.access.collaboration
    ? new CollaborationAuthorization(options.store, options.access.collaboration, now) : undefined;
  const grantNodes = (grant: AgentGrantRecord) => collaboration
    ? collaboration.grantNodes(grant) : options.store.listNodes(grant.accountId);
  const userNodes = async (actor: Principal) => {
    const userId = principalUserId(actor);
    return collaboration && userId ? collaboration.nodes(actor.accountId, userId)
      : options.store.listNodes(actor.accountId);
  };
  const assertGrantManager = (request: FastifyRequest, grant: AgentGrantRecord) => {
    const actor = principals.get(request)!;
    if (actor.kind !== "agent" && actor.team &&
        grant.responsibleUserId !== principalUserId(actor))
      throw new ProtocolError("denied", "Manage only your own Agent authorizations.", false);
  };

  async function cleanupTransfer(transferId: string): Promise<void> {
    try {
      await options.transferStore?.deleteTransfer(transferId);
      await options.directTransferStore?.deleteTransfer(transferId);
      const transfer = await options.store.getTransferById(transferId);
      // Wait out every outstanding URL before declaring cleanup complete.
      if (transfer && Date.parse(transfer.invocation.expiresAt) + 15 * 60_000 <= now().getTime()) {
        await options.store.markTransferCleaned(transferId);
      }
    } catch {
      // Do not turn a durable receipt into an API failure. Bucket lifecycle is the fallback.
      app.log.warn({ transferId }, "transfer cleanup requires retry");
    }
  }

  let cleanupRunning: Promise<void> | undefined;
  const cleanupTimer =
    options.transferStore || options.directTransferStore
      ? setInterval(() => {
          if (cleanupRunning) return;
          cleanupRunning = (async () => {
            const candidates = await options.store.listTransferCleanupCandidates(
              new Date(now().getTime() - 15 * 60_000),
              100
            );
            for (const transferId of candidates) await cleanupTransfer(transferId);
          })()
            .catch(() => {
              app.log.warn("transfer cleanup scan failed");
            })
            .finally(() => {
              cleanupRunning = undefined;
            });
        }, 60_000)
      : undefined;
  cleanupTimer?.unref();

  async function uploadTicket(
    transfer: TransferRecord,
    index: number,
    sha256: string,
    contentMd5: string
  ) {
    const bytes = Math.min(
      transfer.args.chunkSizeBytes,
      transfer.byteSize! - index * transfer.args.chunkSizeBytes
    );
    try {
      const existing = await options.directTransferStore!.downloadTicket(
        transfer.transferId,
        index
      );
      if (existing.sha256 !== sha256 || existing.bytes !== bytes) {
        throw new ProtocolError(ErrorCodes.CONFLICT, "uploaded chunk differs from retry", false);
      }
      return { alreadyUploaded: true };
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    return options.directTransferStore!.uploadTicket(
      transfer.transferId,
      index,
      bytes,
      sha256,
      contentMd5
    );
  }

  app.post(
    "/api/v1/transfers/:transferId/chunks/:index/ticket",
    { preHandler: requireAuthenticated },
    async (request, reply) => {
      if (!options.directTransferStore) {
        return apiError(
          reply,
          503,
          ErrorCodes.OFFLINE,
          "direct transfer storage is unavailable",
          true
        );
      }
      const { transferId, index } = z
        .object({
          transferId: TransferIdSchema,
          index: z.coerce.number().int().min(0).max(999_999)
        })
        .parse(request.params);
      const body = z
        .object({
          sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          contentMd5: z.string().regex(/^[A-Za-z0-9+/]{22}==$/)
        })
        .strict()
        .parse(request.body);
      const transfer = await options.store.getTransferById(transferId);
      if (!transfer || "nodeId" in transfer.args.source) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "Agent upload was not found");
      }
      const principal = principals.get(request)!;
      await authorizeTransfer(principal, transfer, true);
      if (principal.kind !== "agent") {
        return apiError(
          reply,
          403,
          ErrorCodes.DENIED,
          "Agent uploads require their originating Agent credential"
        );
      }
      const grant = await options.store.getGrant(principal.grantId);
      const destination = await options.store.getNode(transfer.args.destination.nodeId);
      if (
        !grant ||
        !destination ||
        (
          await policyFor(
            transferChildInvocation(transfer.invocation, transferId, "destination"),
            grant,
            destination
          )
        ).outcome === "deny"
      ) {
        return apiError(reply, 403, ErrorCodes.DENIED, "transfer authorization was revoked");
      }
      if (
        !["queued", "transferring", "verifying"].includes(transfer.status) ||
        Date.parse(transfer.invocation.expiresAt) <= now().getTime() ||
        transfer.chunkCount === undefined ||
        index >= transfer.chunkCount
      ) {
        return apiError(reply, 409, ErrorCodes.CONFLICT, "Agent upload is not active");
      }
      reply.header("cache-control", "no-store");
      return uploadTicket(transfer, index, body.sha256, body.contentMd5);
    }
  );

  async function requireAuthenticated(request: FastifyRequest, reply: FastifyReply) {
    const principal = await options.access.authenticate(request);
    if (!principal) {
      reply.header(
        "www-authenticate",
        `Bearer resource_metadata="${options.access.origin}/.well-known/oauth-protected-resource/mcp"`
      );
      return apiError(reply, 401, ErrorCodes.DENIED, "Sign in or supply a valid Agent credential.");
    }
    if (principal.kind === "session") assertSameOrigin(request, options.access.origin);
    principals.set(request, principal);
  }

  async function requireOwner(request: FastifyRequest, reply: FastifyReply) {
    await requireAuthenticated(request, reply);
    const principal = principals.get(request);
    if (reply.sent || !principal) return;
    if (principal.kind !== "session" && principal.kind !== "pat") {
      return apiError(reply, 403, ErrorCodes.DENIED, "Account management requires a user session.");
    }
    if (
      principal.kind === "pat" &&
      principal.readOnly &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method)
    ) {
      return apiError(reply, 403, ErrorCodes.DENIED, "This personal access token is read-only.");
    }
    if (principal.team?.membership.role === "member" &&
        !/^\/api\/v1\/(?:me|node-installation(?:\?|$)|nodes(?:\?|$)|overview(?:\?|$)|approvals(?:\/|\?|$)|grants(?:\/|\?|$)|credentials(?:\/|\?|$)|oauth\/bindings(?:\/|\?|$))/.test(request.url))
      return apiError(reply, 403, ErrorCodes.DENIED, "Team administration requires an owner or admin.");
  }

  async function dispatchAuthorized(
    dispatch: { invocation: Invocation; nodeId: string; policyDecision: PolicyDecision },
    approving = false
  ): Promise<boolean> {
    const { invocation } = dispatch;
    // Node rejects expired new work and reconciles already durable receipts.
    // Expiry must not replace a completed side effect with "cancelled".
    const grant = await options.store.getGrant(invocation.authorization.grantId);
    const node = await options.store.getNode(dispatch.nodeId);
    if (
      !grant ||
      grant.revokedAt ||
      grant.accountId !== invocation.accountId ||
      grant.actorId !== invocation.actor.id ||
      !node ||
      (!collaboration && node.accountId !== invocation.accountId) ||
      (grant.projectId && grant.projectId !== invocation.authorization.projectId)
    )
      return false;
    const decision = await policyFor(invocation, grant, node);
    if (invocation.delegation && decision.outcome === "approval_required" && !approving) {
      const approval = await options.store.getApprovalByInvocation(invocation.invocationId);
      if (!approval || approval.status !== "approved" ||
          approval.requiredConsents?.some((required) => !approval.consents?.some((consent) =>
            consent.accountId === required.accountId && (!required.userId || required.userId === consent.userId))))
        return false;
    }
    return (
      decision.outcome === "allow" ||
      (decision.outcome === "approval_required" &&
        (approving || dispatch.policyDecision.reasonCode === "approval.granted"))
    );
  }

  async function policyFor(
    invocation: Invocation,
    grant: AgentGrantRecord,
    node: NonNullable<Awaited<ReturnType<Store["getNode"]>>>
  ): Promise<PolicyDecision> {
    if (collaboration) {
      const authorized = await collaboration.authorizeInvocation(invocation, grant, node);
      if (!authorized || node.resourceClass === "platform") {
        const unsigned = {
          outcome: "deny" as const, reasonCode: "resource.authorization_changed",
          explanation: "Device sharing, membership or execution permissions are unavailable.",
          evaluatedLayers: ["account", "agent", "node", "root", "capability"] as const, profile: grant.profile
        };
        return { ...unsigned, evaluatedLayers: [...unsigned.evaluatedLayers], decisionHash: sha256(unsigned) };
      }
      node = authorized;
    }
    const capability = effectiveCapability(node);
    const roots = grant.projectId
      ? await options.store.listRoots(grant.projectId)
      : (capability?.roots ?? []).map((root) => ({ ...root, nodeId: node.nodeId }));
    return evaluatePolicy(
      {
        account: {
          allowedTools: [
            ...new Set([
              ...ToolNameSchema.options,
              ...(capability?.tools.map((tool) => tool.name) ?? [])
            ])
          ],
          deniedTools: [],
          approvalRequiredTools: invocation.delegation &&
            requiresApproval(invocation.delegation.scope.approvalPolicy, "workspace-write", invocation.tool)
              ? [invocation.tool] : [],
          unattendedAllowed: grant.profile === "unattended"
        },
        agent: {
          profile: grant.profile,
          nodeIds: grant.nodeIds,
          rootIds:
            grant.rootAccess === "all"
              ? (capability?.roots.map((root) => root.rootId) ?? [])
              : grant.rootIds,
          ...(grant.approvalPolicy ? { approvalPolicy: grant.approvalPolicy } : {}),
          allowedTools: grant.allowedTools
        },
        node: {
          nodeId: node.nodeId,
          revoked: node.status === "revoked",
          online:
            node.status === "active" &&
            !!node.lastSeenAt &&
            now().getTime() - Date.parse(node.lastSeenAt) <= presenceTtlMs,
          advertisedTools: capability?.tools.map((tool) => tool.name) ?? [],
          disabledTools: [],
          roots: roots
            .filter(
              (root) =>
                root.nodeId === node.nodeId &&
                capability?.roots.some((entry) => entry.rootId === root.rootId)
            )
            .map((root) => {
              const advertised = capability?.roots.find((entry) => entry.rootId === root.rootId);
              return {
                rootId: root.rootId,
                ...(advertised?.path ? { path: advertised.path } : {}),
                writable: root.writable && !!advertised?.writable
              };
            })
        }
      },
      invocation
    );
  }

  function transferChildInvocation(
    parent: Invocation,
    transferId: string,
    role: "source" | "destination"
  ): Invocation {
    const args = FileTransferArgsSchema.parse(parent.args);
    const endpoint = args[role];
    if (!("nodeId" in endpoint)) {
      throw new ProtocolError(
        ErrorCodes.INVALID_REQUEST,
        "Agent upload has no source dispatch",
        false
      );
    }
    return InvocationSchema.parse({
      ...parent,
      invocationId: createId("inv"),
      attemptId: createId("att"),
      target: { nodeId: endpoint.nodeId },
      authorization: { ...parent.authorization, rootIds: [endpoint.rootId] },
      idempotencyKey: `${transferId}-${role}`,
      metadata: {
        ...parent.metadata,
        source: "internal",
        correlationId: transferId
      }
    });
  }

  function transferDispatches(
    parent: Invocation,
    transferId: string,
    decisions: { source: PolicyDecision; destination: PolicyDecision },
    createdAt: string
  ): DispatchRecord[] {
    const child = (role: "source" | "destination", decision: PolicyDecision): DispatchRecord => {
      const invocation = transferChildInvocation(parent, transferId, role);
      return {
        dispatchId: createId("dsp"),
        invocation,
        nodeId: (invocation.target as { nodeId: string }).nodeId,
        policyDecision: decision,
        status: "queued",
        createdAt,
        updatedAt: createdAt
      };
    };
    return [
      ...("nodeId" in FileTransferArgsSchema.parse(parent.args).source
        ? [child("source", decisions.source)]
        : []),
      child("destination", decisions.destination)
    ];
  }

  function transferAudits(
    invocation: Invocation,
    transferId: string,
    dispatches: DispatchRecord[],
    createdAt: string
  ): AuditEvent[] {
    const args = FileTransferArgsSchema.parse(invocation.args);
    const event = (dispatch: DispatchRecord): AuditEvent => ({
      eventId: createId("dsp"),
      accountId: invocation.accountId,
      invocationId: invocation.invocationId,
      type: "dispatch.queued",
      payload: {
        transferId,
        dispatchId: dispatch.dispatchId,
        nodeId: dispatch.nodeId,
        role:
          "nodeId" in args.source && dispatch.nodeId === args.source.nodeId
            ? "source"
            : "destination",
        policyDecision: dispatch.policyDecision
      },
      createdAt
    });
    return dispatches.map(event);
  }

  async function requireNode(request: FastifyRequest, reply: FastifyReply) {
    const nodeId = request.headers["x-adc-node-id"];
    const timestamp = request.headers["x-adc-timestamp"];
    const nonce = request.headers["x-adc-nonce"];
    const signature = request.headers["x-adc-signature"];
    if (
      typeof nodeId !== "string" ||
      typeof timestamp !== "string" ||
      typeof nonce !== "string" ||
      typeof signature !== "string"
    ) {
      return apiError(reply, 401, ErrorCodes.DENIED, "device proof is required");
    }
    if ((request.params as any)?.nodeId !== nodeId) {
      return apiError(reply, 403, ErrorCodes.DENIED, "device identity does not match route");
    }
    const requestTime = Date.parse(timestamp);
    if (!Number.isFinite(requestTime) || Math.abs(now().getTime() - requestTime) > 5 * 60_000) {
      return apiError(reply, 401, ErrorCodes.EXPIRED, "device proof timestamp is stale");
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
      return apiError(reply, 401, ErrorCodes.INVALID_REQUEST, "invalid device proof nonce");
    }
    const path = request.url.split("?")[0]!;
    const wakeGeneration = path.endsWith("/events") ? wakeHub.generation(nodeId) : undefined;
    const node = await options.store.getNode(nodeId);
    if (!node || node.status !== "active") {
      return apiError(reply, 401, ErrorCodes.DENIED, "device is unknown or revoked");
    }
    if (
      !verifyNodeRequest(node.publicKey, signature, {
        method: request.method,
        path,
        timestamp,
        nonce,
        body: request.body
      })
    ) {
      return apiError(reply, 401, ErrorCodes.DENIED, "invalid device proof");
    }
    const fresh = await options.store.consumeNodeNonce(
      nodeId,
      nonce,
      new Date(requestTime + 5 * 60_000)
    );
    if (!fresh) {
      return apiError(reply, 409, ErrorCodes.CONFLICT, "device proof was already used");
    }
    nodeAccounts.set(request, node.accountId);
    if (wakeGeneration !== undefined) nodeWakeGenerations.set(request, wakeGeneration);
    if (
      node.capability &&
      !wakeHub.has(nodeId) &&
      !path.endsWith("/poll") &&
      !path.endsWith("/events")
    ) {
      await options.store.touchNodePresences([nodeId], now());
    }
  }

  app.route({
    method: "GET",
    url: "/api/v1/nodes/:nodeId/events",
    preValidation: requireNode,
    handler: async (_request, reply) =>
      reply
        .code(426)
        .header("upgrade", "websocket")
        .send({ error: { code: ErrorCodes.INVALID_REQUEST, message: "WebSocket required." } }),
    wsHandler: (socket, request) => {
      const { nodeId } = z.object({ nodeId: z.string() }).parse(request.params);
      wakeHub.connect(nodeId, socket, nodeWakeGenerations.get(request));
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProtocolError) {
      const statusCode =
        error.code === ErrorCodes.NOT_FOUND
          ? 404
          : error.code === ErrorCodes.CONFLICT
            ? 409
            : error.code === ErrorCodes.DENIED
              ? 403
              : 400;
      return apiError(reply, statusCode, error.code, error.message, error.retryable, error.details);
    }
    if (error instanceof z.ZodError) {
      return apiError(reply, 400, ErrorCodes.INVALID_REQUEST, "request validation failed", false, {
        issues: error.issues
      });
    }
    requestLogError(app, error);
    return apiError(reply, 500, ErrorCodes.INTERNAL, "internal control plane error", true);
  });

  app.get("/health", async () => {
    if (options.access.identity) await options.access.identity.pool.query("SELECT 1");
    return { ok: true, schemaVersion: "0.1" };
  });
  registerResourceManagement(app, {
    store: options.store,
    requireOwner,
    accountOf,
    now,
    disconnectNode: (nodeId) => wakeHub.disconnect(nodeId, "device removed"),
    wakeNode,
    authorizeGrant: assertGrantManager,
    ...(collaboration ? { grantResources: async (request: FastifyRequest, body: z.infer<typeof GrantSettingsSchema>, previous?: AgentGrantRecord) => ({
      ...await collaboration.validateGrant(principals.get(request)!, body, body.resourceBindings, previous),
      nodes: await userNodes(principals.get(request)!)
    }) } : {})
  });
  registerAccountRoutes(app, {
    access: options.access,
    store: options.store,
    requireSession: requireOwner,
    requireAuthenticated,
    principal: (request) => principals.get(request)!,
    ...(collaboration ? { collaboration, grantNodes, assertGrantManager } : {})
  });
  if (collaboration) registerCollaborationRoutes(app, {
    authorization: collaboration, requireAuthenticated,
    principal: (request) => principals.get(request)!, origin: options.access.origin, wakeNode
  });
  app.get("/api/v1/overview", { preHandler: requireOwner }, async (request) => {
    const accountId = accountOf(request);
    const actor = principals.get(request)!;
    if (actor.kind !== "agent" && actor.team) {
      const nodes = await userNodes(actor);
      const grants = (await options.store.listGrants(accountId)).filter((grant) =>
        !grant.revokedAt && grant.responsibleUserId === principalUserId(actor));
      return {
        counts: {
          connectedDevices: nodes.length,
          onlineNow: nodes.filter((node) => !!node.lastSeenAt &&
            now().getTime() - Date.parse(node.lastSeenAt) <= presenceTtlMs).length,
          activeAgents: grants.length, pendingApprovals: 0, clientConnections: 0
        },
        recentActivity: []
      };
    }
    const timestamp = now();
    const [resources, activeConnections, activity] = await Promise.all([
      options.store.getAccountResourceSummary(
        accountId,
        new Date(timestamp.getTime() - presenceTtlMs).toISOString(),
        timestamp.toISOString()
      ),
      options.access.identity?.countActiveConnections(accountId, timestamp.toISOString()) ??
        Promise.resolve(0),
      options.store.listAuditPage(accountId, { limit: 5 })
    ]);
    return {
      counts: {
        connectedDevices: resources.activeNodes,
        onlineNow: resources.onlineNodes,
        activeAgents: resources.activeGrants,
        pendingApprovals: resources.pendingApprovals,
        clientConnections: activeConnections
      },
      recentActivity: await auditView(options.store, accountId, activity.events)
    };
  });
  app.get("/metrics", { preHandler: requireOwner }, async (_request, reply) => {
    return reply.type(metrics.contentType).send(await metrics.metrics());
  });

  app.post("/api/v1/pairing-codes", { preHandler: requireOwner }, async (request) => {
    const accountId = accountOf(request);
    const body = z
      .object({ ttlSeconds: z.number().int().min(60).max(3600).default(600) })
      .strict()
      .parse(request.body);
    const code = randomBytes(9).toString("base64url");
    const expiresAt = new Date(now().getTime() + body.ttlSeconds * 1000).toISOString();
    await options.store.putPairingCode({
      codeHash: hash(code),
      accountId,
      expiresAt
    });
    return { code, expiresAt };
  });

  app.post("/api/v1/nodes/pair", async (request, reply) => {
    if (
      options.access.identity &&
      !(await options.access.identity.takeRateLimit(`pair:${request.ip}`, 20, 60))
    ) {
      return apiError(reply, 429, ErrorCodes.DENIED, "Too many pairing attempts.", true);
    }
    const body = z
      .object({
        code: z.string().min(8).max(128),
        label: z.string().min(1).max(128),
        platform: NodePlatformSchema,
        publicKey: z.string().min(64).max(8192)
      })
      .strict()
      .parse(request.body);
    const publicKey = createPublicKey(body.publicKey);
    if (
      publicKey.asymmetricKeyType !== "ed25519" &&
      !(
        publicKey.asymmetricKeyType === "ec" &&
        publicKey.asymmetricKeyDetails?.namedCurve === "prime256v1"
      )
    ) {
      return apiError(
        reply,
        400,
        ErrorCodes.INVALID_REQUEST,
        "device key must be Ed25519 or P-256"
      );
    }
    const paired = await options.store.pairNode({
      codeHash: hash(body.code),
      now: now(),
      node: {
        nodeId: createId("node"),
        label: body.label,
        publicKey: body.publicKey,
        platform: body.platform,
        status: "active",
        accessPolicy: defaultNodeAccessPolicy(),
        createdAt: now().toISOString()
      }
    });
    if (!paired) {
      pairingCounter.inc({ outcome: "denied" });
      return apiError(reply, 400, ErrorCodes.DENIED, "pairing code is invalid, expired or used");
    }
    for (const nodeId of paired.replacedNodeIds) {
      wakeHub.disconnect(nodeId, "device replaced");
    }
    pairingCounter.inc({ outcome: "succeeded" });
    return { nodeId: paired.node.nodeId, accountId: paired.node.accountId };
  });

  app.get("/api/v1/nodes", { preHandler: requireOwner }, async (request) => {
    const release = await latestNodeRelease(options.nodeDistribution);
    return {
      nodes: (await userNodes(principals.get(request)!)).map((node) => {
        const { publicKey: _publicKey, ...view } = node;
        return ({
        ...view,
        accessPolicy: {
          ...defaultNodeAccessPolicy(),
          ...(node.resourceAuthorization ? {
            rootAccess: "selected" as const,
            rootIds: node.resourceAuthorization.scope.roots.map((root) => root.rootId),
            readOnlyRootIds: node.resourceAuthorization.scope.roots.filter((root) => !root.writable).map((root) => root.rootId),
            allowExecution: node.resourceAuthorization.scope.execution !== "read-only"
          } : node.accessPolicy),
          maxConcurrency: nodeMaxConcurrency(node)
        },
        effectiveCapability: effectiveCapability(node),
        online:
          node.status === "active" &&
          !!node.lastSeenAt &&
          now().getTime() - Date.parse(node.lastSeenAt) <= presenceTtlMs,
        ...(node.platform !== "android"
          ? {
              update: nodeReleaseUpdate(node.capability?.buildId, release, node.capability?.nodeVersion)
            }
          : {})
      }); })
    };
  });

  app.post("/api/v1/nodes/:nodeId/revoke", { preHandler: requireOwner }, async (request, reply) => {
    const { nodeId } = z.object({ nodeId: z.string() }).parse(request.params);
    const node = await options.store.getNode(nodeId);
    if (!node || node.accountId !== accountOf(request) || node.deletedAt) {
      return apiError(reply, 404, ErrorCodes.NOT_FOUND, "device was not found");
    }
    if (!(await options.store.revokeNode(nodeId, now()))) {
      return apiError(reply, 404, ErrorCodes.NOT_FOUND, "device was not found");
    }
    wakeHub.disconnect(nodeId, "device revoked");
    await options.store.putAudit({
      eventId: createId("dsp"),
      accountId: node.accountId,
      type: "node.revoked",
      payload: { nodeId, label: node.label },
      createdAt: now().toISOString()
    });
    return { revoked: true, nodeId };
  });

  app.post(
    "/api/v1/nodes/:nodeId/rotate-key",
    { preHandler: requireNode },
    async (request, reply) => {
      const { nodeId } = z.object({ nodeId: z.string() }).parse(request.params);
      const { publicKey } = z
        .object({ publicKey: z.string().min(64).max(8192) })
        .strict()
        .parse(request.body);
      const key = createPublicKey(publicKey);
      if (
        key.asymmetricKeyType !== "ed25519" &&
        !(key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1")
      ) {
        return apiError(
          reply,
          400,
          ErrorCodes.INVALID_REQUEST,
          "device key must be Ed25519 or P-256"
        );
      }
      if (!(await options.store.rotateNodeKey(nodeId, publicKey, now()))) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "device was not found");
      }
      wakeHub.disconnect(nodeId, "device key rotated");
      await options.store.putAudit({
        eventId: createId("dsp"),
        accountId: nodeAccounts.get(request)!,
        type: "node.key_rotated",
        payload: { nodeId },
        createdAt: now().toISOString()
      });
      return { rotated: true, nodeId };
    }
  );

  app.post("/api/v1/projects", { preHandler: requireOwner }, async (request) => {
    const accountId = accountOf(request);
    const body = z
      .object({
        projectId: z
          .string()
          .regex(/^proj_[a-z0-9][a-z0-9_-]{2,127}$/)
          .default(() => createId("proj")),
        label: z.string().trim().min(1).max(128)
      })
      .strict()
      .parse(request.body);
    const project = {
      ...body,
      accountId,
      revision: 1,
      createdAt: now().toISOString()
    };
    await options.store.putProject(project, true, {
      eventId: createId("dsp"), accountId, type: "project.created",
      payload: { projectId: project.projectId, label: project.label }, createdAt: project.createdAt
    });
    return project;
  });

  app.get("/api/v1/projects", { preHandler: requireOwner }, async (request) => {
    const accountId = accountOf(request);
    const { include } = z
      .object({ include: z.literal("roots").optional() })
      .strict()
      .parse(request.query);
    const projects = await options.store.listProjects(accountId);
    if (include !== "roots") return { projects };
    const [roots, listedNodes] = await Promise.all([
      options.store.listRootsForAccount(accountId),
      options.store.listNodes(accountId)
    ]);
    const nodes = new Map(listedNodes.map((node) => [node.nodeId, node]));
    return {
      projects,
      roots: roots.map((root) => {
        const advertised = nodes
          .get(root.nodeId)
          ?.capability?.roots.find((candidate) => candidate.rootId === root.rootId);
        return { ...root, ...(advertised?.path ? { path: advertised.path } : {}) };
      })
    };
  });

  app.get(
    "/api/v1/projects/:projectId/roots",
    { preHandler: requireOwner },
    async (request, reply) => {
      const accountId = accountOf(request);
      const { projectId } = z.object({ projectId: z.string() }).parse(request.params);
      const project = await options.store.getProject(projectId);
      if (!project || project.accountId !== accountId) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "project was not found");
      }
      const nodes = new Map(
        (await options.store.listNodes(accountId)).map((node) => [node.nodeId, node])
      );
      return {
        roots: (await options.store.listRoots(projectId)).map((root) => {
          const advertised = nodes
            .get(root.nodeId)
            ?.capability?.roots.find((candidate) => candidate.rootId === root.rootId);
          return { ...root, ...(advertised?.path ? { path: advertised.path } : {}) };
        })
      };
    }
  );

  app.post(
    "/api/v1/projects/:projectId/roots",
    { preHandler: requireOwner },
    async (request, reply) => {
      const accountId = accountOf(request);
      const { projectId } = z.object({ projectId: z.string() }).parse(request.params);
      const project = await options.store.getProject(projectId);
      if (!project || project.accountId !== accountId) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "project was not found");
      }
      const body = z
        .object({
          rootId: z.string().regex(/^root_[a-z0-9][a-z0-9_-]{2,127}$/),
          nodeId: z.string().regex(/^node_[a-z0-9][a-z0-9_-]{2,127}$/),
          label: z.string().trim().min(1).max(128),
          writable: z.boolean()
        })
        .strict()
        .parse(request.body);
      const node = await options.store.getNode(body.nodeId);
      if (!node || node.accountId !== accountId) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "device was not found");
      }
      const advertisedRoot = effectiveCapability(node)?.roots.find((root) => root.rootId === body.rootId);
      if (node.status !== "active" || node.deletedAt || !advertisedRoot || (body.writable && !advertisedRoot.writable)) {
        return apiError(
          reply,
          400,
          ErrorCodes.DENIED,
          "Root must be advertised by the device with compatible access."
        );
      }
      const root = { ...body, projectId, createdAt: now().toISOString() };
      const saved = await options.store.putRoot(root, true, {
        eventId: createId("dsp"), accountId, type: "project.folder_added",
        payload: { projectId, rootId: root.rootId, nodeId: root.nodeId, label: root.label, writable: root.writable },
        createdAt: root.createdAt
      });
      return { ...saved, ...(advertisedRoot.path ? { path: advertisedRoot.path } : {}) };
    }
  );

  app.post("/api/v1/grants", { preHandler: requireOwner }, async (request) => {
    const accountId = accountOf(request);
    const body = GrantSettingsSchema.extend({
      grantId: z
        .string()
        .regex(/^grant_[a-z0-9][a-z0-9_-]{2,127}$/)
        .default(() => createId("grant")),
      actorId: z
        .string()
        .regex(/^actor_[a-z0-9][a-z0-9_-]{2,127}$/)
        .default(() => createId("actor")),
      name: z.string().min(1).max(128).default("Agent"),
      profile: z
        .enum(["read-only", "workspace-write", "approve-required", "unattended"])
        .default("workspace-write"),
      rootAccess: z.enum(["selected", "all"]).default("selected"),
      rootIds: z.array(z.string()).max(64).default([])
    }).parse(request.body);
    const resources = await collaboration?.validateGrant(principals.get(request)!, body, body.resourceBindings);
    await validateGrantResources(options.store, accountId, body, undefined, resources ? await userNodes(principals.get(request)!) : undefined);
    const { projectId, approvalPolicy, resourceBindings: _requestedBindings, ...fields } = body;
    const grant: AgentGrantRecord = {
      ...fields,
      ...(projectId ? { projectId } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
      accountId,
      ...(resources ? resources : {}),
      revision: 1,
      createdAt: now().toISOString()
    };
    await options.store.putGrant(grant, true);
    await options.store.putAudit({
      eventId: createId("dsp"),
      accountId,
      type: "grant.saved",
      payload: {
        grantId: grant.grantId,
        nodeIds: grant.nodeIds,
        rootAccess: grant.rootAccess,
        rootIds: grant.rootIds,
        approvalPolicy: grant.approvalPolicy ?? "legacy",
        allowedTools: grant.allowedTools
      },
      createdAt: now().toISOString()
    });
    return grant;
  });

  app.post("/api/v1/nodes/:nodeId/poll", { preHandler: requireNode }, async (request, reply) => {
    const { nodeId } = z.object({ nodeId: z.string() }).parse(request.params);
    const body = z
      .object({
        capability: CapabilitySchema,
        activeTaskCount: z.number().int().min(0).max(MAX_NODE_MAX_CONCURRENCY).default(0),
        claim: z.boolean().default(true),
        waitMs: z.number().int().min(0).max(25_000).default(0)
      })
      .strict()
      .parse(request.body);
    if (body.capability.nodeId !== nodeId) {
      return apiError(reply, 400, ErrorCodes.INVALID_REQUEST, "capability nodeId mismatch");
    }
    if (!(await options.store.updateNodePresence(nodeId, body.capability, now()))) {
      pollCounter.inc({ outcome: "denied" });
      return apiError(reply, 401, ErrorCodes.DENIED, "device is revoked");
    }
    const node = await options.store.getNode(nodeId);
    const maxConcurrency = node
      ? nodeMaxConcurrency(node)
      : defaultNodeAccessPolicy().maxConcurrency;
    const canClaim = body.claim && body.activeTaskCount < maxConcurrency;
    const claimAuthorized = async () => {
      let candidate = canClaim ? await options.store.claim(nodeId, now(), leaseMs) : undefined;
      // Re-evaluate queued work after policy changes. A bounded loop avoids one
      // revoked grant indefinitely blocking unrelated work on the same device.
      for (let checked = 0; candidate && !(await dispatchAuthorized(candidate)); checked++) {
        const cancelled = await options.store.requestCancel(candidate.dispatchId, now());
        if (cancelled?.status === "cancel_requested") return cancelled;
        if (checked >= 19) return undefined;
        candidate = await options.store.claim(nodeId, now(), leaseMs);
      }
      return candidate;
    };
    const wakeSequence = wakeHub.wakeSequence(nodeId);
    let dispatch = await claimAuthorized();
    if (!dispatch && canClaim && body.waitMs > 0) {
      await wakeHub.wait(nodeId, wakeSequence, body.waitMs);
      dispatch = await claimAuthorized();
    }
    pollCounter.inc({ outcome: dispatch ? "dispatched" : "idle" });
    const release =
      body.capability.platform === "android"
        ? undefined
        : await latestNodeRelease(options.nodeDistribution);
    return {
      dispatch: dispatch ?? null,
      maxConcurrency,
      ...(body.waitMs > 0 ? { longPoll: true } : {}),
      ...(body.capability.platform !== "android" ? { update: nodeReleaseUpdate(body.capability.buildId, release, body.capability.nodeVersion) } : {})
    };
  });

  app.post("/api/v1/nodes/:nodeId/ack", { preHandler: requireNode }, async (request, reply) => {
    const { nodeId } = z.object({ nodeId: z.string() }).parse(request.params);
    const body = z
      .object({ dispatchId: z.string(), leaseToken: z.string() })
      .strict()
      .parse(request.body);
    const current = await options.store.getDispatchById(body.dispatchId);
    if (!current || current.nodeId !== nodeId) {
      return apiError(
        reply,
        409,
        ErrorCodes.DENIED,
        "Dispatch is unavailable or authorization was revoked."
      );
    }
    if (!(await dispatchAuthorized(current))) {
      const cancelled = await options.store.requestCancel(body.dispatchId, now());
      if (cancelled?.status !== "cancel_requested") {
        return apiError(reply, 409, ErrorCodes.DENIED, "Dispatch authorization was revoked.");
      }
    }
    const dispatch = await options.store.acknowledge(body.dispatchId, body.leaseToken, now());
    if (!dispatch || dispatch.nodeId !== nodeId) {
      return apiError(reply, 409, ErrorCodes.LEASE_EXPIRED, "lease is invalid or expired");
    }
    return {
      acknowledged: true,
      cancelRequested: dispatch.status === "cancel_requested",
      leaseExpiresAt: dispatch.leaseExpiresAt
    };
  });

  app.post(
    "/api/v1/nodes/:nodeId/leases/renew",
    { preHandler: requireNode },
    async (request, reply) => {
      const { nodeId } = z.object({ nodeId: z.string() }).parse(request.params);
      const body = z
        .object({ dispatchId: z.string(), leaseToken: z.string() })
        .strict()
        .parse(request.body);
      const current = await options.store.getDispatchById(body.dispatchId);
      if (!current || current.nodeId !== nodeId) {
        return apiError(reply, 409, ErrorCodes.LEASE_EXPIRED, "lease is invalid or expired");
      }
      if (!(await dispatchAuthorized(current)))
        await options.store.requestCancel(body.dispatchId, now());
      const dispatch = await options.store.renewLease(
        body.dispatchId,
        body.leaseToken,
        now(),
        leaseMs
      );
      if (!dispatch || dispatch.nodeId !== nodeId) {
        return apiError(reply, 409, ErrorCodes.LEASE_EXPIRED, "lease is invalid or expired");
      }
      return {
        renewed: true,
        leaseExpiresAt: dispatch.leaseExpiresAt,
        cancelRequested: dispatch.status === "cancel_requested"
      };
    }
  );

  app.post(
    "/api/v1/nodes/:nodeId/receipts",
    { preHandler: requireNode },
    async (request, reply) => {
      const { nodeId } = z.object({ nodeId: z.string() }).parse(request.params);
      const body = z
        .object({
          dispatchId: z.string(),
          leaseToken: z.string(),
          result: ResultSchema,
          receipt: z.unknown().optional()
        })
        .strict()
        .parse(request.body);
      const current = await options.store.getDispatchById(body.dispatchId);
      if (
        !current ||
        current.nodeId !== nodeId ||
        current.invocation.invocationId !== body.result.invocationId ||
        current.invocation.attemptId !== body.result.attemptId ||
        !["succeeded", "failed", "denied", "cancelled", "unknown_outcome"].includes(
          body.result.status
        ) ||
        (body.result.receipt &&
          (body.result.receipt.nodeId !== nodeId ||
            body.result.receipt.invocationId !== current.invocation.invocationId ||
            body.result.receipt.attemptId !== current.invocation.attemptId ||
            body.result.receipt.tool !== current.invocation.tool ||
            body.result.receipt.terminalStatus !== body.result.status))
      ) {
        return apiError(reply, 400, ErrorCodes.INVALID_REQUEST, "receipt does not match dispatch");
      }
      const completed = await options.store.complete(
        body.dispatchId,
        body.leaseToken,
        body.result,
        body.result.receipt,
        now()
      );
      if (!completed) {
        return apiError(reply, 409, ErrorCodes.LEASE_EXPIRED, "lease is invalid or superseded");
      }
      taskWaitHub.notify(completed.dispatchId);
      const transfer = await options.store.reconcileTransfer(completed.dispatchId, now());
      if (transfer) {
        taskWaitHub.notify(transfer.transferId);
        if (
          ["succeeded", "failed", "denied", "cancelled", "unknown_outcome"].includes(
            transfer.status
          )
        ) {
          await cleanupTransfer(transfer.transferId);
        }
      }
      countInvocation(completed.status, completed.invocation.tool);
      return { accepted: true, status: completed.status };
    }
  );

  app.post(
    "/api/v1/nodes/:nodeId/transfers/:transferId/prepare",
    { preHandler: requireNode },
    async (request, reply) => {
      if (!options.transferStore && !options.directTransferStore)
        return apiError(reply, 503, ErrorCodes.OFFLINE, "transfer storage is unavailable", true);
      const { nodeId, transferId } = z
        .object({ nodeId: z.string(), transferId: TransferIdSchema })
        .parse(request.params);
      const body = z
        .object({
          byteSize: z.number().int().min(0).max(maxTransferBytes),
          chunkCount: z.number().int().min(0).max(1_000_000)
        })
        .strict()
        .parse(request.body);
      const current = await options.store.getTransferById(transferId);
      if (
        !current ||
        (current.invocation.delegation?.resourceAccountId ?? current.invocation.accountId) !== nodeAccounts.get(request) ||
        !("nodeId" in current.args.source) ||
        current.args.source.nodeId !== nodeId
      ) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "transfer was not found");
      }
      const expectedChunkCount = Math.ceil(body.byteSize / current.args.chunkSizeBytes);
      if (body.chunkCount !== expectedChunkCount) {
        return apiError(
          reply,
          400,
          ErrorCodes.INVALID_REQUEST,
          "transfer chunk count does not match its declared size"
        );
      }
      const transfer = await options.store.prepareTransfer(transferId, nodeId, body);
      if (!transfer || transfer.invocation.accountId !== nodeAccounts.get(request)) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "transfer was not found");
      }
      taskWaitHub.notify(transferId);
      return {
        accepted: true,
        transferId,
        byteSize: transfer.byteSize,
        chunkCount: transfer.chunkCount
      };
    }
  );

  app.put(
    "/api/v1/nodes/:nodeId/transfers/:transferId/chunks/:index",
    { preHandler: requireNode },
    async (request, reply) => {
      if (!options.transferStore)
        return apiError(reply, 503, ErrorCodes.OFFLINE, "transfer storage is unavailable", true);
      const { nodeId, transferId, index } = z
        .object({
          nodeId: z.string(),
          transferId: TransferIdSchema,
          index: z.coerce.number().int().min(0).max(999_999)
        })
        .parse(request.params);
      const transfer = await options.store.getTransferById(transferId);
      if (
        !transfer ||
        transfer.invocation.accountId !== nodeAccounts.get(request) ||
        !("nodeId" in transfer.args.source) ||
        transfer.args.source.nodeId !== nodeId ||
        !["transferring", "verifying"].includes(transfer.status) ||
        transfer.byteSize === undefined ||
        transfer.chunkCount === undefined ||
        index >= transfer.chunkCount
      ) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "transfer chunk was not found");
      }
      const data = request.body;
      const digest = request.headers["x-adc-content-sha256"];
      if (!Buffer.isBuffer(data) || typeof digest !== "string") {
        return apiError(
          reply,
          400,
          ErrorCodes.INVALID_REQUEST,
          "binary chunk and SHA-256 are required"
        );
      }
      const expectedBytes = Math.min(
        transfer.args.chunkSizeBytes,
        transfer.byteSize - index * transfer.args.chunkSizeBytes
      );
      if (data.byteLength !== expectedBytes) {
        return apiError(
          reply,
          400,
          ErrorCodes.INVALID_REQUEST,
          "transfer chunk size does not match its index"
        );
      }
      await options.transferStore.putChunk(transferId, index, data, digest);
      taskWaitHub.notify(transferId);
      return { accepted: true, transferId, index, bytes: data.byteLength };
    }
  );

  app.post(
    "/api/v1/nodes/:nodeId/transfers/:transferId/chunks/:index/ticket",
    { preHandler: requireNode },
    async (request, reply) => {
      if (!options.directTransferStore) {
        return apiError(
          reply,
          503,
          ErrorCodes.OFFLINE,
          "direct transfer storage is unavailable",
          true
        );
      }
      const { nodeId, transferId, index } = z
        .object({
          nodeId: z.string(),
          transferId: TransferIdSchema,
          index: z.coerce.number().int().min(0).max(999_999)
        })
        .parse(request.params);
      const body = z
        .discriminatedUnion("operation", [
          z
            .object({
              operation: z.literal("upload"),
              sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
              contentMd5: z.string().regex(/^[A-Za-z0-9+/]{22}==$/)
            })
            .strict(),
          z.object({ operation: z.literal("download") }).strict()
        ])
        .parse(request.body);
      const transfer = await options.store.getTransferById(transferId);
      if (
        !transfer ||
        transfer.invocation.accountId !== nodeAccounts.get(request) ||
        !(
          ["transferring", "verifying"].includes(transfer.status) ||
          (!("nodeId" in transfer.args.source) && transfer.status === "queued")
        ) ||
        Date.parse(transfer.invocation.expiresAt) <= now().getTime() ||
        transfer.chunkCount === undefined ||
        transfer.byteSize === undefined ||
        index >= transfer.chunkCount ||
        nodeId !==
          (body.operation === "upload"
            ? "nodeId" in transfer.args.source
              ? transfer.args.source.nodeId
              : undefined
            : transfer.args.destination.nodeId)
      ) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "transfer chunk was not found");
      }
      const bytes = Math.min(
        transfer.args.chunkSizeBytes,
        transfer.byteSize - index * transfer.args.chunkSizeBytes
      );
      const dispatchId =
        body.operation === "upload" ? transfer.sourceDispatchId : transfer.destinationDispatchId;
      const dispatch = dispatchId ? await options.store.getDispatchById(dispatchId) : undefined;
      if (!dispatch || !(await dispatchAuthorized(dispatch))) {
        return apiError(reply, 403, ErrorCodes.DENIED, "transfer authorization was revoked");
      }
      reply.header("cache-control", "no-store");
      if (body.operation === "upload")
        return uploadTicket(transfer, index, body.sha256, body.contentMd5);
      try {
        const ticket = await options.directTransferStore.downloadTicket(transferId, index);
        if (ticket.bytes !== bytes) {
          return apiError(
            reply,
            409,
            ErrorCodes.CONFLICT,
            "stored chunk size does not match transfer"
          );
        }
        return ticket;
      } catch (error) {
        if ((error as { status?: number }).status === 404) {
          return apiError(reply, 404, ErrorCodes.NOT_FOUND, "transfer chunk is not ready", true);
        }
        throw error;
      }
    }
  );

  app.get(
    "/api/v1/nodes/:nodeId/transfers/:transferId/chunks/:index",
    { preHandler: requireNode },
    async (request, reply) => {
      if (!options.transferStore)
        return apiError(reply, 503, ErrorCodes.OFFLINE, "transfer storage is unavailable", true);
      const { nodeId, transferId, index } = z
        .object({
          nodeId: z.string(),
          transferId: TransferIdSchema,
          index: z.coerce.number().int().min(0).max(999_999)
        })
        .parse(request.params);
      const transfer = await options.store.getTransferById(transferId);
      if (
        !transfer ||
        transfer.invocation.accountId !== nodeAccounts.get(request) ||
        transfer.args.destination.nodeId !== nodeId ||
        !["transferring", "verifying"].includes(transfer.status) ||
        transfer.chunkCount === undefined ||
        index >= transfer.chunkCount
      ) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "transfer chunk was not found");
      }
      let data: Buffer;
      try {
        data = await options.transferStore.getChunk(transferId, index);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return apiError(reply, 404, ErrorCodes.NOT_FOUND, "transfer chunk is not ready", true);
        }
        throw error;
      }
      return reply
        .type("application/octet-stream")
        .header("x-adc-content-sha256", `sha256:${createHash("sha256").update(data).digest("hex")}`)
        .send(data);
    }
  );

  app.get(
    "/api/v1/nodes/:nodeId/transfers/:transferId",
    { preHandler: requireNode },
    async (request, reply) => {
      const { nodeId, transferId } = z
        .object({ nodeId: z.string(), transferId: TransferIdSchema })
        .parse(request.params);
      const transfer = await options.store.getTransferById(transferId);
      if (
        !transfer ||
        transfer.invocation.accountId !== nodeAccounts.get(request) ||
        ![
          ...("nodeId" in transfer.args.source ? [transfer.args.source.nodeId] : []),
          transfer.args.destination.nodeId
        ].includes(nodeId)
      ) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "transfer was not found");
      }
      return {
        transferId,
        status: transfer.status,
        byteSize: transfer.byteSize,
        chunkCount: transfer.chunkCount,
        contentSha256: transfer.contentSha256,
        bytesTransferred: transfer.bytesTransferred,
        error: transfer.error,
        dataPlane: options.directTransferStore ? "object" : "local"
      };
    }
  );

  app.post(
    "/api/v1/nodes/:nodeId/transfers/:transferId/finalize-source",
    { preHandler: requireNode },
    async (request, reply) => {
      const { nodeId, transferId } = z
        .object({ nodeId: z.string(), transferId: TransferIdSchema })
        .parse(request.params);
      const { contentSha256 } = z
        .object({ contentSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
        .strict()
        .parse(request.body);
      const transfer = await options.store.finalizeTransferSource(
        transferId,
        nodeId,
        contentSha256
      );
      if (!transfer || transfer.invocation.accountId !== nodeAccounts.get(request)) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "transfer was not found");
      }
      taskWaitHub.notify(transferId);
      return { accepted: true, transferId, contentSha256 };
    }
  );

  app.post(
    "/api/v1/nodes/:nodeId/transfers/:transferId/progress",
    { preHandler: requireNode },
    async (request, reply) => {
      const { nodeId, transferId } = z
        .object({ nodeId: z.string(), transferId: TransferIdSchema })
        .parse(request.params);
      const body = z
        .object({
          bytesTransferred: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          status: z.enum(["transferring", "verifying"])
        })
        .strict()
        .parse(request.body);
      const transfer = await options.store.updateTransferProgress(
        transferId,
        nodeId,
        body.bytesTransferred,
        body.status
      );
      if (!transfer || transfer.invocation.accountId !== nodeAccounts.get(request)) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "transfer was not found");
      }
      taskWaitHub.notify(transferId);
      return { accepted: true, transferId, bytesTransferred: transfer.bytesTransferred };
    }
  );

  app.post(
    "/api/v1/nodes/:nodeId/artifacts",
    { preHandler: requireNode },
    async (request, reply) => {
      const { nodeId } = z.object({ nodeId: z.string() }).parse(request.params);
      const body = z
        .object({
          dispatchId: z.string(),
          artifactId: ArtifactIdSchema,
          contentType: z.string().min(1).max(128),
          sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          dataBase64: z.string().max(35 * 1024 * 1024)
        })
        .strict()
        .parse(request.body);
      const dispatch = await options.store.getDispatchById(body.dispatchId);
      if (!dispatch || dispatch.nodeId !== nodeId) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "dispatch was not found");
      }
      const image = body.artifactId.endsWith(".png");
      if (
        (image && body.contentType !== "image/png") ||
        (!image && !body.contentType.toLowerCase().startsWith("text/plain"))
      ) {
        return apiError(
          reply,
          400,
          ErrorCodes.INVALID_REQUEST,
          "artifact extension and content type do not match"
        );
      }
      const data = Buffer.from(body.dataBase64, "base64");
      if (data.byteLength > 25 * 1024 * 1024) {
        return apiError(reply, 413, ErrorCodes.INVALID_REQUEST, "artifact exceeds upload limit");
      }
      const contentHash = `sha256:${createHash("sha256").update(data).digest("hex")}`;
      if (!secureEqual(contentHash, body.sha256)) {
        return apiError(reply, 400, ErrorCodes.INVALID_REQUEST, "artifact hash mismatch");
      }
      const external = image;
      if (external && !options.assetStore) {
        return apiError(
          reply,
          503,
          ErrorCodes.OFFLINE,
          "image asset storage is not configured",
          true
        );
      }
      if (external) await options.assetStore!.put(body.sha256, data);
      await options.store.putArtifact({
        artifactId: body.artifactId,
        accountId: dispatch.invocation.accountId,
        invocationId: dispatch.invocation.invocationId,
        nodeId,
        contentType: body.contentType,
        sha256: body.sha256,
        byteSize: data.byteLength,
        data: external ? Buffer.alloc(0) : data,
        createdAt: now().toISOString()
      });
      return { accepted: true, artifactId: body.artifactId };
    }
  );

  const taskWaitHub = new TaskWaitHub();
  const waitQuery = z.object({ waitMs: z.coerce.number().pipe(WaitMsSchema).default(0) });

  async function authorizeTask(
    principal: Principal,
    task: DispatchRecord,
    originalInvocation = false
  ): Promise<void> {
    if (
      task.invocation.accountId !== principal.accountId ||
      (principal.kind !== "agent" && principal.team &&
        task.invocation.delegation?.requesterUserId !== principalUserId(principal)) ||
      (principal.kind === "agent" && task.invocation.authorization.grantId !== principal.grantId)
    )
      throw new ProtocolError(ErrorCodes.DENIED, "Task is not visible.", false);
    if (principal.kind !== "agent") return;
    const grant = await options.store.getGrant(principal.grantId);
    if (
      !grant ||
      grant.revokedAt ||
      grant.accountId !== principal.accountId ||
      !(originalInvocation
        ? grant.allowedTools.includes(task.invocation.tool)
        : grant.allowedTools.some((tool) =>
            ["task.status", "task.result", "task.wait"].includes(tool)
          ))
    )
      throw new ProtocolError(ErrorCodes.DENIED, "Task results are not granted.", false);
  }

  async function waitTask(
    task: DispatchRecord,
    principal: Principal,
    waitMs: number,
    signal?: AbortSignal,
    originalInvocation = false
  ): Promise<InvocationResult> {
    return taskWaitHub.wait(
      task.dispatchId,
      async () => {
        const current = await options.store.getDispatchById(task.dispatchId);
        if (!current) throw new ProtocolError(ErrorCodes.NOT_FOUND, "Task was not found.", false);
        await authorizeTask(principal, current, originalInvocation);
        return projectedTaskResult(current);
      },
      (result) => ["queued", "running"].includes(result.status),
      waitMs,
      signal
    );
  }

  async function projectedTaskResult(task: DispatchRecord): Promise<InvocationResult> {
    if (collaboration && !(await collaboration.resultVisible(task.invocation, task.nodeId))) {
      return domainResult(task.invocation, "denied", {
        code: ErrorCodes.DENIED, message: "Resource authorization changed. Task output is no longer available.", retryable: false
      });
    }
    return task.result ?? queuedResult(task);
  }

  async function authorizeTransfer(
    principal: Principal,
    transfer: TransferRecord,
    originalInvocation = false
  ): Promise<void> {
    if (
      transfer.invocation.accountId !== principal.accountId ||
      (principal.kind === "agent" &&
        transfer.invocation.authorization.grantId !== principal.grantId)
    ) {
      throw new ProtocolError(ErrorCodes.DENIED, "Transfer is not visible.", false);
    }
    if (principal.kind !== "agent") return;
    const grant = await options.store.getGrant(principal.grantId);
    if (
      !grant ||
      grant.revokedAt ||
      !(originalInvocation
        ? grant.allowedTools.includes("file.transfer")
        : grant.allowedTools.some((tool) =>
            ["task.status", "task.result", "task.wait"].includes(tool)
          ))
    ) {
      throw new ProtocolError(ErrorCodes.DENIED, "Transfer results are not granted.", false);
    }
  }

  async function currentTransferResult(transfer: TransferRecord): Promise<InvocationResult> {
    if (transfer.status !== "awaiting_approval") return transferResult(transfer);
    const approval = await options.store.getApprovalByInvocation(transfer.invocation.invocationId);
    const expired = !approval || Date.parse(approval.expiresAt) <= now().getTime();
    if (approval?.status === "pending" && !expired) {
      return domainResult(transfer.invocation, "approval_required", {
        code: ErrorCodes.APPROVAL_REQUIRED,
        message: approval.policyDecision.explanation,
        retryable: false,
        details: {
          approvalId: approval.approvalId,
          transferId: transfer.transferId,
          expiresAt: approval.expiresAt,
          reasonCode: approval.policyDecision.reasonCode,
          policyDecision: approval.policyDecision
        }
      });
    }
    return domainResult(transfer.invocation, "denied", {
      code: expired ? ErrorCodes.EXPIRED : ErrorCodes.DENIED,
      message: expired
        ? "Approval expired before the transfer was dispatched."
        : "The transfer was denied by the account owner.",
      retryable: false,
      details: { transferId: transfer.transferId, approvalId: approval?.approvalId }
    });
  }

  async function requestTransferCancellation(
    transfer: TransferRecord,
    timestamp: Date
  ): Promise<TransferRecord | undefined> {
    const cancelled = await options.store.requestCancelTransfer(transfer.transferId, timestamp);
    if (!cancelled) return;
    const approval = await options.store.getApprovalByInvocation(transfer.invocation.invocationId);
    if (approval?.status === "pending") {
      await options.store.resolveApproval(approval.approvalId, "denied", timestamp);
    }
    taskWaitHub.notify(transfer.transferId);
    if ("nodeId" in transfer.args.source) wakeNode(transfer.args.source.nodeId);
    wakeNode(transfer.args.destination.nodeId);
    if (cancelled.status === "cancelled") await cleanupTransfer(transfer.transferId);
    return cancelled;
  }

  async function waitTransfer(
    transfer: TransferRecord,
    principal: Principal,
    waitMs: number,
    signal?: AbortSignal,
    originalInvocation = false
  ): Promise<InvocationResult> {
    return taskWaitHub.wait(
      transfer.transferId,
      async () => {
        const current = await options.store.getTransferById(transfer.transferId);
        if (!current) {
          throw new ProtocolError(ErrorCodes.NOT_FOUND, "Transfer was not found.", false);
        }
        await authorizeTransfer(principal, current, originalInvocation);
        return currentTransferResult(current);
      },
      (result) => ["queued", "running"].includes(result.status),
      waitMs,
      signal
    );
  }

  function requestSignal(request: FastifyRequest, reply: FastifyReply): AbortSignal {
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    reply.raw.once("finish", () => {
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abort);
    });
    return controller.signal;
  }

  async function invoke(
    invocation: Invocation,
    principal: Principal,
    signal?: AbortSignal
  ): Promise<InvocationResult> {
    const accountId = principal.accountId;
    countInvocation("submitted", invocation.tool);
    if (invocation.delegation)
      throw new ProtocolError("denied", "Execution provenance is assigned by the service.", false);
    if (principal.kind === "pat" && principal.readOnly && isSideEffectTool(invocation.tool))
      throw new ProtocolError("denied", "This personal access token is read-only.", false);
    if (invocation.accountId !== accountId) {
      throw new ProtocolError(ErrorCodes.DENIED, "account scope mismatch", false);
    }
    if (principal.kind === "agent" && invocation.authorization.grantId !== principal.grantId) {
      throw new ProtocolError("denied", "Credential is bound to a different Agent grant.", false);
    }
    const grant = await options.store.getGrant(invocation.authorization.grantId);
    if (grant && principal.kind !== "agent" && principal.team &&
        grant.responsibleUserId !== principalUserId(principal))
      throw new ProtocolError("denied", "Use your own Agent authorization.", false);
    if (principal.kind === "agent" && invocation.actor.type !== "agent")
      throw new ProtocolError("denied", "Agent credentials require an Agent actor.", false);
    if (
      !grant ||
      grant.revokedAt ||
      grant.accountId !== accountId ||
      grant.actorId !== invocation.actor.id
    ) {
      return domainResult(invocation, "denied", {
        code: ErrorCodes.DENIED,
        message: "agent grant is missing or revoked",
        retryable: false
      });
    }
    if (
      grant.projectId &&
      (invocation.authorization.projectId !== grant.projectId ||
        ("projectId" in invocation.target && invocation.target.projectId !== grant.projectId))
    ) {
      throw new ProtocolError("denied", "Project scope mismatch.", false);
    }
    if (!isBuiltinTool(invocation.tool) && !("nodeId" in invocation.target)) {
      throw new ProtocolError(
        "invalid_request",
        "Custom MCP tools require an explicit target node.",
        false
      );
    }
    const invocationIdentity = (value: Invocation) => ({
      accountId: value.accountId,
      actor: value.actor,
      tool: value.tool,
      args: value.args,
      authorization: value.authorization,
      target: value.target,
      idempotencyKey: value.idempotencyKey,
      executionTimeoutMs: value.executionTimeoutMs
    });
    const existingTransfer =
      (await options.store.getTransferByInvocation(invocation.invocationId)) ??
      (invocation.tool === "file.transfer" && invocation.idempotencyKey
        ? await options.store.getTransferByIdempotency(
            accountId,
            invocation.actor.id,
            invocation.idempotencyKey
          )
        : undefined);
    if (existingTransfer) {
      if (
        sha256(invocationIdentity(existingTransfer.invocation)) !==
        sha256(invocationIdentity(invocation))
      ) {
        throw new ProtocolError("conflict", "Invocation ID has already been used.", false);
      }
      await authorizeTransfer(principal, existingTransfer, true);
      return currentTransferResult(existingTransfer);
    }
    const existing = await options.store.getDispatchByInvocation(invocation.invocationId);
    if (existing) {
      if (
        sha256(invocationIdentity(existing.invocation)) !== sha256(invocationIdentity(invocation))
      ) {
        throw new ProtocolError("conflict", "Invocation ID has already been used.", false);
      }
      await authorizeTask(principal, existing, true);
      return projectedTaskResult(existing);
    }
    assertInvocationCurrent(invocation, now());
    if (!grant.allowedTools.includes(ToolIdSchema.parse(invocation.tool))) {
      return domainResult(invocation, "denied", {
        code: ErrorCodes.DENIED,
        message: "agent grant does not include this control-plane capability",
        retryable: false
      });
    }
    if (invocation.tool === "file.transfer") {
      if (!options.transferStore && !options.directTransferStore) {
        return domainResult(invocation, "offline", {
          code: ErrorCodes.OFFLINE,
          message: "native transfer storage is not configured",
          retryable: true
        });
      }
      const args = FileTransferArgsSchema.parse(invocation.args);
      const sourceIsNode = "nodeId" in args.source;
      if (
        !("nodeId" in args.source) &&
        (!options.directTransferStore || args.source.byteSize > maxTransferBytes)
      ) {
        return domainResult(invocation, "denied", {
          code: ErrorCodes.INVALID_REQUEST,
          message: "Agent upload requires object storage and a file within the size limit",
          retryable: false
        });
      }
      const targetNodeId = "nodeId" in args.source ? args.source.nodeId : args.destination.nodeId;
      if (!("nodeId" in invocation.target) || invocation.target.nodeId !== targetNodeId) {
        throw new ProtocolError(
          ErrorCodes.INVALID_REQUEST,
          "file.transfer target must be its source node",
          false
        );
      }
      if (
        ("rootId" in args.source &&
          !invocation.authorization.rootIds.includes(args.source.rootId)) ||
        !invocation.authorization.rootIds.includes(args.destination.rootId)
      ) {
        return domainResult(invocation, "denied", {
          code: ErrorCodes.DENIED,
          message: "transfer endpoints are outside this invocation authorization",
          retryable: false
        });
      }
      const [sourceNode, destinationNode] = await Promise.all([
        "nodeId" in args.source
          ? options.store.getNode(args.source.nodeId)
          : Promise.resolve(undefined),
        options.store.getNode(args.destination.nodeId)
      ]);
      if (
        (sourceIsNode && !sourceNode) ||
        !destinationNode ||
        (sourceNode && sourceNode.accountId !== accountId) ||
        destinationNode.accountId !== accountId ||
        (sourceNode && !grant.nodeIds.includes(sourceNode.nodeId)) ||
        !grant.nodeIds.includes(destinationNode.nodeId)
      ) {
        return domainResult(invocation, "denied", {
          code: ErrorCodes.DENIED,
          message: "agent grant does not include both transfer devices",
          retryable: false
        });
      }
      const transferId = createId("xfr");
      if (
        options.directTransferStore &&
        [sourceNode, destinationNode].some(
          (node) => node && !node.capability?.transferDataPlanes?.includes("object")
        )
      ) {
        return domainResult(invocation, "denied", {
          code: ErrorCodes.UNSUPPORTED_VERSION,
          message: "Update the participating Connectors to support object transfers",
          retryable: false
        });
      }
      const destinationInvocation = transferChildInvocation(invocation, transferId, "destination");
      const destinationDecision = await policyFor(destinationInvocation, grant, destinationNode);
      const sourceDecision = sourceNode
        ? await policyFor(
            transferChildInvocation(invocation, transferId, "source"),
            grant,
            sourceNode
          )
        : destinationDecision;
      const decisions = [sourceDecision, destinationDecision];
      const offline = decisions.find((decision) => decision.reasonCode === "node.offline");
      const denied = decisions.find((decision) => decision.outcome === "deny");
      if (offline || denied) {
        const decision = offline ?? denied!;
        return domainResult(invocation, offline ? "offline" : "denied", {
          code: offline ? ErrorCodes.OFFLINE : ErrorCodes.DENIED,
          message: decision.explanation,
          retryable: !!offline,
          details: { reasonCode: decision.reasonCode, policyDecision: decision }
        });
      }
      const timestamp = now();
      const createdAt = timestamp.toISOString();
      const approvalDecision = decisions.find(
        (decision) => decision.outcome === "approval_required"
      );
      const record: TransferRecord = {
        transferId,
        invocation,
        args,
        status: approvalDecision ? "awaiting_approval" : "queued",
        bytesTransferred: 0,
        createdAt,
        updatedAt: createdAt
      };
      if (!("nodeId" in args.source)) {
        record.byteSize = args.source.byteSize;
        record.chunkCount = Math.ceil(args.source.byteSize / args.chunkSizeBytes);
        record.contentSha256 = args.source.contentSha256;
      }
      if (approvalDecision) {
        const persisted = await options.store.createTransfer(record, [], []);
        const approval = await options.store.putApproval({
          approvalId: createId("apr"),
          accountId,
          invocation: persisted.invocation,
          nodeId: args.destination.nodeId,
          placementReason: "transfer_pair",
          policyDecision: approvalDecision,
          status: "pending",
          createdAt,
          expiresAt: new Date(
            Math.min(Date.parse(invocation.expiresAt), timestamp.getTime() + 15 * 60_000)
          ).toISOString()
        });
        await options.store.putAudit({
          eventId: createId("dsp"),
          accountId,
          invocationId: invocation.invocationId,
          type: "approval.requested",
          payload: {
            approvalId: approval.approvalId,
            transferId: persisted.transferId,
            ...("nodeId" in args.source
              ? { sourceNodeId: args.source.nodeId }
              : { sourceKind: "agent" }),
            destinationNodeId: args.destination.nodeId,
            policyDecision: approvalDecision
          },
          createdAt
        });
        return domainResult(invocation, "approval_required", {
          code: ErrorCodes.APPROVAL_REQUIRED,
          message: approvalDecision.explanation,
          retryable: false,
          details: {
            approvalId: approval.approvalId,
            transferId: persisted.transferId,
            expiresAt: approval.expiresAt,
            reasonCode: approvalDecision.reasonCode,
            policyDecision: approvalDecision
          }
        });
      }
      const dispatches = transferDispatches(
        invocation,
        transferId,
        { source: sourceDecision, destination: destinationDecision },
        createdAt
      );
      const transfer = await options.store.createTransfer(
        {
          ...record,
          ...(sourceIsNode ? { sourceDispatchId: dispatches[0]!.dispatchId } : {}),
          destinationDispatchId: dispatches.at(-1)!.dispatchId
        },
        dispatches,
        transferAudits(invocation, transferId, dispatches, createdAt)
      );
      if ("nodeId" in args.source) wakeNode(args.source.nodeId);
      wakeNode(args.destination.nodeId);
      countInvocation("queued", invocation.tool);
      return transferResult(transfer);
    }
    if (invocation.tool === "device.list" || invocation.tool === "device.status") {
      const requestedNodeId =
        invocation.tool === "device.status"
          ? (invocation.args as { nodeId: string }).nodeId
          : undefined;
      const nodes = (await grantNodes(grant))
        .filter(
          (node) =>
            grant.nodeIds.includes(node.nodeId) &&
            (requestedNodeId === undefined || node.nodeId === requestedNodeId)
        )
        .map((node) => ({ ...node, capability: effectiveCapability(node) }))
        .map((node) => ({
          nodeId: node.nodeId,
          label: node.label,
          platform: node.platform,
          status: node.status,
          ...(node.resourceAuthorization ? { access: {
            kind: node.resourceAuthorization.bindingId ? "shared" : "team",
            bindingId: node.resourceAuthorization.bindingId,
            execution: node.resourceAuthorization.scope.execution
          } } : {}),
          lastSeenAt: node.lastSeenAt,
          online:
            node.status === "active" &&
            !!node.lastSeenAt &&
            now().getTime() - Date.parse(node.lastSeenAt) <= presenceTtlMs,
          capability: node.capability
            ? {
                ...node.capability,
                roots: node.capability.roots.filter(
                  (root) => grant.rootAccess === "all" || grant.rootIds.includes(root.rootId)
                ),
                tools: node.capability.tools.filter((tool) =>
                  grant.allowedTools.includes(tool.name)
                )
              }
            : undefined
        }));
      if (requestedNodeId && nodes.length === 0) {
        return domainResult(invocation, "denied", {
          code: ErrorCodes.DENIED,
          message: "device is not visible to this agent",
          retryable: false
        });
      }
      countInvocation("succeeded", invocation.tool);
      return ResultSchema.parse({
        schemaVersion: "0.1",
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        status: "succeeded",
        output: invocation.tool === "device.list" ? { nodes } : { node: nodes[0] }
      });
    }
    if (
      invocation.tool === "task.status" ||
      invocation.tool === "task.result" ||
      invocation.tool === "task.wait" ||
      invocation.tool === "task.cancel"
    ) {
      const jobId = (invocation.args as { jobId: string }).jobId;
      const transferId = transferIdForJob(jobId);
      let transfer = transferId ? await options.store.getTransferById(transferId) : undefined;
      if (transfer) {
        if (
          transfer.invocation.accountId !== accountId ||
          transfer.invocation.authorization.grantId !== grant.grantId
        ) {
          return domainResult(invocation, "denied", {
            code: ErrorCodes.DENIED,
            message: "task is not visible to this agent",
            retryable: false
          });
        }
        if (invocation.tool === "task.cancel") {
          transfer = await requestTransferCancellation(transfer, now());
        }
        const result =
          transfer && invocation.tool !== "task.cancel"
            ? await waitTransfer(
                transfer,
                principal,
                invocation.tool === "task.wait"
                  ? (invocation.args as { waitMs: number }).waitMs
                  : 0,
                signal
              )
            : transfer
              ? await currentTransferResult(transfer)
              : undefined;
        countInvocation("succeeded", invocation.tool);
        return ResultSchema.parse({
          schemaVersion: "0.1",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          status: "succeeded",
          output: { task: result }
        });
      }
      const dispatchId = dispatchIdForJob(jobId);
      let task = dispatchId ? await options.store.getDispatchById(dispatchId) : undefined;
      if (
        !task ||
        task.invocation.accountId !== accountId ||
        task.invocation.authorization.grantId !== grant.grantId
      ) {
        return domainResult(invocation, "denied", {
          code: ErrorCodes.DENIED,
          message: "task is not visible to this agent",
          retryable: false
        });
      }
      if (invocation.tool === "task.cancel") {
        task = await options.store.requestCancel(task.dispatchId, now());
        taskWaitHub.notify(dispatchId!);
      }
      const result =
        task && invocation.tool !== "task.cancel"
          ? await waitTask(
              task,
              principal,
              invocation.tool === "task.wait" ? (invocation.args as { waitMs: number }).waitMs : 0,
              signal
            )
          : task ? await projectedTaskResult(task) : undefined;
      countInvocation("succeeded", invocation.tool);
      return ResultSchema.parse({
        schemaVersion: "0.1",
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        status: "succeeded",
        output: { task: result }
      });
    }
    const available = collaboration ? await grantNodes(grant) : undefined;
    const placement = await placeInvocation(options.store, invocation, grant, available);
    if ("error" in placement) {
      return domainResult(invocation, placement.status, placement.error);
    }
    const node = placement.node;
    if (node.resourceAuthorization) invocation = {
      ...invocation,
      delegation: {
        ...node.resourceAuthorization,
        expiresAt: new Date(Math.min(Date.parse(node.resourceAuthorization.expiresAt), Date.parse(invocation.expiresAt))).toISOString()
      }
    };
    const policyDecision = await policyFor(invocation, grant, node);
    if (policyDecision.outcome !== "allow") {
      const offline = policyDecision.reasonCode === "node.offline";
      countInvocation(offline ? "offline" : policyDecision.outcome, invocation.tool);
      if (policyDecision.outcome === "approval_required") {
        const createdAt = now();
        const approval = await options.store.putApproval({
          approvalId: createId("apr"),
          accountId,
          invocation,
          nodeId: node.nodeId,
          placementReason: placement.reason,
          ...(collaboration && invocation.delegation ? {
            requiredConsents: await collaboration.requiredConsents(invocation, grant)
          } : {}),
          policyDecision,
          status: "pending",
          createdAt: createdAt.toISOString(),
          expiresAt: new Date(
            Math.min(Date.parse(invocation.expiresAt), createdAt.getTime() + 15 * 60_000)
          ).toISOString()
        });
        await options.store.putAudit({
          eventId: createId("dsp"),
          accountId,
          invocationId: invocation.invocationId,
          type: "approval.requested",
          payload: {
            approvalId: approval.approvalId,
            nodeId: node.nodeId,
            policyDecision
          },
          createdAt: createdAt.toISOString()
        });
        return domainResult(invocation, "approval_required", {
          code: ErrorCodes.APPROVAL_REQUIRED,
          message: policyDecision.explanation,
          retryable: false,
          details: {
            approvalId: approval.approvalId,
            expiresAt: approval.expiresAt,
            reasonCode: policyDecision.reasonCode,
            policyDecision
          }
        });
      }
      return domainResult(invocation, offline ? "offline" : "denied", {
        code: offline ? ErrorCodes.OFFLINE : ErrorCodes.DENIED,
        message: policyDecision.explanation,
        retryable: offline,
        details: {
          reasonCode: policyDecision.reasonCode,
          policyDecision
        }
      });
    }
    const timestamp = now().toISOString();
    const dispatch: DispatchRecord = {
      dispatchId: createId("dsp"),
      invocation,
      nodeId: node.nodeId,
      policyDecision,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const queued = await options.store.enqueue(dispatch, {
      eventId: createId("dsp"),
      accountId,
      invocationId: invocation.invocationId,
      type: "dispatch.queued",
      payload: {
        dispatchId: dispatch.dispatchId,
        nodeId: node.nodeId,
        placementReason: placement.reason,
        policyDecision
      },
      createdAt: timestamp
    });
    wakeNode(queued.nodeId);
    countInvocation("queued", invocation.tool);
    return projectedTaskResult(queued);
  }

  async function invokeAndWait(
    invocation: Invocation,
    principal: Principal,
    waitMs = 0,
    signal?: AbortSignal
  ) {
    const result = await invoke(invocation, principal, signal);
    if (!result.jobId || !["queued", "running"].includes(result.status) || !waitMs) return result;
    const transfer = await options.store.getTransferByInvocation(result.invocationId);
    if (transfer) {
      return waitTransfer(transfer, principal, WaitMsSchema.parse(waitMs), signal, true);
    }
    const task = await options.store.getDispatchByInvocation(result.invocationId);
    return task ? waitTask(task, principal, WaitMsSchema.parse(waitMs), signal, true) : result;
  }

  app.post("/api/v1/invocations", { preHandler: requireAuthenticated }, async (request, reply) =>
    invokeAndWait(
      InvocationSchema.parse(request.body),
      principals.get(request)!,
      waitQuery.parse(request.query).waitMs,
      requestSignal(request, reply)
    )
  );

  function visibleTask(request: FastifyRequest, dispatch: DispatchRecord | undefined) {
    const principal = principals.get(request)!;
    return (
      !!dispatch &&
      dispatch.invocation.accountId === principal.accountId &&
      (principal.kind === "agent" || !principal.team ||
        dispatch.invocation.delegation?.requesterUserId === principalUserId(principal)) &&
      (principal.kind === "session" ||
        principal.kind === "pat" ||
        dispatch.invocation.authorization.grantId === principal.grantId)
    );
  }

  function visibleTransfer(request: FastifyRequest, transfer: TransferRecord | undefined) {
    const principal = principals.get(request)!;
    return (
      !!transfer &&
      transfer.invocation.accountId === principal.accountId &&
      (principal.kind === "agent" || !principal.team ||
        transfer.invocation.delegation?.requesterUserId === principalUserId(principal)) &&
      (principal.kind === "session" ||
        principal.kind === "pat" ||
        transfer.invocation.authorization.grantId === principal.grantId)
    );
  }

  app.get(
    "/api/v1/invocations/:invocationId",
    { preHandler: requireAuthenticated },
    async (request, reply) => {
      const { invocationId } = z.object({ invocationId: InvocationIdSchema }).parse(request.params);
      const principal = principals.get(request)!;
      const transfer = await options.store.getTransferByInvocation(invocationId);
      if (transfer) {
        if (!visibleTransfer(request, transfer)) {
          return apiError(reply, 404, ErrorCodes.NOT_FOUND, "invocation was not found");
        }
        if (transfer.status === "awaiting_approval") {
          return currentTransferResult(transfer);
        }
        return waitTransfer(
          transfer,
          principal,
          waitQuery.parse(request.query).waitMs,
          requestSignal(request, reply),
          true
        );
      }
      const dispatch = await options.store.getDispatchByInvocation(invocationId);
      if (dispatch) {
        if (!visibleTask(request, dispatch)) {
          return apiError(reply, 404, ErrorCodes.NOT_FOUND, "invocation was not found");
        }
        return waitTask(
          dispatch,
          principal,
          waitQuery.parse(request.query).waitMs,
          requestSignal(request, reply)
        );
      }

      const approval = await options.store.getApprovalByInvocation(invocationId);
      if (
        !approval ||
        approval.accountId !== principal.accountId ||
        (principal.kind !== "agent" && principal.team && approval.invocation.delegation?.requesterUserId !== principalUserId(principal)) ||
        (principal.kind === "agent" &&
          approval.invocation.authorization.grantId !== principal.grantId)
      ) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "invocation was not found");
      }
      const approvalExpired = Date.parse(approval.expiresAt) <= now().getTime();
      if (approval.status === "pending" && !approvalExpired) {
        return domainResult(approval.invocation, "approval_required", {
          code: ErrorCodes.APPROVAL_REQUIRED,
          message: approval.policyDecision.explanation,
          retryable: false,
          details: {
            approvalId: approval.approvalId,
            expiresAt: approval.expiresAt,
            reasonCode: approval.policyDecision.reasonCode,
            policyDecision: approval.policyDecision
          }
        });
      }
      return domainResult(approval.invocation, "denied", {
        code:
          approval.status === "expired" || approvalExpired ? ErrorCodes.EXPIRED : ErrorCodes.DENIED,
        message:
          approval.status === "expired" || approvalExpired
            ? "Approval expired before the invocation was dispatched."
            : "The invocation was denied by the account owner.",
        retryable: false,
        details: { approvalId: approval.approvalId }
      });
    }
  );

  app.get("/api/v1/tasks/:jobId", { preHandler: requireAuthenticated }, async (request, reply) => {
    const { jobId } = z.object({ jobId: z.string() }).parse(request.params);
    const transferId = transferIdForJob(jobId);
    const transfer = transferId ? await options.store.getTransferById(transferId) : undefined;
    if (transfer) {
      if (!visibleTransfer(request, transfer)) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "task was not found");
      }
      return waitTransfer(
        transfer,
        principals.get(request)!,
        waitQuery.parse(request.query).waitMs,
        requestSignal(request, reply)
      );
    }
    const dispatchId = dispatchIdForJob(jobId);
    const dispatch = dispatchId ? await options.store.getDispatchById(dispatchId) : undefined;
    if (!dispatch || !visibleTask(request, dispatch)) {
      return apiError(reply, 404, ErrorCodes.NOT_FOUND, "task was not found");
    }
    return waitTask(
      dispatch,
      principals.get(request)!,
      waitQuery.parse(request.query).waitMs,
      requestSignal(request, reply)
    );
  });

  app.post(
    "/api/v1/tasks/:jobId/cancel",
    { preHandler: requireAuthenticated },
    async (request, reply) => {
      const { jobId } = z.object({ jobId: z.string() }).parse(request.params);
      const transferId = transferIdForJob(jobId);
      const transfer = transferId ? await options.store.getTransferById(transferId) : undefined;
      if (transfer) {
        if (!visibleTransfer(request, transfer)) {
          return apiError(reply, 404, ErrorCodes.NOT_FOUND, "task was not found");
        }
        const actor = principals.get(request)!;
        if (
          actor.kind === "agent" &&
          !(await options.store.getGrant(actor.grantId))?.allowedTools.includes("task.cancel")
        ) {
          return apiError(reply, 403, ErrorCodes.DENIED, "Task cancellation is not granted.");
        }
        const timestamp = now();
        const cancelled = await requestTransferCancellation(transfer, timestamp);
        if (!cancelled) {
          return apiError(reply, 404, ErrorCodes.NOT_FOUND, "task was not found");
        }
        await options.store.putAudit({
          eventId: createId("dsp"),
          accountId: transfer.invocation.accountId,
          invocationId: transfer.invocation.invocationId,
          type: "task.cancel_requested",
          payload: { transferId: transfer.transferId, status: cancelled.status },
          createdAt: timestamp.toISOString()
        });
        return currentTransferResult(cancelled);
      }
      const dispatchId = dispatchIdForJob(jobId);
      const current = dispatchId ? await options.store.getDispatchById(dispatchId) : undefined;
      if (!current || !visibleTask(request, current)) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "task was not found");
      }
      const actor = principals.get(request)!;
      if (
        actor.kind === "agent" &&
        !(await options.store.getGrant(actor.grantId))?.allowedTools.includes("task.cancel")
      ) {
        return apiError(reply, 403, ErrorCodes.DENIED, "Task cancellation is not granted.");
      }
      const dispatch = (await options.store.requestCancel(current.dispatchId, now()))!;
      taskWaitHub.notify(dispatch.dispatchId);
      if (dispatch.status === "cancelled" || dispatch.status === "cancel_requested") {
        await options.store.putAudit({
          eventId: createId("dsp"),
          accountId: dispatch.invocation.accountId,
          invocationId: dispatch.invocation.invocationId,
          type: dispatch.status === "cancelled" ? "task.cancelled" : "task.cancel_requested",
          payload: {
            dispatchId: dispatch.dispatchId,
            nodeId: dispatch.nodeId,
            status: dispatch.status
          },
          createdAt: now().toISOString()
        });
      }
      if (dispatch.status === "cancelled") {
        return ResultSchema.parse({
          schemaVersion: "0.1",
          invocationId: dispatch.invocation.invocationId,
          attemptId: dispatch.invocation.attemptId,
          status: "cancelled",
          error: {
            code: ErrorCodes.CANCELLED,
            message: "task was cancelled before execution",
            retryable: false
          },
          jobId
        });
      }
      return projectedTaskResult(dispatch);
    }
  );

  app.get("/api/v1/approvals", { preHandler: requireOwner }, async (request) => {
    const accountId = accountOf(request);
    const actor = principals.get(request)! as Extract<Principal, { kind: "session" | "pat" }>;
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().max(512).optional(),
        status: z.enum(["pending", "resolved"]).optional()
      })
      .strict()
      .parse(request.query);
    const before = query.cursor ? decodePageCursor(query.cursor) : undefined;
    const page = await options.store.listApprovalsPage(accountId, {
      limit: query.limit,
      now: now().toISOString(),
      ...(actor.team
        ? { responsibleUserId: principalUserId(actor)!, includeResourceConsent: actor.team.membership.role !== "member" } : {}),
      ...(before ? { before } : {}),
      ...(query.status ? { status: query.status } : {})
    });
    return {
      approvals: await approvalView(options.store, accountId, page.approvals, actor.team ? principalUserId(actor) : undefined),
      nextCursor: encodePageCursor(page.nextCursor),
      hasMore: !!page.nextCursor,
      pendingCount: page.pendingCount
    };
  });

  app.post(
    "/api/v1/approvals/:approvalId",
    { preHandler: requireOwner },
    async (request, reply) => {
      const accountId = accountOf(request);
      const { approvalId } = z.object({ approvalId: z.string() }).parse(request.params);
      const { decision } = z
        .object({ decision: z.enum(["approved", "denied"]) })
        .strict()
        .parse(request.body);
      const approval = await options.store.getApproval(approvalId);
      const actor = principals.get(request)! as Extract<Principal, { kind: "session" | "pat" }>;
      const userId = principalUserId(actor);
      const required = approval?.requiredConsents ?? [];
      const canConsent = required.length
        ? required.some((entry) => entry.accountId === accountId && (!entry.userId || entry.userId === userId) &&
          (entry.role !== "resource" || actor.team?.membership.role !== "member"))
        : approval?.accountId === accountId && actor.team?.membership.role !== "member";
      if (!approval || !canConsent) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "approval was not found");
      }
      const responseFor = (dispatch: DispatchRecord) => approval.accountId === accountId
        ? projectedTaskResult(dispatch) : Promise.resolve(queuedResult(dispatch));
      if (approval.status === "approved") {
        const transfer = await options.store.getTransferByInvocation(
          approval.invocation.invocationId
        );
        if (transfer) return transferResult(transfer);
        const existing = await options.store.getDispatchByInvocation(
          approval.invocation.invocationId
        );
        if (existing) return responseFor(existing);
      }
      if (approval.status !== "pending") {
        return apiError(reply, 409, ErrorCodes.CONFLICT, `approval is already ${approval.status}`);
      }
      const timestamp = now();
      if (Date.parse(approval.expiresAt) <= timestamp.getTime()) {
        await options.store.resolveApproval(approvalId, "approved", timestamp);
        return apiError(reply, 409, ErrorCodes.EXPIRED, "approval has expired");
      }
      if (decision === "denied") {
        const resolved = await options.store.resolveApproval(approvalId, "denied", timestamp);
        if (!resolved)
          return apiError(reply, 409, ErrorCodes.CONFLICT, "Approval was already resolved.");
        await options.store.putAudit({
          eventId: createId("dsp"),
          accountId,
          invocationId: approval.invocation.invocationId,
          type: "approval.denied",
          payload: { approvalId, nodeId: approval.nodeId },
          createdAt: timestamp.toISOString()
        });
        const transfer = await options.store.getTransferByInvocation(
          approval.invocation.invocationId
        );
        if (transfer) {
          await options.store.denyTransfer(transfer.transferId, timestamp);
          taskWaitHub.notify(transfer.transferId);
        }
        return { approval: (await approvalView(options.store, accountId, [resolved], actor.team ? userId : undefined))[0] };
      }
      const pendingTransfer = await options.store.getTransferByInvocation(
        approval.invocation.invocationId
      );
      if (pendingTransfer) {
        const grant = await options.store.getGrant(
          pendingTransfer.invocation.authorization.grantId
        );
        const [sourceNode, destinationNode] = await Promise.all([
          "nodeId" in pendingTransfer.args.source
            ? options.store.getNode(pendingTransfer.args.source.nodeId)
            : Promise.resolve(undefined),
          options.store.getNode(pendingTransfer.args.destination.nodeId)
        ]);
        if (
          !grant ||
          grant.revokedAt ||
          ("nodeId" in pendingTransfer.args.source && !sourceNode) ||
          !destinationNode
        ) {
          return apiError(
            reply,
            409,
            ErrorCodes.DENIED,
            "transfer device or grant was revoked before approval"
          );
        }
        if (
          options.directTransferStore &&
          [sourceNode, destinationNode].some(
            (node) => node && !node.capability?.transferDataPlanes?.includes("object")
          )
        ) {
          return apiError(
            reply,
            409,
            ErrorCodes.UNSUPPORTED_VERSION,
            "Update the participating Connectors before approval"
          );
        }
        const destinationInvocation = transferChildInvocation(
          pendingTransfer.invocation,
          pendingTransfer.transferId,
          "destination"
        );
        const destinationDecision = await policyFor(destinationInvocation, grant, destinationNode);
        const sourceDecision = sourceNode
          ? await policyFor(
              transferChildInvocation(
                pendingTransfer.invocation,
                pendingTransfer.transferId,
                "source"
              ),
              grant,
              sourceNode
            )
          : destinationDecision;
        if ([sourceDecision, destinationDecision].some((current) => current.outcome === "deny")) {
          return apiError(
            reply,
            409,
            ErrorCodes.DENIED,
            "transfer authorization changed before approval"
          );
        }
        const unsignedDecision = {
          outcome: "allow" as const,
          reasonCode: "approval.granted",
          explanation: "An owner approved this transfer.",
          evaluatedLayers: approval.policyDecision.evaluatedLayers,
          profile: approval.policyDecision.profile
        };
        const approvedDecision = {
          ...unsignedDecision,
          decisionHash: sha256(unsignedDecision)
        };
        const createdAt = timestamp.toISOString();
        const dispatches = transferDispatches(
          pendingTransfer.invocation,
          pendingTransfer.transferId,
          { source: approvedDecision, destination: approvedDecision },
          createdAt
        );
        const started = await options.store.approveAndStartTransfer(
          approvalId,
          pendingTransfer.transferId,
          dispatches,
          transferAudits(
            pendingTransfer.invocation,
            pendingTransfer.transferId,
            dispatches,
            createdAt
          ),
          timestamp
        );
        if (!started) {
          return apiError(
            reply,
            409,
            ErrorCodes.CONFLICT,
            "Approval was already resolved or expired."
          );
        }
        if ("nodeId" in started.args.source) wakeNode(started.args.source.nodeId);
        wakeNode(started.args.destination.nodeId);
        taskWaitHub.notify(started.transferId);
        return transferResult(started);
      }
      const node = await options.store.getNode(approval.nodeId);
      const grant = await options.store.getGrant(approval.invocation.authorization.grantId);
      if (
        !node ||
        node.status !== "active" ||
        !grant ||
        grant.revokedAt ||
        !(await dispatchAuthorized(
          {
            invocation: approval.invocation,
            nodeId: approval.nodeId,
            policyDecision: approval.policyDecision
          },
          true
        ))
      ) {
        return apiError(
          reply,
          409,
          ErrorCodes.DENIED,
          "device or grant was revoked before approval"
        );
      }
      if (required.length && collaboration && userId) {
        if (!await collaboration.relationships.consentApproval(approvalId, accountId, userId)) {
          const pending = await options.store.getApproval(approvalId);
          return { approval: (await approvalView(options.store, accountId, [pending!], actor.team ? userId : undefined))[0], awaitingConsent: true };
        }
      }
      const unsignedDecision = {
        outcome: "allow" as const,
        reasonCode: "approval.granted",
        explanation: "An owner approved this invocation.",
        evaluatedLayers: approval.policyDecision.evaluatedLayers,
        profile: approval.policyDecision.profile
      };
      const approvedDecision = {
        ...unsignedDecision,
        decisionHash: sha256(unsignedDecision)
      };
      const createdAt = timestamp.toISOString();
      const dispatch: DispatchRecord = {
        dispatchId: createId("dsp"),
        invocation: approval.invocation,
        nodeId: approval.nodeId,
        policyDecision: approvedDecision,
        status: "queued",
        createdAt,
        updatedAt: createdAt
      };
      const queued = await options.store.approveAndEnqueue(
        approvalId,
        dispatch,
        {
          eventId: createId("dsp"),
          accountId: approval.accountId,
          invocationId: approval.invocation.invocationId,
          type: "dispatch.queued",
          payload: {
            dispatchId: dispatch.dispatchId,
            nodeId: approval.nodeId,
            placementReason: approval.placementReason,
            approvalId,
            policyDecision: approvedDecision
          },
          createdAt
        },
        timestamp
      );
      if (!queued) {
        const existing = await options.store.getDispatchByInvocation(approval.invocation.invocationId);
        if (existing) return responseFor(existing);
        return apiError(
          reply,
          409,
          ErrorCodes.CONFLICT,
          "Approval was already resolved or expired."
        );
      }
      wakeNode(queued.nodeId);
      return responseFor(queued);
    }
  );

  app.get("/api/v1/audit", { preHandler: requireOwner }, async (request) => {
    const accountId = accountOf(request);
    const query = z
      .object({
        invocationId: InvocationIdSchema.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().max(512).optional(),
        category: AuditCategorySchema.optional()
      })
      .strict()
      .parse(request.query);
    const before = query.cursor ? decodePageCursor(query.cursor) : undefined;
    const page = await options.store.listAuditPage(accountId, {
      limit: query.limit,
      ...(query.invocationId ? { invocationId: query.invocationId } : {}),
      ...(query.category ? { eventTypePrefix: query.category } : {}),
      ...(before ? { before } : {})
    });
    return {
      events: await auditView(options.store, accountId, page.events),
      nextCursor: encodePageCursor(page.nextCursor),
      hasMore: !!page.nextCursor
    };
  });

  app.get(
    "/api/v1/artifacts/:artifactId",
    { preHandler: requireAuthenticated },
    async (request, reply) => {
      const accountId = accountOf(request);
      const { artifactId } = z.object({ artifactId: z.string() }).parse(request.params);
      const artifact = await options.store.getArtifact(artifactId);
      if (!artifact || artifact.accountId !== accountId) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "artifact was not found");
      }
      const dispatch = await options.store.getDispatchByInvocation(artifact.invocationId);
      if (!visibleTask(request, dispatch)) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "artifact was not found");
      }
      if (collaboration && dispatch && !(await collaboration.resultVisible(dispatch.invocation, dispatch.nodeId)))
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "artifact was not found");
      let data = artifact.data;
      if (artifact.contentType === "image/png" && data.byteLength === 0) {
        if (!options.assetStore) {
          return apiError(
            reply,
            503,
            ErrorCodes.OFFLINE,
            "image asset storage is unavailable",
            true
          );
        }
        try {
          data = await options.assetStore.get(artifact.sha256);
        } catch (error) {
          requestLogError(app, error);
          return apiError(reply, 503, ErrorCodes.OFFLINE, "image asset is unavailable", true);
        }
      }
      return reply
        .type(artifact.contentType)
        .header("content-disposition", `attachment; filename="${artifact.artifactId}"`)
        .send(data);
    }
  );

  app.post("/mcp", { preHandler: requireAuthenticated }, async (request, reply) => {
    const principal = principals.get(request)!;
    if (principal.kind !== "agent") {
      return apiError(reply, 403, ErrorCodes.DENIED, "MCP requires a scoped Agent authorization.");
    }
    const grant = await options.store.getGrant(principal.grantId);
    if (!grant || grant.revokedAt || grant.accountId !== principal.accountId) {
      return apiError(reply, 403, ErrorCodes.DENIED, "Agent authorization is unavailable.");
    }
    const server = createMcpServer({
      client: {
        invoke: (invocation, options) =>
          invokeAndWait(invocation, principal, options?.waitMs, options?.signal)
      },
      context: grantContext(grant, await grantNodes(grant)),
      allowedTools: grant.allowedTools
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    } as any);
    reply.hijack();
    await server.connect(transport as any);
    reply.raw.once("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  app.route({
    method: ["GET", "DELETE"],
    url: "/mcp",
    preHandler: requireAuthenticated,
    handler: async (_request, reply) => reply.code(405).header("allow", "POST").send()
  });

  registerDistributionRoutes(app, options.nodeDistribution);
  registerSkillDistributionRoutes(app, options.skillDistribution);
  registerPluginDistributionRoutes(app, options.pluginDistribution);
  registerAndroidDistributionRoutes(app, options.androidDistribution);
  app.get("/api/v1/node-installation", { preHandler: requireOwner }, async () => {
    const androidPreview = await androidPreviewInfo(options.androidDistribution);
    return {
      ...await currentNodeDistributionInfo(options.nodeDistribution),
      ...(androidPreview ? { androidPreviewUrl: androidPreview.url } : {})
    };
  });

  if (options.consoleDirectory) {
    let loadedDirectory = await realpath(options.consoleDirectory);
    let publicSite = await PublicSite.load(loadedDirectory);
    let loading: Promise<void> | undefined;
    const currentSite = async () => {
      const directory = await realpath(options.consoleDirectory!);
      if (directory !== loadedDirectory) {
        loading ??= PublicSite.load(directory).then(site => {
          publicSite = site;
          loadedDirectory = directory;
        }).finally(() => { loading = undefined; });
        await loading;
      }
      return publicSite;
    };
    await app.register(fastifyStatic, {
      root: options.consoleDirectory,
      prefix: "/",
      wildcard: false,
      index: false
    });
    app.get("/robots.txt", async (_request, reply) =>
      reply.type("text/plain; charset=utf-8").send((await currentSite()).robots(options.access.origin))
    );
    app.get("/sitemap.xml", async (_request, reply) =>
      reply.type("application/xml; charset=utf-8").send((await currentSite()).sitemap(options.access.origin))
    );
    app.get("/llms.txt", async (_request, reply) =>
      reply.type("text/plain; charset=utf-8").send((await currentSite()).llms(options.access.origin))
    );
    app.get("/llms-full.txt", async (_request, reply) =>
      reply.type("text/plain; charset=utf-8").send((await currentSite()).llmsFull(options.access.origin))
    );
    app.get("/feed.xml", async (_request, reply) =>
      reply.type("application/rss+xml; charset=utf-8").send((await currentSite()).feed(options.access.origin))
    );
    const serveConsole = async (request: FastifyRequest, reply: FastifyReply) => {
      const pathname = new URL(request.url, options.access.origin).pathname;
      if (pathname.startsWith("/assets/")) {
        return reply.sendFile(pathname.slice(1), {
          immutable: true,
          maxAge: "1y"
        });
      }
      if (
        pathname.startsWith("/api/") ||
        pathname.startsWith("/downloads/") ||
        pathname === "/mcp"
      ) {
        return apiError(reply, 404, ErrorCodes.NOT_FOUND, "route was not found");
      }
      const rendered = (await currentSite()).renderHtml(pathname, options.access.origin, options.analytics);
      if (!rendered.isPublic) reply.header("x-robots-tag", "noindex, nofollow");
      return reply
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-cache")
        .send(rendered.html);
    };
    app.get("/", serveConsole);
    app.get("/*", serveConsole);
  }

  app.addHook("preClose", async () => taskWaitHub.close());
  app.addHook("onClose", async () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    await cleanupRunning;
    taskWaitHub.close();
    wakeHub.close();
    await options.store.close();
  });
  return app;
}

function requestLogError(app: FastifyInstance, error: unknown): void {
  // SDK errors can embed signed request URLs and headers.
  const code = (error as { code?: unknown } | undefined)?.code;
  app.log.error(
    {
      errorType: error instanceof Error ? error.name : "unknown",
      ...(typeof code === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(code) ? { code } : {})
    },
    "unhandled control plane error"
  );
}

async function placeInvocation(
  store: Store,
  invocation: Invocation,
  grant: AgentGrantRecord,
  projectedNodes?: NodeRecord[]
): Promise<
  | { node: NonNullable<Awaited<ReturnType<Store["getNode"]>>>; reason: string }
  | {
      status: "denied" | "offline";
      error: AdcError;
    }
> {
  if ("nodeId" in invocation.target) {
    const node = projectedNodes ? projectedNodes.find((entry) => entry.nodeId === (invocation.target as { nodeId: string }).nodeId)
      : await store.getNode(invocation.target.nodeId);
    if (!node || (!projectedNodes && node.accountId !== invocation.accountId) || !grant.nodeIds.includes(node.nodeId)) {
      return {
        status: "denied",
        error: {
          code: ErrorCodes.DENIED,
          message: "explicit target is not visible to this agent",
          retryable: false
        }
      };
    }
    return { node, reason: "explicit_node" };
  }

  const roots = await store.listRoots(invocation.target.projectId);
  const requestedRoots = new Set(invocation.authorization.rootIds);
  const candidateIds = [
    ...new Set(
      roots
        .filter(
          (root) =>
            grant.nodeIds.includes(root.nodeId) &&
            grant.rootIds.includes(root.rootId) &&
            (requestedRoots.size === 0 || requestedRoots.has(root.rootId))
        )
        .map((root) => root.nodeId)
    )
  ].sort();
  if (candidateIds.length === 0) {
    return {
      status: "denied",
      error: {
        code: ErrorCodes.DENIED,
        message: "no granted device is bound to the project and requested roots",
        retryable: false
      }
    };
  }
  if (candidateIds.length > 1 && !invocation.target.affinity) {
    return {
      status: "denied",
      error: {
        code: ErrorCodes.AMBIGUOUS_TARGET,
        message: "multiple devices match; specify nodeId or affinity",
        retryable: false,
        details: { candidates: candidateIds }
      }
    };
  }
  const selectedId = invocation.target.affinity
    ? candidateIds[
        Number.parseInt(hash(invocation.target.affinity).slice(0, 8), 16) % candidateIds.length
      ]!
    : candidateIds[0]!;
  const node = await store.getNode(selectedId);
  if (!node) {
    return {
      status: "offline",
      error: {
        code: ErrorCodes.OFFLINE,
        message: "bound device no longer exists",
        retryable: false
      }
    };
  }
  return {
    node,
    reason: invocation.target.affinity ? "project_affinity" : "project_single_binding"
  };
}
