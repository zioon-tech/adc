import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentGrantRecord, NodeRecord, Store } from "@adc/db";
import { createId, ProtocolError } from "@adc/protocol";
import { grantContext, type AccessService, type Principal } from "./access.ts";
import { principalUserId, type CollaborationAuthorization } from "./collaboration.ts";

export function registerAccountRoutes(
  app: FastifyInstance,
  options: {
    access: AccessService;
    store: Store;
    requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    requireAuthenticated: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    principal: (request: FastifyRequest) => Principal;
    collaboration?: CollaborationAuthorization;
    grantNodes?: (grant: AgentGrantRecord) => Promise<NodeRecord[]>;
    assertGrantManager?: (request: FastifyRequest, grant: AgentGrantRecord) => void;
  }
) {
  const { store, access, principal } = options;
  const identity = access.identity;
  const owner = { preHandler: options.requireSession };
  const ownGrant = async (request: FastifyRequest, grantId: string) => {
    const grant = await store.getGrant(grantId);
    if (!grant || grant.accountId !== principal(request).accountId || grant.revokedAt || grant.deletedAt)
      throw new ProtocolError("not_found", "Agent authorization was not found.", false);
    options.assertGrantManager?.(request, grant);
    return grant;
  };
  const grantsFor = async (request: FastifyRequest) => {
    const actor = principal(request);
    return (await store.listGrants(actor.accountId)).filter((grant) =>
      actor.kind === "agent" ? actor.grantId === grant.grantId
        : !actor.team || grant.responsibleUserId === principalUserId(actor));
  };
  const nodesFor = (grant: AgentGrantRecord) => options.grantNodes
    ? options.grantNodes(grant) : store.listNodes(grant.accountId);
  const audit = async (request: FastifyRequest, type: string, payload: Record<string, unknown>) => {
    await store.putAudit({
      eventId: createId("dsp"),
      accountId: principal(request).accountId,
      type,
      payload,
      createdAt: new Date().toISOString()
    });
  };
  app.get("/api/v1/me", { preHandler: options.requireAuthenticated }, async (request) => {
    const actor = principal(request);
    if (actor.kind === "session")
      return {
        kind: "session",
        user: actor.user,
        account: actor.account,
        personalAccountId: actor.personalAccountId ?? actor.accountId
      };
    if (actor.kind === "pat")
      return {
        kind: "pat",
        accountId: actor.accountId,
        patId: actor.patId,
        readOnly: actor.readOnly
      };
    const grant = await store.getGrant(actor.grantId);
    if (!grant || grant.accountId !== actor.accountId || grant.revokedAt) {
      throw new ProtocolError("denied", "Agent authorization is unavailable.", false);
    }
    return {
      kind: "agent",
      context: grantContext(grant, await nodesFor(grant)),
      grant
    };
  });
  app.get("/api/v1/grants", owner, async (request) => {
    return {
      grants: await Promise.all((await grantsFor(request)).map(async (grant) => ({
        ...grant,
        resourcesByNode: grantContext(grant, await nodesFor(grant)).resourcesByNode
      })))
    };
  });
  app.post("/api/v1/grants/:grantId/revoke", owner, async (request) => {
    const { grantId } = z.object({ grantId: z.string() }).parse(request.params);
    await ownGrant(request, grantId);
    if (!(await store.revokeGrant(principal(request).accountId, grantId, new Date()))) {
      throw new ProtocolError("not_found", "Agent authorization was not found.", false);
    }
    await audit(request, "grant.revoked", { grantId });
    return { revoked: true };
  });
  app.get("/api/v1/credentials", owner, async (request) => {
    const grants = new Set((await grantsFor(request)).map((grant) => grant.grantId));
    return { credentials: (await identity.listCredentials(principal(request).accountId))
      .filter((credential) => grants.has(credential.grantId)) };
  });
  app.post("/api/v1/credentials", owner, async (request) => {
    const body = z
      .object({
        name: z.string().min(1).max(128),
        grantId: z.string(),
        expiresInDays: z.number().int().min(1).max(365).default(30)
      })
      .strict()
      .parse(request.body);
    await ownGrant(request, body.grantId);
    const result = await identity.createCredential(
      principal(request).accountId,
      body.grantId,
      body.name,
      new Date(Date.now() + body.expiresInDays * 86400_000)
    );
    await audit(request, "credential.created", {
      credentialId: result.credential.credentialId,
      grantId: body.grantId
    });
    return result;
  });
  app.post("/api/v1/credentials/:credentialId/revoke", owner, async (request) => {
    const { credentialId } = z.object({ credentialId: z.string() }).parse(request.params);
    const credential = (await identity.listCredentials(principal(request).accountId)).find((entry) => entry.credentialId === credentialId);
    if (!credential) throw new ProtocolError("not_found", "Credential was not found.", false);
    await ownGrant(request, credential.grantId);
    if (!(await identity.revokeCredential(principal(request).accountId, credentialId))) {
      throw new ProtocolError("not_found", "Credential was not found.", false);
    }
    await audit(request, "credential.revoked", { credentialId });
    return { revoked: true };
  });

  // PAT management stays session-only: a token can never mint or retire tokens.
  const sessionOnly = (request: FastifyRequest) => {
    const actor = principal(request);
    if (actor.kind !== "session" || actor.team)
      throw new ProtocolError("denied", "PAT management requires a user session.", false);
    return actor;
  };

  app.get("/api/v1/pats", owner, async (request) => ({
    pats: await identity.listPats(sessionOnly(request).accountId)
  }));

  app.post("/api/v1/pats", owner, async (request) => {
    const actor = sessionOnly(request);
    const body = z
      .object({
        label: z.string().trim().min(1).max(128),
        readOnly: z.boolean().default(false),
        expiresInDays: z.number().int().min(1).max(365).optional()
      })
      .strict()
      .parse(request.body);
    const result = await identity.createPat(
      actor.accountId,
      body.label,
      body.readOnly,
      body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400_000) : null
    );
    await audit(request, "pat.created", {
      patId: result.pat.patId,
      label: body.label,
      readOnly: body.readOnly
    });
    return result;
  });

  app.post("/api/v1/pats/:patId/revoke", owner, async (request) => {
    const actor = sessionOnly(request);
    const { patId } = z.object({ patId: z.string() }).parse(request.params);
    if (!(await identity.revokePat(actor.accountId, patId))) {
      throw new ProtocolError("not_found", "Token was not found.", false);
    }
    await audit(request, "pat.revoked", { patId });
    return { revoked: true };
  });
  app.post("/api/v1/oauth/bindings", owner, async (request) => {
    const actor = principal(request);
    if (actor.kind !== "session")
      throw new ProtocolError("denied", "User session required.", false);
    const { clientId, grantId } = z
      .object({
        clientId: z.string().min(1).max(512),
        grantId: z.string()
      })
      .strict()
      .parse(request.body);
    await identity.bindOAuthClient(actor.user.id, actor.accountId, clientId, grantId);
    await audit(request, "oauth.bound", { clientId, grantId });
    return { bound: true };
  });
  app.get("/api/v1/oauth/bindings", owner, async (request) => {
    const grants = new Set((await grantsFor(request)).map((grant) => grant.grantId));
    return { bindings: (await identity.listOAuthBindings(principal(request).accountId))
      .filter((binding) => grants.has(binding.grantId)) };
  });
  app.post("/api/v1/oauth/bindings/revoke", owner, async (request) => {
    const actor = principal(request);
    if (actor.kind !== "session")
      throw new ProtocolError("denied", "User session required.", false);
    const { clientId } = z
      .object({ clientId: z.string().min(1).max(512) })
      .strict()
      .parse(request.body);
    const binding = (await identity.listOAuthBindings(actor.accountId, actor.user.id)).find((entry) => entry.clientId === clientId);
    if (!binding) throw new ProtocolError("not_found", "Connection was not found.", false);
    await ownGrant(request, binding.grantId);
    await identity.revokeOAuthBinding(actor.accountId, clientId, actor.user.id);
    await access.authentication.revokeOAuthTokens(actor.user.id, clientId);
    await audit(request, "oauth.revoked", { clientId });
    return { revoked: true };
  });
}
