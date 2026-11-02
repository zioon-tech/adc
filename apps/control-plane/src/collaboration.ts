import type { AgentGrantRecord, CollaborationStore, NodeRecord, ResourceBinding, Store, TeamMembership } from "@adc/db";
import {
  CollaborationScopeSchema, DelegationSchema, ProtocolError, ReadOnlyTools,
  absolutePathForToolArgs, isBuiltinTool, isSideEffectTool,
  isDeviceRoot,
  type CollaborationScope, type Delegation, type Invocation
} from "@adc/protocol";
import { requiresApproval } from "@adc/policy";
import type { Principal } from "./access.ts";
import { effectiveCapability, type GrantSettingsSchema } from "./resource-management.ts";
import type { z } from "zod";

const unavailable = (message = "Device access is unavailable.") => new ProtocolError("denied", message, false);
const controlTools = new Set(["device.list", "device.status", "task.status", "task.result", "task.wait", "task.cancel"]);
const safeReads = new Set(["file.list", "file.read", "file.search"]);
const forbiddenSegments = new Set([
  ".ssh", ".aws", ".gnupg", ".kube", ".npmrc", ".netrc", ".env", "credentials",
  ".adc", ".zion", ".config", "launchagents", "launchdaemons", "systemd"
]);
const folderPath = (node: NodeRecord, root: { rootId: string; path?: string | undefined }) =>
  root.path ?? node.capability?.collaboration?.roots?.find((entry) => entry.rootId === root.rootId)?.path;

export function principalUserId(actor: Principal): string | undefined {
  return actor.kind === "session" ? actor.user.id : actor.kind === "pat" ? actor.userId : undefined;
}

export function intersectScope(a: CollaborationScope, b: CollaborationScope): CollaborationScope {
  return {
    roots: a.roots.flatMap((root) => {
      const other = b.roots.find((entry) => entry.rootId === root.rootId && entry.path === root.path);
      return other ? [{ ...root, writable: root.writable && other.writable }] : [];
    }),
    allowedTools: a.allowedTools.filter((tool) => b.allowedTools.includes(tool)),
    execution: a.execution === b.execution ? a.execution : "read-only",
    // Approval policies are checked independently; the projection is conservative.
    approvalPolicy: a.approvalPolicy === b.approvalPolicy ? a.approvalPolicy
      : a.approvalPolicy === "never" ? b.approvalPolicy : b.approvalPolicy === "never" ? a.approvalPolicy : "always",
    templateIds: a.templateIds.filter((id) => b.templateIds.includes(id))
  };
}

export function scopeIsSubset(next: CollaborationScope, previous: CollaborationScope) {
  return next.allowedTools.every((tool) => previous.allowedTools.includes(tool))
    && next.roots.every((root) => previous.roots.some((old) =>
      old.rootId === root.rootId && old.path === root.path && (!root.writable || old.writable)))
    && (next.execution === "read-only" || next.execution === previous.execution)
    && next.templateIds.every((id) => previous.templateIds.includes(id))
    && ["file.read", "file.write", "shell.exec", "mcp.check"].every((tool) =>
      !requiresApproval(previous.approvalPolicy, "workspace-write", tool) ||
      requiresApproval(next.approvalPolicy, "workspace-write", tool));
}

