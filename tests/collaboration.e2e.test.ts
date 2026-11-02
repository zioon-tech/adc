import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMemoryServer } from "postgres-memory-server";
import type { FastifyInstance } from "fastify";
import { CollaborationStore, IdentityStore, PostgresStore } from "../packages/db/src/index.ts";
import { createAuthentication } from "../apps/control-plane/src/auth.ts";
import { createAccessService } from "../apps/control-plane/src/access.ts";
import { createControlPlane } from "../apps/control-plane/src/app.ts";
import { NodeApiClient, generateNodeKeyPair } from "../packages/client/src/node.ts";
import { AdcClient, buildInvocation } from "../packages/client/src/index.ts";
import { runCollaborationCommand } from "../apps/cli/src/collaboration.ts";
import { LocalContentAddressedAssetStore } from "../apps/control-plane/src/asset-store.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilitySchema, type CollaborationScope, type NodePlatform } from "../packages/protocol/src/index.ts";
import { validateLocalDelegation } from "../apps/node/src/delegation.ts";
import { ToolRuntime } from "../packages/tool-runtime/src/runtime.ts";

const origin = "http://adc.test";
type User = { id: string; accountId: string; cookie: string; email: string };

describe("team membership and named device sharing through PostgreSQL and HTTP", () => {
  let postgres: PostgresMemoryServer;
  let store: PostgresStore;
  let app: FastifyInstance;
  let signupIp = 20;
  let assetDirectory: string;
  const injectedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const result = await app.inject({
      method: (init?.method ?? "GET") as any, url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers)),
      ...(typeof init?.body === "string" ? { payload: init.body } : {})
    });
    return new Response(result.body, { status: result.statusCode, headers: result.headers as Record<string, string> });
  }) as typeof fetch;
  const http = (user: User, url: string, payload?: object, accountId?: string, method?: "PATCH" | "DELETE") =>
    app.inject({
      method: method ?? (payload ? "POST" : "GET"), url,
      headers: { origin, cookie: user.cookie, ...(accountId ? { "x-adc-account": accountId } : {}) },
      ...(payload ? { payload } : {})
    });
  const ok = async (response: ReturnType<typeof http>) => {
    const result = await response;
    expect(result.statusCode, result.body).toBe(200);
    return result.json();
  };
  async function signup(verified = true): Promise<User> {
    const name = `person-${randomBytes(5).toString("hex")}`;
    const email = `${name}@example.test`;
    const response = await app.inject({
      method: "POST", url: "/api/auth/sign-up/email", remoteAddress: `127.0.0.${++signupIp}`,
      headers: { origin }, payload: { name, email, password: "correct horse ADC collaboration" }
    });
    expect(response.statusCode, response.body).toBe(200);
    const cookies = response.headers["set-cookie"];
    const cookie = (Array.isArray(cookies) ? cookies : [cookies]).filter(Boolean)
      .map((value) => value!.split(";")[0]).join("; ");
    const me = await app.inject({ url: "/api/v1/me", headers: { cookie } });
    const result = me.json();
    if (verified) await store.pool.query('UPDATE adc_auth_users SET "emailVerified" = true WHERE id = $1', [result.user.id]);
    return { id: result.user.id, accountId: result.account.accountId, cookie, email };
  }
  async function device(owner: User, accountId?: string, platform: NodePlatform = "linux") {
    const keys = generateNodeKeyPair();
    const code = (await ok(http(owner, "/api/v1/pairing-codes", {}, accountId))).code;
    const fetcher = injectedFetch;
    const api = new NodeApiClient(origin, undefined, keys.privateKey, fetcher);
    const pair = await api.pair({ code, label: `Device ${randomBytes(5).toString("hex")}`, platform, publicKey: keys.publicKey });
    const nodeApi = new NodeApiClient(origin, pair.nodeId, keys.privateKey, fetcher);
    const capability = CapabilitySchema.parse({
      schemaVersion: "0.1", nodeId: pair.nodeId, platform, nodeVersion: "0.1.5",
      roots: [
        { rootId: "root_shared", path: "/tmp/adc-shared-project", label: "Project", writable: true },
        { rootId: "root_private", path: "/tmp/adc-private-project", label: "Private", writable: true }
      ],
      tools: ["file.read", "file.write", "shell.exec"].map((name) => ({
        name, version: "0.1.0", risk: name === "file.read" ? "read" : name === "file.write" ? "write" : "execute",
        sandboxProfiles: ["restricted-process"]
      })),
      collaboration: { version: 1, trustedHost: false, isolation: "none" },
      advertisedAt: new Date().toISOString()
    });
    await nodeApi.poll(capability, { claim: false });
    return { nodeId: pair.nodeId, api: nodeApi, capability, keys };
  }
  const readScope = (): CollaborationScope => ({
    roots: [{ rootId: "root_shared", path: "/tmp/adc-shared-project", writable: false }],
    allowedTools: ["file.read", "device.list", "task.status", "task.result", "task.wait", "task.cancel"],
    execution: "read-only", approvalPolicy: "never", templateIds: []
  });
  const invite = (owner: User, nodeId: string, recipient: User, scope = readScope()) =>
    ok(http(owner, `/api/v1/nodes/${nodeId}/share-invitations`, { email: recipient.email, scope, durationDays: 30 }));
  const accept = (recipient: User, invitation: any) =>
    ok(http(recipient, `/api/v1/share-invitations/${invitation.invitation.invitationId}/accept`, {
      revision: invitation.invitation.revision, token: invitation.token
    }));
  async function grant(user: User, nodeId: string, bindingId: string, accountId?: string) {
    return ok(http(user, "/api/v1/grants", {
      name: "My Agent", profile: "read-only", nodeIds: [nodeId], rootIds: ["root_shared"],
      rootAccess: "selected", approvalPolicy: "never", allowedTools: readScope().allowedTools,
      resourceBindings: [{ nodeId, bindingId }]
    }, accountId));
  }
  const invocation = (g: any, nodeId: string) => buildInvocation({
    context: { accountId: g.accountId, grantId: g.grantId, actorId: g.actorId, rootIds: ["root_shared"] },
    target: { nodeId }, tool: "file.read", args: { rootId: "root_shared", path: "README.md" }, source: "sdk"
  });

  beforeAll(async () => {
    postgres = await PostgresMemoryServer.create({ database: "adc_collaboration", username: "adc_collaboration", password: "adc_collaboration" });
    store = new PostgresStore(postgres.getUri());
    const authentication = createAuthentication({ pool: store.pool, baseURL: origin, secret: randomBytes(48).toString("base64url") });
    assetDirectory = await mkdtemp(join(tmpdir(), "adc-collaboration-assets-"));
    app = await createControlPlane({ store, access: createAccessService(authentication, new IdentityStore(store.pool)), assetStore: new LocalContentAddressedAssetStore(assetDirectory) });
  }, 60_000);
  afterAll(async () => { await app?.close(); await postgres?.stop(); if (assetDirectory) await rm(assetDirectory, { recursive: true, force: true }); });

  it("binds acceptance to verified identity, scopes discovery and cancels leased work after revocation", async () => {
    const [owner, recipient, stranger, unverified] = await Promise.all([signup(), signup(), signup(), signup(false)]);
    const node = await device(owner);
    const sent = await invite(owner, node.nodeId, recipient);
    expect((await http(stranger, `/api/v1/share-invitations/${sent.invitation.invitationId}/accept`, { revision: 1, token: sent.token })).statusCode).toBe(404);
    expect((await http(unverified, `/api/v1/share-invitations/${sent.invitation.invitationId}/accept`, { revision: 1, token: sent.token })).statusCode).toBe(403);
    await ok(http(recipient, `/api/v1/share-invitations/${sent.invitation.invitationId}`));
    expect((await ok(http(recipient, "/api/v1/nodes"))).nodes).toEqual([]);
    const accepted = await accept(recipient, sent);
    const repeated = await accept(recipient, sent);
    expect(repeated.binding.bindingId).toBe(accepted.binding.bindingId);
    const discovered = (await ok(http(recipient, "/api/v1/nodes"))).nodes;
    expect(discovered).toHaveLength(1);
    expect(discovered[0].capability.roots.map((root: any) => root.rootId)).toEqual(["root_shared"]);
    expect(discovered[0].publicKey).toBeUndefined();
    expect((await ok(http(stranger, "/api/v1/nodes"))).nodes).toEqual([]);
    const g = await grant(recipient, node.nodeId, accepted.binding.bindingId);
    expect(g.responsibleUserId).toBe(recipient.id);
    const queued = await ok(http(recipient, "/api/v1/invocations", invocation(g, node.nodeId)));
    expect(queued.status).toBe("queued");
    const polled = await node.api.poll(node.capability);
    expect(polled.dispatch?.invocation.delegation).toMatchObject({
      requesterAccountId: recipient.accountId, requesterUserId: recipient.id,
      resourceAccountId: owner.accountId, bindingId: accepted.binding.bindingId
    });
    const dispatch = polled.dispatch!;
    await node.api.acknowledge(dispatch.dispatchId, dispatch.leaseToken);
    await ok(http(owner, `/api/v1/device-shares/${accepted.binding.bindingId}/revoke`, { revision: 1 }));
    const renewal = await node.api.renewLease(dispatch.dispatchId, dispatch.leaseToken);
    expect(renewal.cancelRequested).toBe(true);
    expect((await ok(http(recipient, "/api/v1/nodes"))).nodes).toEqual([]);
    const denied = await ok(http(recipient, "/api/v1/invocations", invocation(g, node.nodeId)));
    expect(denied.status).toBe("denied");
    expect((await http(stranger, `/api/v1/tasks/${queued.jobId}`)).statusCode).not.toBe(200);
  });

  it("selects teams using membership, applies per-member policy and prevents borrowing another member's grant", async () => {
    const [owner, member, stranger] = await Promise.all([signup(), signup(), signup()]);
    const team = await ok(http(owner, "/api/v1/teams", { name: "Team" }));
    const invitation = await ok(http(owner, `/api/v1/teams/${team.accountId}/invitations`, { email: member.email, role: "member" }));
    const joined = await accept(member, invitation);
    expect((await http(stranger, "/api/v1/me", undefined, team.accountId)).statusCode).toBe(403);
    const me = await ok(http(member, "/api/v1/me", undefined, team.accountId));
    expect(me.account.accountId).toBe(team.accountId);
    expect(me.user.id).toBe(member.id);
    expect((await http(member, "/api/v1/pairing-codes", {}, team.accountId)).statusCode).toBe(403);
    const node = await device(owner);
    const link = await ok(http(owner, `/api/v1/teams/${team.accountId}/devices`, { nodeId: node.nodeId, scope: readScope() }));
    expect((await ok(http(member, "/api/v1/nodes", undefined, team.accountId))).nodes).toEqual([]);
    await ok(http(owner, `/api/v1/teams/${team.accountId}/members/${member.id}`, {
      revision: joined.membership.revision, role: "member", state: "active", rules: [{ nodeId: node.nodeId, scope: readScope() }]
    }, team.accountId, "PATCH"));
    const g = await grant(member, node.nodeId, link.bindingId, team.accountId);
    const secret = await ok(http(member, "/api/v1/credentials", { name: "Member CLI", grantId: g.grantId }, team.accountId));
    expect((await http(owner, "/api/v1/credentials", { name: "Stolen", grantId: g.grantId }, team.accountId)).statusCode).toBe(403);
    expect((await ok(http(owner, "/api/v1/grants", undefined, team.accountId))).grants).toEqual([]);
    const members = (await ok(http(owner, `/api/v1/teams/${team.accountId}/members`, undefined, team.accountId))).members;
    const current = members.find((entry: any) => entry.userId === member.id);
    await ok(http(owner, `/api/v1/teams/${team.accountId}/members/${member.id}`, {
      revision: current.revision, role: "member", state: "removed", rules: []
    }, team.accountId, "PATCH"));
    const agentMe = await app.inject({ url: "/api/v1/me", headers: { authorization: `Bearer ${secret.token}` } });
    expect(agentMe.statusCode).toBe(401);
    expect((await http(member, "/api/v1/me", undefined, team.accountId)).statusCode).toBe(403);
    const reInvite = await ok(http(owner, `/api/v1/teams/${team.accountId}/invitations`, { email: member.email }));
    await accept(member, reInvite);
    expect((await app.inject({ url: "/api/v1/me", headers: { authorization: `Bearer ${secret.token}` } })).statusCode).toBe(401);
    expect((await store.getNode(node.nodeId))!.accountId).toBe(owner.accountId);
  });

  it("requires acceptance of expanded scope and keeps existing Agent permissions fixed", async () => {
    const [owner, recipient] = await Promise.all([signup(), signup()]);
    const node = await device(owner);
    const original = await accept(recipient, await invite(owner, node.nodeId, recipient));
    const g = await grant(recipient, node.nodeId, original.binding.bindingId);
    const expanded = {
      ...readScope(),
      roots: [...readScope().roots, { rootId: "root_private", path: "/tmp/adc-private-project", writable: false }]
    };
    const proposed = await ok(http(owner, `/api/v1/device-shares/${original.binding.bindingId}`, {
      revision: 1, scope: expanded
    }, undefined, "PATCH"));
    expect(proposed.pending).toBe(true);
    expect((await ok(http(recipient, "/api/v1/nodes"))).nodes[0].capability.roots).toHaveLength(1);
    await accept(recipient, proposed);
    expect((await store.pool.query("SELECT record FROM adc_resource_bindings WHERE binding_id = $1", [original.binding.bindingId])).rows[0].record.expiresAt)
      .toBe(original.binding.expiresAt);
    expect((await ok(http(recipient, "/api/v1/nodes"))).nodes[0].capability.roots).toHaveLength(2);
    const context = await store.getGrant(g.grantId);
    expect(context!.resourceBindings![0]!.scope!.roots).toHaveLength(1);
    const forged = { ...invocation(g, node.nodeId), delegation: { version: 1 } };
    expect((await http(recipient, "/api/v1/invocations", forged)).statusCode).not.toBe(200);
    const unsafe = { ...readScope(), roots: readScope().roots.map((root) => ({ ...root, writable: true })) };
    expect((await http(owner, `/api/v1/nodes/${node.nodeId}/share-invitations`, { email: recipient.email, scope: unsafe })).statusCode).toBe(403);
  });

  it("requires independent requester and resource consents, withholds dispatch and redacts resource results", async () => {
    const [owner, recipient, stranger] = await Promise.all([signup(), signup(), signup()]);
    const node = await device(owner);
    const shared = await accept(recipient, await invite(owner, node.nodeId, recipient, {
      ...readScope(), approvalPolicy: "always"
    }));
    const g = await ok(http(recipient, "/api/v1/grants", {
      name: "Consented Agent", profile: "read-only", nodeIds: [node.nodeId],
      rootIds: ["root_shared"], rootAccess: "selected", approvalPolicy: "always",
      allowedTools: readScope().allowedTools, resourceBindings: [{ nodeId: node.nodeId, bindingId: shared.binding.bindingId }]
    }));
    const pending = await ok(http(recipient, "/api/v1/invocations", invocation(g, node.nodeId)));
    expect(pending.status).toBe("approval_required");
    const approvalId = pending.error.details.approvalId;
    const ownerQueue = await ok(http(owner, "/api/v1/approvals"));
    const ownerView = ownerQueue.approvals.find((entry: any) => entry.approvalId === approvalId);
    expect(ownerView.requiredConsents).toHaveLength(2);
    expect(ownerView.invocation.authorization).toBeUndefined();
    expect(ownerView.invocation.actor).toBeUndefined();
    expect((await http(stranger, `/api/v1/approvals/${approvalId}`, { decision: "approved" })).statusCode).toBe(404);
    const first = await ok(http(recipient, `/api/v1/approvals/${approvalId}`, { decision: "approved" }));
    expect(first.awaitingConsent).toBe(true);
    expect((await node.api.poll(node.capability)).dispatch).toBeFalsy();
    const consented = await ok(http(owner, `/api/v1/approvals/${approvalId}`, { decision: "approved" }));
    expect(consented.status).toBe("queued");
    const dispatched = (await node.api.poll(node.capability)).dispatch!;
    expect(dispatched.invocation.delegation?.requesterUserId).toBe(recipient.id);
    await store.pool.query(
      "UPDATE adc_dispatches SET status = 'succeeded', result = $2 WHERE dispatch_id = $1",
      [dispatched.dispatchId, { schemaVersion: "0.1", invocationId: dispatched.invocation.invocationId,
        attemptId: dispatched.invocation.attemptId, status: "succeeded", output: { secret: "requester-only-output" } }]
    );
    const repeated = await ok(http(owner, `/api/v1/approvals/${approvalId}`, { decision: "approved" }));
    expect(JSON.stringify(repeated)).not.toContain("requester-only-output");
    await ok(http(owner, `/api/v1/device-shares/${shared.binding.bindingId}/revoke`, { revision: 1 }));
    const revokedRetry = await ok(http(recipient, `/api/v1/approvals/${approvalId}`, { decision: "approved" }));
    expect(revokedRetry.status).toBe("denied");
    expect(JSON.stringify(revokedRetry)).not.toContain("requester-only-output");
    const activity = await ok(http(owner, "/api/v1/device-shares/activity"));
    expect(JSON.stringify(activity)).not.toContain("requester-only-output");
    expect(activity.activity[0].receipt).toBeUndefined();
  });

  it("serializes simultaneous consents and revocation without duplicate or stale dispatch", async () => {
    const [owner, recipient] = await Promise.all([signup(), signup()]);
    const node = await device(owner);
    const shared = await accept(recipient, await invite(owner, node.nodeId, recipient, { ...readScope(), approvalPolicy: "always" }));
    const g = await grant(recipient, node.nodeId, shared.binding.bindingId);
    const pending = await ok(http(recipient, "/api/v1/invocations", invocation(g, node.nodeId)));
    const approvalId = pending.error.details.approvalId;
    // Resource consent is the sole required consent here; simultaneous retries enqueue once.
    const results = await Promise.all([
      http(owner, `/api/v1/approvals/${approvalId}`, { decision: "approved" }),
      http(owner, `/api/v1/approvals/${approvalId}`, { decision: "approved" }),
      http(owner, `/api/v1/device-shares/${shared.binding.bindingId}/revoke`, { revision: 1 })
    ]);
    expect(results[2]!.statusCode, results[2]!.body).toBe(200);
    expect((await node.api.poll(node.capability)).dispatch).toBeFalsy();
    const count = await store.pool.query("SELECT count(*)::int AS n FROM adc_dispatches WHERE invocation_id = $1", [pending.invocationId]);
    expect(count.rows[0].n).toBeLessThanOrEqual(1);
    expect((await store.getApproval(approvalId))!.status).not.toBe("pending");
  });

  it("excludes platform resources independently of device labels and rejects stale scope proposals", async () => {
    const [owner, recipient] = await Promise.all([signup(), signup()]);
    const node = await device(owner);
    const classified = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/classify-node.ts", node.nodeId, "platform", `--confirm=${node.nodeId}`],
        { env: { ...process.env, DATABASE_URL: postgres.getUri() }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = ""; child.stderr.on("data", part => { stderr += String(part); });
      child.on("error", reject); child.on("close", code => resolve({ code, stderr }));
    });
    expect(classified.code, classified.stderr).toBe(0);
    expect((await store.getNode(node.nodeId))!.resourceClass).toBe("platform");
    expect((await http(owner, `/api/v1/nodes/${node.nodeId}/share-invitations`, {
      email: recipient.email, scope: readScope()
    })).statusCode).toBe(403);
    await store.pool.query("UPDATE adc_nodes SET resource_class = 'physical' WHERE node_id = $1", [node.nodeId]);
    const original = await accept(recipient, await invite(owner, node.nodeId, recipient));
    const proposed = await ok(http(owner, `/api/v1/device-shares/${original.binding.bindingId}`, {
      revision: 1, scope: { ...readScope(), roots: [
        ...readScope().roots, { rootId: "root_private", path: "/tmp/adc-private-project", writable: false }
      ] }
    }, undefined, "PATCH"));
    await store.pool.query(
      "UPDATE adc_resource_bindings SET record = jsonb_set(record, '{expiresAt}', to_jsonb($2::text)) WHERE binding_id = $1",
      [original.binding.bindingId, new Date(Date.now() - 1_000).toISOString()]
    );
    expect((await http(recipient, `/api/v1/share-invitations/${proposed.invitation.invitationId}/accept`, {
      revision: 1, token: proposed.token
    })).statusCode).toBe(409);
    expect((await ok(http(recipient, "/api/v1/nodes"))).nodes).toEqual([]);
  });

  it("uses SDK and CLI collaboration commands with the same identity and exact resource binding", async () => {
    const [owner, recipient] = await Promise.all([signup(), signup()]);
    const ownerClient = new AdcClient(origin, { cookie: owner.cookie }, injectedFetch);
    const recipientClient = new AdcClient(origin, { cookie: recipient.cookie }, injectedFetch);
    const created = await runCollaborationCommand({ domain: "team", action: "create", positionals: ["team", "create"], flags: new Map([["name", "SDK Team"]]), client: ownerClient });
    const teamId = (created.value as { accountId: string }).accountId;
    const sent = await ownerClient.inviteTeamMember(teamId, recipient.email);
    await recipientClient.respondInvitation(sent.invitation.invitationId, 1, "accept", sent.token);
    expect((await recipientClient.withAccount(teamId).accounts()).selectedAccountId).toBe(teamId);
    const node = await device(owner);
    const linked = await ownerClient.linkTeamDevice(teamId, { nodeId: node.nodeId, scope: readScope() });
    const teamClient = ownerClient.withAccount(teamId);
    const administrative = await teamClient.teamDevices(teamId);
    expect(administrative[0]!.capability!.roots).toHaveLength(1);
    expect(JSON.stringify(administrative)).not.toContain("/tmp/adc-private-project");
    expect((await http(recipient, `/api/v1/teams/${teamId}/devices`, undefined, teamId)).statusCode).toBe(403);
    const member = (await teamClient.teamMembers(teamId)).find(entry => entry.userId === recipient.id)!;
    const policy = join(assetDirectory, "member-policy.json");
    await writeFile(policy, JSON.stringify({ rules: [{ nodeId: node.nodeId, scope: readScope() }] }));
    await runCollaborationCommand({ domain: "team", action: "member-update", positionals: ["team", "member-update", teamId, recipient.id], flags: new Map([["file", policy]]), client: teamClient });
    const access = await recipientClient.withAccount(teamId).createAccess({
      name: "Team SDK Agent", profile: "read-only", nodeIds: [node.nodeId], rootAccess: "selected", rootIds: ["root_shared"],
      allowedTools: readScope().allowedTools, resourceBindings: [{ nodeId: node.nodeId, bindingId: linked.bindingId }]
    });
    expect(access.accountId).toBe(teamId);
    const shares = await teamClient.deviceShares();
    expect(shares[0]!.scope.roots).toHaveLength(1);
    const invited = await ownerClient.inviteDeviceShare(node.nodeId, { email: recipient.email, scope: readScope() });
    const preview = await recipientClient.invitation(invited.invitation.invitationId, invited.token);
    expect(preview.nodeLabel).toBeDefined();
    await recipientClient.respondInvitation(preview.invitationId, preview.revision, "decline", invited.token);
    expect((await recipientClient.invitations()).find(entry => entry.invitationId === preview.invitationId)!.state).toBe("declined");
  });

  it("intersects multi-device grants independently and prevents cross-member history and task access", async () => {
    const [owner, member, other] = await Promise.all([signup(), signup(), signup()]);
    const team = await ok(http(owner, "/api/v1/teams", { name: "History Team" }));
    for (const recipient of [member, other]) await accept(recipient, await ok(http(owner, `/api/v1/teams/${team.accountId}/invitations`, { email: recipient.email })));
    const [first, second] = await Promise.all([device(owner), device(owner)]);
    const links = await Promise.all([first, second].map(node => ok(http(owner, `/api/v1/teams/${team.accountId}/devices`, { nodeId: node.nodeId, scope: readScope() }))));
    const members = (await ok(http(owner, `/api/v1/teams/${team.accountId}/members`))).members;
    for (const recipient of [member, other]) {
      const current = members.find((entry: any) => entry.userId === recipient.id);
      await ok(http(owner, `/api/v1/teams/${team.accountId}/members/${recipient.id}`, {
        revision: current.revision, role: "member", state: "active",
        rules: [{ nodeId: first.nodeId, scope: readScope() }, { nodeId: second.nodeId, scope: { ...readScope(), roots: [] } }]
      }, team.accountId, "PATCH"));
    }
    const g = await ok(http(member, "/api/v1/grants", {
      name: "Independent device scopes", profile: "read-only", nodeIds: [first.nodeId, second.nodeId],
      rootAccess: "selected", rootIds: ["root_shared"], allowedTools: readScope().allowedTools,
      resourceBindings: links.map((binding: any) => ({ nodeId: binding.nodeId, bindingId: binding.bindingId }))
    }, team.accountId));
    const request = invocation(g, first.nodeId);
    request.idempotencyKey = `stable-read-${randomBytes(8).toString("hex")}`;
    const pending = await ok(http(member, "/api/v1/invocations", request, team.accountId));
    expect(pending.status).toBe("queued");
    expect((await http(other, `/api/v1/tasks/${pending.jobId}`, undefined, team.accountId)).statusCode).toBe(404);
    expect((await http(owner, `/api/v1/invocations/${pending.invocationId}`, undefined, team.accountId)).statusCode).toBe(404);
    expect((await http(other, `/api/v1/tasks/${pending.jobId}/cancel`, {}, team.accountId)).statusCode).toBe(404);
    expect((await ok(http(member, "/api/v1/invocations", invocation(g, second.nodeId), team.accountId))).status).toBe("denied");
    const duplicate = await ok(http(member, "/api/v1/invocations", request, team.accountId));
    expect(duplicate.jobId).toBe(pending.jobId);
    const count = await store.pool.query("SELECT count(*)::int AS n FROM adc_dispatches WHERE invocation_id=$1", [pending.invocationId]);
    expect(count.rows[0].n).toBe(1);
    const freshRetry = invocation(g, first.nodeId);
    freshRetry.idempotencyKey = request.idempotencyKey;
    freshRetry.issuedAt = new Date(Date.parse(request.issuedAt) + 1000).toISOString();
    freshRetry.expiresAt = new Date(Date.parse(request.expiresAt) + 1000).toISOString();
    expect((await ok(http(member, "/api/v1/invocations", freshRetry, team.accountId))).jobId).toBe(pending.jobId);
    const latest = (await ok(http(owner, `/api/v1/teams/${team.accountId}/members`))).members.find((entry: any) => entry.userId === member.id);
    const edits = await Promise.all([
      http(owner, `/api/v1/teams/${team.accountId}/members/${member.id}`, { revision: latest.revision, role: "member", state: "active", rules: [] }, team.accountId, "PATCH"),
      http(owner, `/api/v1/teams/${team.accountId}/members/${member.id}`, { revision: latest.revision, role: "member", state: "active", rules: [] }, team.accountId, "PATCH")
    ]);
    expect(edits.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect((await ok(http(member, `/api/v1/tasks/${pending.jobId}`, undefined, team.accountId))).status).toBe("denied");
    expect((await first.api.poll(first.capability)).dispatch).toBeFalsy();
  });

  it("keeps directly team-owned isolated policy and rootless template discovery usable, with private requester approvals", async () => {
    const [owner, member] = await Promise.all([signup(), signup()]);
    const team = await ok(http(owner, "/api/v1/teams", { name: "Team-owned isolation" }));
    const joined = await accept(member, await ok(http(owner, `/api/v1/teams/${team.accountId}/invitations`, { email: member.email })));
    const node = await device(owner, team.accountId);
    const isolated = CapabilitySchema.parse({ ...node.capability,
      collaboration: { version: 1, trustedHost: false, isolation: "container" },
      tools: [...node.capability.tools, { name: "command.template.list", version: "0.1.0", risk: "read", sandboxProfiles: ["restricted-process"] }]
    });
    await node.api.poll(isolated, { claim: false });
    const scope: CollaborationScope = { ...readScope(), roots: readScope().roots.map(root => ({ ...root, writable: true })),
      execution: "isolated", allowedTools: ["file.read", "file.write", "shell.exec", "command.template.list", "device.list", "task.wait"], approvalPolicy: "never" };
    await ok(http(owner, `/api/v1/teams/${team.accountId}/members/${member.id}`, { revision: joined.membership.revision, role: "member", state: "active", rules: [{ nodeId: node.nodeId, scope }] }, team.accountId, "PATCH"));
    const projected = (await ok(http(member, "/api/v1/nodes", undefined, team.accountId))).nodes[0];
    expect(projected.resourceAuthorization.scope.execution).toBe("isolated");
    const g = await ok(http(member, "/api/v1/grants", { name: "Team isolated", profile: "workspace-write", nodeIds: [node.nodeId],
      rootAccess: "selected", rootIds: ["root_shared"], allowedTools: scope.allowedTools, approvalPolicy: "never" }, team.accountId));
    const templateList = buildInvocation({ context: { accountId: g.accountId, grantId: g.grantId, actorId: g.actorId, rootIds: ["root_shared"] },
      target: { nodeId: node.nodeId }, tool: "command.template.list", args: {}, source: "sdk" });
    expect((await ok(http(member, "/api/v1/invocations", templateList, team.accountId))).status).toBe("queued");
    const approveGrant = await ok(http(member, `/api/v1/grants/${g.grantId}`, { revision: g.revision,
      name: g.name, profile: g.profile, nodeIds: g.nodeIds, rootAccess: g.rootAccess, rootIds: g.rootIds, allowedTools: g.allowedTools, approvalPolicy: "always" }, team.accountId, "PATCH"));
    const write = buildInvocation({ context: { accountId: g.accountId, grantId: g.grantId, actorId: g.actorId, rootIds: ["root_shared"] },
      target: { nodeId: node.nodeId }, tool: "file.write", args: { rootId: "root_shared", path: "private.txt", content: "PRIVATE_MEMBER_APPROVAL_BODY" },
      idempotencyKey: `write-${randomBytes(8).toString("hex")}`, source: "sdk" });
    expect(approveGrant.approvalPolicy).toBe("always");
    const pending = await ok(http(member, "/api/v1/invocations", write, team.accountId));
    expect(pending.status).toBe("approval_required");
    expect(JSON.stringify(await ok(http(owner, "/api/v1/approvals", undefined, team.accountId)))).not.toContain("PRIVATE_MEMBER_APPROVAL_BODY");
    expect(JSON.stringify(await ok(http(member, "/api/v1/approvals", undefined, team.accountId)))).toContain("PRIVATE_MEMBER_APPROVAL_BODY");
  });

  it("rechecks current resource administrators under PostgreSQL locks and prevents demoted team binding expansion", async () => {
    const [owner, admin, recipient] = await Promise.all([signup(), signup(), signup()]);
    const team = await ok(http(owner, "/api/v1/teams", { name: "Consent administration" }));
    const joined = await accept(admin, await ok(http(owner, `/api/v1/teams/${team.accountId}/invitations`, { email: admin.email, role: "admin" })));
    const node = await device(owner, team.accountId);
    const shared = await accept(recipient, await ok(http(owner, `/api/v1/nodes/${node.nodeId}/share-invitations`, { email: recipient.email, scope: { ...readScope(), approvalPolicy: "always" } }, team.accountId)));
    const g = await grant(recipient, node.nodeId, shared.binding.bindingId);
    const pending = await ok(http(recipient, "/api/v1/invocations", invocation(g, node.nodeId)));
    const approvalId = pending.error.details.approvalId;
    const relationships = new CollaborationStore(store.pool);
    await relationships.changeMember(team.accountId, owner.id, admin.id, joined.membership.revision, { role: "member", state: "active", rules: [] });
    await expect(relationships.consentApproval(approvalId, team.accountId, admin.id)).rejects.toMatchObject({ code: "denied" });
    expect((await store.getApproval(approvalId))!.consents).toEqual([]);
    const personal = await device(admin);
    // Restore administration solely to establish the initial team use relation.
    const demoted = await relationships.member(team.accountId, admin.id);
    await relationships.changeMember(team.accountId, owner.id, admin.id, demoted!.revision, { role: "admin", state: "active", rules: [] });
    const linked = await ok(http(admin, `/api/v1/teams/${team.accountId}/devices`, { nodeId: personal.nodeId, scope: readScope() }));
    const elevated = await relationships.member(team.accountId, admin.id);
    await relationships.changeMember(team.accountId, owner.id, admin.id, elevated!.revision, { role: "member", state: "active", rules: [] });
    await expect(relationships.changeBinding(admin.accountId, admin.id, linked.bindingId, 1, {
      scope: { ...readScope(), roots: [...readScope().roots, { rootId: "root_private", path: "/tmp/adc-private-project", writable: false }] }
    }, false, true)).rejects.toMatchObject({ code: "denied" });
    expect((await relationships.getBinding(linked.bindingId))!.scope.roots).toHaveLength(1);
  });

  it("preserves fixed unavailable grant scope on metadata edits and revokes each member's own OAuth binding", async () => {
    const [owner, member, other] = await Promise.all([signup(), signup(), signup()]);
    const node = await device(owner);
    const own = await ok(http(owner, "/api/v1/grants", { name: "Keep unavailable", profile: "read-only", nodeIds: [node.nodeId],
      rootAccess: "selected", rootIds: ["root_shared"], allowedTools: readScope().allowedTools, approvalPolicy: "never" }));
    await node.api.poll({ ...node.capability, roots: node.capability.roots.filter(root => root.rootId !== "root_shared") }, { claim: false });
    const updated = await ok(http(owner, `/api/v1/grants/${own.grantId}`, { revision: own.revision, name: "Renamed fixed grant",
      profile: own.profile, nodeIds: own.nodeIds, rootAccess: own.rootAccess, rootIds: own.rootIds, allowedTools: own.allowedTools, approvalPolicy: own.approvalPolicy }, undefined, "PATCH"));
    expect(updated.rootIds).toEqual(["root_shared"]);
    await node.api.poll(node.capability, { claim: false });
    const team = await ok(http(owner, "/api/v1/teams", { name: "OAuth members" }));
    const linked = await ok(http(owner, `/api/v1/teams/${team.accountId}/devices`, { nodeId: node.nodeId, scope: readScope() }));
    const grants = [];
    for (const recipient of [member, other]) {
      const joined = await accept(recipient, await ok(http(owner, `/api/v1/teams/${team.accountId}/invitations`, { email: recipient.email })));
      await ok(http(owner, `/api/v1/teams/${team.accountId}/members/${recipient.id}`, { revision: joined.membership.revision, role: "member", state: "active", rules: [{ nodeId: node.nodeId, scope: readScope() }] }, team.accountId, "PATCH"));
      const access = await grant(recipient, node.nodeId, linked.bindingId, team.accountId); grants.push(access);
      await ok(http(recipient, "/api/v1/oauth/bindings", { clientId: "same-client", grantId: access.grantId }, team.accountId));
    }
    await ok(http(member, "/api/v1/oauth/bindings/revoke", { clientId: "same-client" }, team.accountId));
    const identity = new IdentityStore(store.pool);
    expect((await identity.listOAuthBindings(team.accountId, member.id))[0]!.revokedAt).toBeTruthy();
    expect((await identity.listOAuthBindings(team.accountId, other.id))[0]!.revokedAt).toBeNull();
  });

  it("shares an explicitly exposed device root with a team and keeps Node, member and Agent limits", async () => {
    const [owner, member, stranger] = await Promise.all([signup(), signup(), signup()]);
    const team = await ok(http(owner, "/api/v1/teams", { name: "Root access team" }));
    const joined = await accept(member, await ok(http(owner, `/api/v1/teams/${team.accountId}/invitations`, { email: member.email })));
    const node = await device(owner);
    const root = { rootId: "root_device", path: "/", label: "Device root", writable: true };
    const oldCapability = CapabilitySchema.parse({ ...node.capability, roots: [root] });
    await node.api.poll(oldCapability, { claim: false });
    const scope: CollaborationScope = { ...readScope(), roots: [{ rootId: root.rootId, path: root.path, writable: false }] };
    const outdated = await http(owner, `/api/v1/teams/${team.accountId}/devices`, { nodeId: node.nodeId, scope });
    expect(outdated.statusCode).toBe(403);
    expect(outdated.json().error.message).toContain("0.1.6");
    const capability = CapabilitySchema.parse({ ...oldCapability, nodeVersion: "0.1.6",
      collaboration: { version: 1, trustedHost: false, isolation: "none", features: ["team-root-sharing"] } });
    await node.api.poll(capability, { claim: false });
    const linked = await ok(http(owner, `/api/v1/teams/${team.accountId}/devices`, { nodeId: node.nodeId, scope }));
    expect((await store.getNode(node.nodeId))!.accountId).toBe(owner.accountId);
    expect((await ok(http(member, "/api/v1/nodes", undefined, team.accountId))).nodes).toEqual([]);
    await ok(http(owner, `/api/v1/teams/${team.accountId}/members/${member.id}`, {
      revision: joined.membership.revision, role: "member", state: "active", rules: [{ nodeId: node.nodeId, scope }]
    }, team.accountId, "PATCH"));
    const g = await ok(http(member, "/api/v1/grants", { name: "Root reader", profile: "read-only",
      nodeIds: [node.nodeId], rootAccess: "selected", rootIds: ["root_device"], allowedTools: scope.allowedTools,
      resourceBindings: [{ nodeId: node.nodeId, bindingId: linked.bindingId }] }, team.accountId));
    const localFile = join(assetDirectory, "team-root-input.txt");
    await writeFile(localFile, "allowed-root-read");
    const request = buildInvocation({ context: { accountId: g.accountId, grantId: g.grantId, actorId: g.actorId, rootIds: ["root_device"] },
      target: { nodeId: node.nodeId }, tool: "file.read", args: { rootId: "root_device", path: localFile.slice(1) }, source: "sdk" });
    const queued = await ok(http(member, "/api/v1/invocations", request, team.accountId));
    expect(queued.status).toBe("queued");
    const dispatch = (await node.api.poll(capability)).dispatch!;
    expect(dispatch.invocation.delegation!.bindingKind).toBe("team");
    const sharing = { enabled: true, trustedHost: false, isolation: "none" as const };
    const scoped = await validateLocalDelegation(dispatch.invocation, owner.accountId, node.nodeId, [root], sharing, false);
    const runtime = new ToolRuntime({ nodeId: node.nodeId, roots: scoped, stateDirectory: join(assetDirectory, "root-runtime"), protectSensitivePaths: true });
    const result = await runtime.execute(dispatch.invocation, dispatch.policyDecision);
    expect(result.status).toBe("succeeded");
    expect(JSON.stringify(result.output)).toContain("allowed-root-read");
    await expect(validateLocalDelegation({ ...dispatch.invocation, args: { rootId: "root_device", path: "root/.ssh/id_ed25519" } },
      owner.accountId, node.nodeId, [root], sharing, false)).rejects.toMatchObject({ code: "denied" });
    const { bindingKind: _team, ...external } = dispatch.invocation.delegation!;
    await expect(validateLocalDelegation({ ...dispatch.invocation, delegation: external }, owner.accountId, node.nodeId, [root], sharing, false))
      .rejects.toMatchObject({ code: "denied" });
    const externalInvite = await http(owner, `/api/v1/nodes/${node.nodeId}/share-invitations`, { email: stranger.email, scope });
    expect(externalInvite.statusCode).toBe(403);
    const isolated = await http(owner, `/api/v1/teams/${team.accountId}/devices`, { nodeId: node.nodeId, scope: { ...scope, execution: "isolated" } });
    expect(isolated.statusCode).toBe(403);
    await ok(http(owner, `/api/v1/device-shares/${linked.bindingId}/revoke`, { revision: 1 }));
    expect((await ok(http(member, "/api/v1/invocations", request, team.accountId))).status).toBe("denied");
  });

  it("shares a Windows drive root through its exact locally advertised path", async () => {
    const owner = await signup();
    const team = await ok(http(owner, "/api/v1/teams", { name: "Windows root team" }));
    const node = await device(owner, undefined, "win32");
    const capability = CapabilitySchema.parse({ ...node.capability, nodeVersion: "0.1.6",
      roots: [{ rootId: "root_device", label: "System drive", writable: true }],
      collaboration: { version: 1, trustedHost: false, isolation: "none", features: ["team-root-sharing"],
        roots: [{ rootId: "root_device", path: "C:\\" }] } });
    await node.api.poll(capability, { claim: false });
    const scope: CollaborationScope = { ...readScope(), roots: [{ rootId: "root_device", path: "C:\\", writable: false }] };
    const linked = await ok(http(owner, `/api/v1/teams/${team.accountId}/devices`, { nodeId: node.nodeId, scope }));
    expect(linked.scope.roots[0].path).toBe("C:\\");
    const forged = await http(owner, `/api/v1/teams/${team.accountId}/devices`, {
      nodeId: node.nodeId, scope: { ...scope, roots: [{ rootId: "root_device", path: "D:\\", writable: false }] }
    });
    expect(forged.statusCode).toBe(403);
  });

  it.runIf(!!process.env.ADC_REAL_NODE_SSH)("runs a real Linux Connector through HTTP and PostgreSQL and tears down revoked guest work", async () => {
    const [owner, recipient] = await Promise.all([signup(), signup()]);
    const node = await device(owner);
    const address = new URL(await app.listen({ port: 0, host: "127.0.0.1" }));
    const directory = `/tmp/adc-real-node-${randomBytes(8).toString("hex")}`;
    const nodeBinary = "/tmp/adc-collaboration-20261031/node-v24.21.0-linux-x64/bin/node";
    const remote = "/tmp/adc-collaboration-20261031";
    const ssh = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ExitOnForwardFailure=yes",
      "-R", `127.0.0.1:${address.port}:127.0.0.1:${address.port}`, process.env.ADC_REAL_NODE_SSH!, `${nodeBinary} ${remote}/real-node.mjs`], { stdio: ["pipe", "pipe", "pipe"] });
    const responses: Array<any> = [];
    const waiting: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }> = [];
    const lines = createInterface({ input: ssh.stdout });
    let stderr = "";
    ssh.stderr.on("data", part => { if (stderr.length < 4000) stderr += String(part); });
    lines.on("line", line => {
      const result = JSON.parse(line);
      const next = waiting.shift();
      if (next) next.resolve(result); else responses.push(result);
    });
    ssh.on("exit", code => { for (const next of waiting.splice(0)) next.reject(new Error(`Linux fixture exited ${code}: ${stderr}`)); });
    const receive = () => responses.length ? Promise.resolve(responses.shift()) : new Promise<any>((resolve, reject) => waiting.push({ resolve, reject }));
    const send = (value: object) => ssh.stdin.write(`${JSON.stringify(value)}\n`);
    try {
      send({ action: "init", origin: `http://127.0.0.1:${address.port}`, nodeId: node.nodeId, accountId: owner.accountId,
        privateKey: node.keys.privateKey, directory, image: process.env.ADC_ISOLATION_IMAGE, workerBundle: `${remote}/collaboration-worker.mjs` });
      expect((await receive()).event).toBe("ready");
      const scope: CollaborationScope = { roots: [{ rootId: "root_shared", path: `${directory}/project`, writable: true }],
        allowedTools: ["file.read", "shell.exec", "device.list", "task.result", "task.status", "task.wait", "task.cancel"],
        execution: "isolated", approvalPolicy: "never", templateIds: [] };
      const shared = await accept(recipient, await invite(owner, node.nodeId, recipient, scope));
      const g = await ok(http(recipient, "/api/v1/grants", {
        name: "Real isolated Agent", profile: "workspace-write", nodeIds: [node.nodeId], rootAccess: "selected", rootIds: ["root_shared"],
        allowedTools: scope.allowedTools, resourceBindings: [{ nodeId: node.nodeId, bindingId: shared.binding.bindingId }]
      }));
      const make = (command: string) => buildInvocation({
        context: { accountId: g.accountId, grantId: g.grantId, actorId: g.actorId, rootIds: ["root_shared"] },
        target: { nodeId: node.nodeId }, tool: "shell.exec", args: { rootId: "root_shared", cwd: "", command, timeoutMs: 20_000 },
        idempotencyKey: `real-node-${randomBytes(8).toString("hex")}`, source: "sdk"
      });
      const first = await ok(http(recipient, "/api/v1/invocations", make("printf guest-only > README.md && test \"$(cat README.md)\" = guest-only && test ! -e .env && node -e 'console.log(\"real-node-ok\" + \"x\".repeat(70000))'")));
      send({ action: "run" });
      expect(await receive()).toMatchObject({ event: "finished", executed: true, hostReadme: "original" });
      const completed = await ok(http(recipient, `/api/v1/tasks/${first.jobId}`));
      expect(completed.status).toBe("succeeded");
      expect(completed.output.stdout).toContain("real-node-ok");
      const artifact = completed.receipt.artifactRefs[0];
      expect(artifact).toBeDefined();
      expect((await http(owner, `/api/v1/artifacts/${artifact}`)).statusCode).not.toBe(200);
      expect((await http(recipient, `/api/v1/artifacts/${artifact}`)).statusCode).toBe(200);
      const pending = await ok(http(recipient, "/api/v1/invocations", make("sh -c 'while :; do sleep 1; done' & wait")));
      send({ action: "run" });
      for (let attempts = 0; attempts < 200; attempts++) {
        const active = await store.pool.query("SELECT status FROM adc_dispatches WHERE invocation_id=$1", [pending.invocationId]);
        if (active.rows[0]?.status === "running") break;
        await new Promise(resolve => setTimeout(resolve, 20));
        if (attempts === 199) throw new Error("Real Node did not start guest work.");
      }
      await ok(http(owner, `/api/v1/device-shares/${shared.binding.bindingId}/revoke`, { revision: 1 }));
      expect((await receive()).event).toBe("finished");
      expect((await ok(http(recipient, `/api/v1/tasks/${pending.jobId}`))).status).not.toBe("running");
      expect((await http(recipient, `/api/v1/artifacts/${artifact}`)).statusCode).not.toBe(200);
      expect((await ok(http(recipient, "/api/v1/invocations", make("echo must-not-run")))).status).toBe("denied");
    } finally {
      send({ action: "quit" }); ssh.stdin.end();
      await new Promise<void>(resolve => { if (ssh.exitCode !== null) resolve(); else ssh.once("exit", () => resolve()); });
      lines.close();
    }
  }, 90_000);
});
