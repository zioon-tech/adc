import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CollaborationScopeSchema, ProtocolError } from "@adc/protocol";
import type { ResourceBinding } from "@adc/db";
import type { Principal } from "./access.ts";
import { CollaborationAuthorization, principalUserId, scopeIsSubset, validateCollaborationScope } from "./collaboration.ts";
import { effectiveCapability } from "./resource-management.ts";

const revision = z.number().int().positive();
const invitationId = (request: FastifyRequest) => z.object({ invitationId: z.string() }).parse(request.params).invitationId;
const bindingId = (request: FastifyRequest) => z.object({ bindingId: z.string() }).parse(request.params).bindingId;
const teamId = (request: FastifyRequest) => z.object({ accountId: z.string() }).parse(request.params).accountId;

export function registerCollaborationRoutes(app: FastifyInstance, options: {
  authorization: CollaborationAuthorization;
  requireAuthenticated: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  principal: (request: FastifyRequest) => Principal;
  origin: string;
  wakeNode: (nodeId: string) => void;
}) {
  const { authorization: authz } = options;
  const relationships = authz.relationships;
  const user = (request: FastifyRequest) => {
    const actor = options.principal(request);
    const userId = principalUserId(actor);
    if (!userId || actor.kind === "agent" || (actor.kind === "pat" && actor.readOnly &&
        !["GET", "HEAD"].includes(request.method))) throw new ProtocolError("denied", "Use your own account management session.", false);
    return { actor, userId };
  };
  const manager = (request: FastifyRequest) => {
    const current = user(request);
    if (current.actor.team?.membership.role === "member")
      throw new ProtocolError("denied", "Team administration requires an owner or admin.", false);
    return current;
  };
  const session = (request: FastifyRequest) => {
    const current = user(request);
    if (current.actor.kind !== "session" || !current.actor.user.emailVerified)
      throw new ProtocolError("denied", "Verify your account email before accepting an invitation.", false);
    return current.actor;
  };
  const route = { preHandler: options.requireAuthenticated };
  const ownedBinding = async (request: FastifyRequest) => {
    const { actor } = manager(request);
    const binding = await relationships.getBinding(bindingId(request));
    if (!binding || binding.resourceAccountId !== actor.accountId)
      throw new ProtocolError("not_found", "Sharing permission was not found.", false);
    return binding;
  };
  const checkedScope = async (nodeId: string, accountId: string, scope: z.infer<typeof CollaborationScopeSchema>, acknowledge: boolean, kind: "team" | "share" = "share") => {
    const node = await authz.store.getNode(nodeId);
    if (!node || node.accountId !== accountId) throw new ProtocolError("not_found", "Device was not found.", false);
    return validateCollaborationScope(node, scope, acknowledge, kind);
  };
  app.get("/api/v1/accounts", route, async (request) => {
    const { actor, userId } = user(request);
    return {
      selectedAccountId: actor.accountId,
      personalAccountId: actor.personalAccountId ?? actor.accountId,
      teams: await relationships.listTeams(userId)
    };
  });
  app.post("/api/v1/teams", route, async (request) => {
    const { userId } = user(request);
    const body = z.object({ name: z.string().trim().min(1).max(128) }).strict().parse(request.body);
    return relationships.createTeam(userId, body.name);
  });
  app.get("/api/v1/teams/:accountId/members", route, async (request) => {
    const { userId } = user(request);
    const current = await relationships.member(teamId(request), userId);
    if (!current || current.role === "member")
      throw new ProtocolError("denied", "Team administration requires an owner or admin.", false);
    return { members: await relationships.listMembers(teamId(request), userId) };
  });
  app.patch("/api/v1/teams/:accountId/members/:userId", route, async (request) => {
    const { userId: actorUserId } = user(request);
    const params = z.object({ accountId: z.string(), userId: z.string() }).parse(request.params);
    const body = z.object({
      revision, role: z.enum(["owner", "admin", "member"]), state: z.enum(["active", "removed"]),
      rules: z.array(z.object({ nodeId: z.string(), scope: CollaborationScopeSchema }).strict()).max(64),
      acknowledgeHostTrust: z.boolean().default(false)
    }).strict().parse(request.body);
    const members = await relationships.member(params.accountId, actorUserId);
    if (!members || members.role === "member") throw new ProtocolError("denied", "Team administration requires an owner or admin.", false);
    const received = await relationships.bindings(params.accountId, "received");
    for (const rule of body.rules) {
      const node = await authz.store.getNode(rule.nodeId);
      if (!node || (node.accountId !== params.accountId && !received.some((entry) =>
          entry.kind === "team" && entry.nodeId === node.nodeId && entry.state === "active")))
        throw new ProtocolError("denied", "Policy devices must be available to this team.", false);
      validateCollaborationScope(node, rule.scope, body.acknowledgeHostTrust, "team");
    }
    if (new Set(body.rules.map((rule) => rule.nodeId)).size !== body.rules.length)
      throw new ProtocolError("invalid_request", "Each device may appear only once in a member policy.", false);
    const result = await relationships.changeMember(params.accountId, actorUserId, params.userId, body.revision, {
      role: body.role, state: body.state, rules: body.rules
    });
    for (const node of await authz.store.listNodes(params.accountId)) options.wakeNode(node.nodeId);
    for (const binding of received) options.wakeNode(binding.nodeId);
    return result;
  });
  app.post("/api/v1/teams/:accountId/leave", route, async (request) => {
    const { userId } = user(request);
    const body = z.object({ revision }).strict().parse(request.body);
    return relationships.leaveTeam(teamId(request), userId, body.revision);
  });
  app.post("/api/v1/teams/:accountId/invitations", route, async (request) => {
    const { userId } = user(request);
    const body = z.object({ email: z.email().max(320), role: z.enum(["admin", "member"]).default("member") }).strict().parse(request.body);
    const result = await relationships.invite({
      kind: "member", senderAccountId: teamId(request), senderUserId: userId, recipientEmail: body.email,
      teamAccountId: teamId(request), role: body.role, expiresAt: new Date(authz.now().getTime() + 7 * 86_400_000).toISOString()
    });
    return { ...result, link: `${options.origin}/invitations/${result.invitation.invitationId}#${result.token}` };
  });
  app.post("/api/v1/teams/:accountId/devices", route, async (request) => {
    const { actor, userId } = manager(request);
    const body = z.object({
      nodeId: z.string(), scope: CollaborationScopeSchema, acknowledgeHostTrust: z.boolean().default(false)
    }).strict().parse(request.body);
    const scope = await checkedScope(body.nodeId, actor.accountId, body.scope, body.acknowledgeHostTrust, "team");
    return relationships.linkTeamDevice(userId, actor.accountId, teamId(request), body.nodeId, scope);
  });
  app.get("/api/v1/teams/:accountId/devices", route, async (request) => {
    const { userId } = user(request);
    const member = await relationships.member(teamId(request), userId);
    if (!member || member.role === "member") throw new ProtocolError("denied", "Team administration requires an owner or admin.", false);
    const bindings = (await relationships.bindings(teamId(request), "received")).filter(binding =>
      binding.kind === "team" && binding.state === "active" && (!binding.expiresAt || Date.parse(binding.expiresAt) > authz.now().getTime()));
    const owned = await authz.store.listNodes(teamId(request));
    const linked = await Promise.all(bindings.map(binding => authz.store.getNode(binding.nodeId)));
    return { nodes: [...owned, ...linked.filter(node => !!node)].filter(node => node.status === "active" && !node.deletedAt).map(node => {
      const upper = bindings.find(binding => binding.nodeId === node.nodeId)?.scope;
      const capability = effectiveCapability(node);
      const roots = capability?.roots.filter(root => !upper || upper.roots.some(entry => entry.rootId === root.rootId))
        .map(root => ({ ...root, writable: root.writable && (!upper || !!upper.roots.find(entry => entry.rootId === root.rootId)?.writable) }));
      return { nodeId: node.nodeId, accountId: node.accountId, label: node.label, platform: node.platform,
        status: node.status, capability: capability ? { ...capability, roots,
          tools: capability.tools.filter(tool => !upper || upper.allowedTools.includes(tool.name)),
          collaboration: capability.collaboration ? { ...capability.collaboration,
            roots: capability.collaboration.roots?.filter(root => roots?.some(entry => entry.rootId === root.rootId)),
            trustedHost: capability.collaboration.trustedHost && (!upper || upper.execution === "trusted-host"),
            isolation: upper && upper.execution !== "isolated" ? "none" : capability.collaboration.isolation
          } : undefined } : undefined };
    }) };
  });
  app.post("/api/v1/nodes/:nodeId/share-invitations", route, async (request) => {
    const { actor, userId } = manager(request);
    const nodeId = z.object({ nodeId: z.string() }).parse(request.params).nodeId;
    const body = z.object({
      email: z.email().max(320), scope: CollaborationScopeSchema,
      durationDays: z.number().int().min(1).max(365).nullable().default(30),
      acknowledgeHostTrust: z.boolean().default(false)
    }).strict().parse(request.body);
    const scope = await checkedScope(nodeId, actor.accountId, body.scope, body.acknowledgeHostTrust);
    const result = await relationships.invite({
      kind: "share", senderAccountId: actor.accountId, senderUserId: userId, recipientEmail: body.email,
      nodeId, scope, durationDays: body.durationDays, expiresAt: new Date(authz.now().getTime() + 7 * 86_400_000).toISOString()
    });
    return { ...result, link: `${options.origin}/invitations/${result.invitation.invitationId}#${result.token}` };
  });
  app.get("/api/v1/share-invitations", route, async (request) => {
    const { actor, userId } = user(request);
    const email = actor.kind === "session" && actor.user.emailVerified ? actor.user.email : undefined;
    const invitations = await relationships.invitations(actor.accountId, email, userId);
    return { invitations: invitations.filter((entry) =>
      entry.senderAccountId !== actor.accountId ||
      !actor.team || actor.team.membership.role !== "member") };
  });
  app.get("/api/v1/share-invitations/:invitationId", route, async (request) => {
    const actor = session(request);
    const query = z.object({ token: z.string().max(128).optional() }).strict().parse(request.query);
    return relationships.invitationPreview(invitationId(request), actor.user.email, query.token, actor.user.id);
  });
  for (const decision of ["accept", "decline"] as const) {
    app.post(`/api/v1/share-invitations/:invitationId/${decision}`, route, async (request) => {
      const actor = session(request);
      const body = z.object({ revision, token: z.string().max(128).optional() }).strict().parse(request.body);
      return relationships.respondInvitation(invitationId(request), {
        userId: actor.user.id, accountId: actor.personalAccountId ?? actor.accountId, verifiedEmail: actor.user.email
      }, body.revision, decision, body.token);
    });
  }
  app.post("/api/v1/share-invitations/:invitationId/revoke", route, async (request) => {
    const { actor, userId } = manager(request);
    const body = z.object({ revision }).strict().parse(request.body);
    return relationships.revokeInvitation(actor.accountId, userId, invitationId(request), body.revision);
  });
  app.get("/api/v1/device-shares", route, async (request) => {
    const { actor, userId } = user(request);
    const query = z.object({ direction: z.enum(["received", "owned"]).default("received") }).strict().parse(request.query);
    if (query.direction === "owned") manager(request);
    const shares = await relationships.bindings(actor.accountId, query.direction);
    if (actor.team?.membership.role === "member") {
      const nodes = await authz.nodes(actor.accountId, userId);
      return { shares: shares.flatMap((binding) => {
        const scope = nodes.find((node) => node.resourceAuthorization?.bindingId === binding.bindingId)?.resourceAuthorization?.scope;
        return scope ? [{ ...binding, scope }] : [];
      }) };
    }
    return { shares };
  });
  app.patch("/api/v1/device-shares/:bindingId", route, async (request) => {
    const previous = await ownedBinding(request);
    const { actor, userId } = manager(request);
    const body = z.object({
      revision, scope: CollaborationScopeSchema.optional(),
      expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
      state: z.enum(["active", "paused"]).optional(), acknowledgeHostTrust: z.boolean().default(false)
    }).strict().parse(request.body);
    const scope = body.scope ? await checkedScope(previous.nodeId, actor.accountId, body.scope, body.acknowledgeHostTrust, previous.kind) : previous.scope;
    const expiresAt = body.expiresAt === undefined ? previous.expiresAt : body.expiresAt;
    const expands = !scopeIsSubset(scope, previous.scope) ||
      (previous.expiresAt !== null && (expiresAt === null || Date.parse(expiresAt) > Date.parse(previous.expiresAt)));
    if (expands && previous.kind === "share") {
      if (previous.state !== "active" || previous.revision !== body.revision ||
          (previous.expiresAt && Date.parse(previous.expiresAt) <= authz.now().getTime()))
        throw new ProtocolError("conflict", "Refresh the sharing permission before proposing a change.", false);
      const prior = (await relationships.invitations(actor.accountId)).find((entry) => entry.acceptedBindingId === previous.bindingId);
      if (!prior) throw new ProtocolError("conflict", "The original accepted invitation is unavailable.", false);
      const result = await relationships.invite({
        kind: "scope", senderAccountId: actor.accountId, senderUserId: userId, recipientEmail: prior.recipientEmail,
        targetUserId: previous.recipientUserId!, nodeId: previous.nodeId, bindingId: previous.bindingId,
        bindingRevision: previous.revision, scope,
        bindingExpiresAt: expiresAt,
        expiresAt: new Date(authz.now().getTime() + 7 * 86_400_000).toISOString()
      });
      return { pending: true, ...result };
    }
    if (expands && previous.kind === "team") {
      const member = await relationships.member(previous.recipientAccountId, userId);
      if (!member || member.role === "member") throw new ProtocolError("denied", "Expanding team device access requires administration of both accounts.", false);
    }
    const changes: Partial<Pick<ResourceBinding, "scope" | "expiresAt" | "state">> = { scope, expiresAt };
    if (body.state) changes.state = body.state;
    const result = await relationships.changeBinding(actor.accountId, userId, previous.bindingId, body.revision, changes, false, expands && previous.kind === "team");
    options.wakeNode(previous.nodeId);
    return result;
  });
  for (const action of ["revoke", "leave"] as const) {
    app.post(`/api/v1/device-shares/:bindingId/${action}`, route, async (request) => {
      const { actor, userId } = action === "revoke" ? manager(request) : user(request);
      const body = z.object({ revision }).strict().parse(request.body);
      const result = await relationships.changeBinding(actor.accountId, userId, bindingId(request), body.revision, { state: "revoked" }, action === "leave");
      options.wakeNode(result.nodeId);
      return result;
    });
  }
  app.get("/api/v1/device-shares/activity", route, async (request) => {
    const { actor } = manager(request);
    return { activity: await relationships.workForResource(actor.accountId) };
  });
}