/** Checks the owner-selected scope against the device's current exact roots. */
export function validateCollaborationScope(
  node: NodeRecord, raw: CollaborationScope, acknowledgeHostTrust = false, kind: "team" | "share" = "share"
): CollaborationScope {
  const scope = CollaborationScopeSchema.parse(raw);
  const capability = effectiveCapability(node);
  if (node.platform === "android" || node.status !== "active" || node.deletedAt ||
      node.resourceClass !== "physical") throw unavailable("This device cannot be shared.");
  if (capability?.collaboration?.version !== 1)
    throw unavailable("Update the Connector and enable local device sharing first.");
  if (scope.execution === "trusted-host" && !capability.collaboration.trustedHost)
    throw unavailable("Enable trusted sharing on the device first.");
  if (scope.execution === "isolated" && capability.collaboration.isolation === "none")
    throw unavailable("Configure and verify local container isolation first.");
  if (scope.execution === "isolated" && scope.allowedTools.some((tool) => !controlTools.has(tool) && !isBuiltinTool(tool)))
    throw unavailable("Isolated sharing supports built-in file and command tools.");
  if (new Set(scope.roots.map((root) => root.rootId)).size !== scope.roots.length ||
      new Set(scope.allowedTools).size !== scope.allowedTools.length) throw unavailable("Duplicate permissions are not allowed.");
  for (const root of scope.roots) {
    const local = capability?.roots.find((entry) => entry.rootId === root.rootId);
    if (!local || folderPath(node, local) !== root.path || (root.writable && !local.writable))
      throw unavailable("Select exact folders currently exposed by the device.");
    if (isDeviceRoot(root.path)) {
      if (kind !== "team") throw unavailable("Whole-device roots can be shared with a team. External sharing requires a narrower folder.");
      if (!capability.collaboration.features?.includes("team-root-sharing"))
        throw unavailable("Update this device to Connector 0.1.6 or newer to share its root with a team.");
      if (scope.execution === "isolated")
        throw unavailable("Whole-device team access supports reads or trusted host execution. Choose a smaller folder for isolated execution.");
    }
    if (root.path.split(/[\\/]/).some((part) => forbiddenSegments.has(part.toLowerCase())))
      throw unavailable("Choose a project folder without device credentials or service configuration.");
  }
  if (scope.execution === "read-only" &&
      (scope.roots.some((root) => root.writable) ||
       scope.allowedTools.some((tool) => !safeReads.has(tool) && !controlTools.has(tool))))
    throw unavailable("Read-only sharing supports structured file reads.");
  if (scope.execution === "trusted-host" && !acknowledgeHostTrust)
    throw unavailable("Host access requires an explicit acknowledgement of trust and revocation limits.");
  if (scope.execution !== "read-only" && !scope.roots.length)
    throw unavailable("Choose at least one folder for editing or execution.");
  if (scope.allowedTools.some((tool) => !controlTools.has(tool) && !capability?.tools.some((entry) => entry.name === tool)))
    throw unavailable("Choose tools currently available on the device.");
  return scope;
}

export class CollaborationAuthorization {
  constructor(readonly store: Store, readonly relationships: CollaborationStore, readonly now: () => Date) {}

  async grantUser(grant: AgentGrantRecord): Promise<string | undefined> {
    if (grant.responsibleUserId) return grant.responsibleUserId;
    const result = await this.relationships.pool.query(
      "SELECT user_id FROM adc_accounts WHERE account_id = $1 AND kind = 'personal'", [grant.accountId]
    );
    return result.rows[0]?.user_id ?? undefined;
  }

  private nodeScope(node: NodeRecord, writable: boolean): CollaborationScope {
    const capability = effectiveCapability(node);
    return {
      roots: (capability?.roots ?? []).flatMap((root) => {
        const path = folderPath(node, root);
        return path ? [{ rootId: root.rootId, path, writable: writable && root.writable }] : [];
      }),
      allowedTools: (capability?.tools ?? []).map((tool) => tool.name)
        .filter((tool) => writable || safeReads.has(tool)),
      execution: writable ? "trusted-host" : "read-only", approvalPolicy: "never", templateIds: []
    };
  }

  private async memberFor(accountId: string, userId: string) {
    const kind = await this.relationships.accountKind(accountId);
    const member = kind === "team" ? await this.relationships.member(accountId, userId) : undefined;
    if (kind === "team" && !member) throw unavailable("Team membership was removed.");
    return member;
  }

  private teamScope(node: NodeRecord, member: TeamMembership, upper: CollaborationScope) {
    const rule = member.rules.find((entry) => entry.nodeId === node.nodeId);
    if (rule) return intersectScope(upper, rule.scope);
    if (member.role === "owner" || member.role === "admin")
      return intersectScope(upper, this.nodeScope(node, false));
    return { ...upper, roots: [], allowedTools: [], execution: "read-only" as const };
  }

  async resolveNode(
    accountId: string, userId: string, node: NodeRecord, grant?: AgentGrantRecord,
    selectedBindingId?: string
  ): Promise<NodeRecord | undefined> {
    if (node.status !== "active" || node.deletedAt) return undefined;
    const member = await this.memberFor(accountId, userId);
    if ((member || node.accountId !== accountId) && node.resourceClass !== "physical") return undefined;
    let binding: ResourceBinding | undefined;
    let scope: CollaborationScope | undefined;
    const granted = grant?.resourceBindings?.find((entry) => entry.nodeId === node.nodeId);
    if (node.accountId === accountId) {
      if (!member) return node;
      const upper = this.nodeScope(node, true);
      upper.execution = member.rules.find(rule => rule.nodeId === node.nodeId)?.scope.execution ?? upper.execution;
      scope = this.teamScope(node, member, upper);
    } else {
      const bindingId = selectedBindingId ?? granted?.bindingId;
      binding = bindingId ? await this.relationships.getBinding(bindingId)
        : (await this.relationships.bindings(accountId, "received")).find((entry) => entry.nodeId === node.nodeId && entry.state === "active");
      if (!binding || binding.state !== "active" || binding.nodeId !== node.nodeId ||
          binding.recipientAccountId !== accountId || binding.resourceAccountId !== node.accountId ||
          (binding.expiresAt && Date.parse(binding.expiresAt) <= this.now().getTime()) ||
          (binding.kind === "share" ? binding.recipientUserId !== userId : !member)) return undefined;
      scope = member ? this.teamScope(node, member, binding.scope) : binding.scope;
    }
    if (grant) {
      // A binding alone is insufficient: the grant captures a per-device scope.
      if (!granted?.scope || (binding && granted.bindingId !== binding.bindingId)) return undefined;
      scope = intersectScope(scope, granted.scope);
    }
    const capability = effectiveCapability(node);
    scope = {
      ...scope,
      roots: scope.roots.filter((root) => capability?.roots.some((local) =>
        local.rootId === root.rootId && folderPath(node, local) === root.path))
        .map((root) => ({ ...root, writable: root.writable && !!capability?.roots.find((local) => local.rootId === root.rootId)?.writable })),
      allowedTools: scope.allowedTools.filter((tool) =>
        controlTools.has(tool) || capability?.tools.some((local) => local.name === tool))
    };
    if (!scope.allowedTools.length) return undefined;
    const wholeDevice = scope.roots.some(root => isDeviceRoot(root.path));
    const teamRoot = wholeDevice && (binding?.kind === "team" || !!member && node.accountId === accountId);
    if (wholeDevice && (!teamRoot || !capability?.collaboration?.features?.includes("team-root-sharing") ||
        scope.execution === "isolated")) return undefined;
    const resourceAuthorization: Delegation = DelegationSchema.parse({
      version: 1, requesterAccountId: accountId, requesterUserId: userId,
      resourceAccountId: node.accountId,
      ...(binding ? { bindingId: binding.bindingId, bindingRevision: binding.revision } : {}),
      ...(teamRoot ? { bindingKind: "team" } : {}),
      ...(member ? { membershipRevision: member.revision } : {}),
      grantRevision: grant?.revision ?? 1, scope,
      expiresAt: binding?.expiresAt ?? new Date(this.now().getTime() + 24 * 3600_000).toISOString()
    });
    return {
      ...node, resourceAuthorization,
      capability: capability ? {
        ...capability,
        ...(capability.collaboration ? { collaboration: {
          ...capability.collaboration,
          roots: scope.roots.map((root) => ({ rootId: root.rootId, path: root.path }))
        } } : {}),
        roots: capability.roots.filter((root) => scope.roots.some((entry) => entry.rootId === root.rootId))
          .map((root) => ({ ...root, writable: !!scope.roots.find((entry) => entry.rootId === root.rootId)?.writable })),
        tools: capability.tools.filter((tool) => scope.allowedTools.includes(tool.name))
      } : undefined
    } as NodeRecord;
  }

  async nodes(accountId: string, userId: string, grant?: AgentGrantRecord): Promise<NodeRecord[]> {
    const member = await this.memberFor(accountId, userId);
    const owned = await this.store.listNodes(accountId);
    const received = await this.relationships.bindings(accountId, "received");
    const ids = new Set([...owned.map((node) => node.nodeId),
      ...received.filter((binding) => binding.state === "active" && (!member ? binding.recipientUserId === userId : binding.kind === "team"))
        .map((binding) => binding.nodeId)]);
    if (grant) for (const id of [...ids]) if (!grant.nodeIds.includes(id)) ids.delete(id);
    const projected: NodeRecord[] = [];
    for (const id of ids) {
      const node = owned.find((entry) => entry.nodeId === id) ?? await this.store.getNode(id);
      if (!node) continue;
      const resolved = await this.resolveNode(accountId, userId, node, grant);
      if (resolved) projected.push(resolved);
    }
    return projected;
  }

  async grantNodes(grant: AgentGrantRecord) {
    const userId = await this.grantUser(grant);
    return userId ? this.nodes(grant.accountId, userId, grant) : [];
  }

  async resultVisible(invocation: Invocation, nodeId: string): Promise<boolean> {
    const delegated = invocation.delegation;
    if (!delegated) return true;
    const grant = await this.store.getGrant(invocation.authorization.grantId);
    const node = await this.store.getNode(nodeId);
    if (!grant || grant.revokedAt || grant.deletedAt || !node ||
        grant.revision !== delegated.grantRevision) return false;
    try {
      const current = await this.resolveNode(invocation.accountId, delegated.requesterUserId, node, grant);
      const authority = current?.resourceAuthorization;
      return !!authority && authority.resourceAccountId === delegated.resourceAccountId &&
        authority.bindingId === delegated.bindingId && authority.bindingRevision === delegated.bindingRevision &&
        authority.membershipRevision === delegated.membershipRevision && authority.bindingKind === delegated.bindingKind &&
        authority.scope.execution === delegated.scope.execution &&
        authority.scope.allowedTools.includes(invocation.tool) &&
        delegated.scope.roots.every(root => authority.scope.roots.some(local => local.rootId === root.rootId &&
          local.path === root.path && (!root.writable || local.writable))) &&
        node.capability?.collaboration?.version === 1 &&
        (authority.scope.execution !== "trusted-host" || node.capability.collaboration.trustedHost) &&
        (authority.scope.execution !== "isolated" || node.capability.collaboration.isolation !== "none");
    } catch { return false; }
  }

  async validateGrant(
    actor: Principal, body: z.infer<typeof GrantSettingsSchema>,
    requested: { nodeId: string; bindingId: string }[] = [], previous?: AgentGrantRecord
  ) {
    const userId = principalUserId(actor);
    if (!userId) throw unavailable("A responsible user is required.");
    const member = await this.memberFor(actor.accountId, userId);
    const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    if (previous && previous.responsibleUserId === userId && body.profile === previous.profile &&
        body.projectId === previous.projectId && body.rootAccess === (previous.rootAccess ?? "selected") &&
        (body.approvalPolicy ?? "never") === (previous.approvalPolicy ?? "never") &&
        same(body.nodeIds, previous.nodeIds) && same(body.rootIds, previous.rootIds) && same(body.allowedTools, previous.allowedTools) &&
        (!requested.length || same(requested.map(binding => `${binding.nodeId}:${binding.bindingId}`),
          (previous.resourceBindings ?? []).map(binding => `${binding.nodeId}:${binding.bindingId}`))))
      return { responsibleUserId: userId, resourceBindings: previous.resourceBindings ?? [] };
    const result: NonNullable<AgentGrantRecord["resourceBindings"]> = [];
    const availableTools = new Set(controlTools);
    const availableRoots = new Set<string>();
    for (const nodeId of body.nodeIds) {
      const node = await this.store.getNode(nodeId);
      if (!node) throw unavailable();
      const selected = requested.find((entry) => entry.nodeId === nodeId);
      const projection = await this.resolveNode(actor.accountId, userId, node, undefined, selected?.bindingId);
      if (!projection) throw unavailable();
      for (const tool of projection.capability?.tools ?? []) availableTools.add(tool.name);
      for (const root of projection.capability?.roots ?? []) availableRoots.add(root.rootId);
      if (!projection.resourceAuthorization) continue;
      if (body.projectId || body.rootAccess === "all") throw unavailable("Team and shared devices require exact folders and an explicit device.");
      const scope = projection.resourceAuthorization.scope;
      result.push({
        nodeId, bindingId: projection.resourceAuthorization.bindingId ?? `team:${actor.accountId}:${nodeId}`,
        scope: {
          ...scope, roots: scope.roots.filter((root) => body.rootIds.includes(root.rootId)),
          allowedTools: [...new Set([...scope.allowedTools.filter((tool) => body.allowedTools.includes(tool)),
            ...body.allowedTools.filter((tool) => controlTools.has(tool))])]
        }
      });
    }
    if (body.allowedTools.some((tool) => !availableTools.has(tool)) ||
        (body.rootAccess !== "all" && body.rootIds.some((root) => !availableRoots.has(root))))
      throw unavailable("Agent permissions exceed the selected devices' permissions.");
    if (member && result.length !== body.nodeIds.length) throw unavailable();
    return { responsibleUserId: userId, resourceBindings: result };
  }

  async authorizeInvocation(invocation: Invocation, grant: AgentGrantRecord, node: NodeRecord) {
    const userId = await this.grantUser(grant);
    if (!userId) return undefined;
    const current = await this.resolveNode(invocation.accountId, userId, node, grant);
    if (!current) return undefined;
    const expected = current.resourceAuthorization;
    if (!expected) return invocation.delegation ? undefined : current;
    const supplied = invocation.delegation;
    if (!supplied || supplied.requesterAccountId !== invocation.accountId ||
        supplied.requesterUserId !== userId || supplied.resourceAccountId !== node.accountId ||
        supplied.bindingId !== expected.bindingId || supplied.bindingRevision !== expected.bindingRevision ||
        supplied.bindingKind !== expected.bindingKind ||
        supplied.membershipRevision !== expected.membershipRevision ||
        supplied.grantRevision !== expected.grantRevision ||
        Date.parse(supplied.expiresAt) <= this.now().getTime()) return undefined;
    const scope = expected.scope;
    if (!scope.allowedTools.includes(invocation.tool) || invocation.tool === "file.transfer") return undefined;
    if (node.capability?.collaboration?.version !== 1) return undefined;
    if (scope.execution === "read-only" && !safeReads.has(invocation.tool)) return undefined;
    if (scope.execution === "trusted-host" && !node.capability.collaboration.trustedHost) return undefined;
    if (scope.execution === "isolated" && node.capability.collaboration.isolation === "none") return undefined;
    const args = invocation.args as Record<string, unknown>;
    if (["command.template.run", "test.run"].includes(invocation.tool) &&
        typeof args.templateId === "string" && !scope.templateIds.includes(args.templateId)) return undefined;
    const absolutePath = absolutePathForToolArgs(invocation.tool, args);
    if (invocation.tool === "command.template.list") return current;
    if (!absolutePath && typeof args.rootId !== "string" && !controlTools.has(invocation.tool)) return undefined;
    if (scope.execution === "read-only" && (!isBuiltinTool(invocation.tool) || isSideEffectTool(invocation.tool) || !ReadOnlyTools.has(invocation.tool))) return undefined;
    return current;
  }

  async requiredConsents(invocation: Invocation, grant: AgentGrantRecord) {
    const delegated = invocation.delegation;
    if (!delegated) return [];
    const binding = delegated.bindingId ? await this.relationships.getBinding(delegated.bindingId) : undefined;
    const member = await this.relationships.member(invocation.accountId, delegated.requesterUserId);
    const nodeId = "nodeId" in invocation.target ? invocation.target.nodeId : undefined;
    const rule = member?.rules.find((entry) => entry.nodeId === nodeId);
    const required: NonNullable<import("@adc/db").ApprovalRecord["requiredConsents"]> = [];
    const ownerRequired = binding && requiresApproval(binding.scope.approvalPolicy, grant.profile, invocation.tool);
    const requesterRequired = requiresApproval(grant.approvalPolicy, grant.profile, invocation.tool) ||
      (rule && requiresApproval(rule.scope.approvalPolicy, grant.profile, invocation.tool));
    if (requesterRequired || !ownerRequired) required.push({
      accountId: invocation.accountId, userId: delegated.requesterUserId, role: "requester"
    });
    if (ownerRequired) required.push({ accountId: delegated.resourceAccountId, role: "resource" });
    return required;
  }
}
