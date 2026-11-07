import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AdcClient, buildInvocation } from "@adc/client";
import { NodeApiClient, generateNodeKeyPair, signNodeRequest } from "@adc/client/node";
import { MemoryStore } from "@adc/db";
import {
  CapabilitySchema,
  InvocationSchema,
  NodeWakeSignalSchema,
  ResultSchema,
  createId
} from "@adc/protocol";
import { createControlPlane } from "./app.ts";
import type { NodeDistribution } from "./distribution.ts";
import { accessFixture } from "../../../tests/helpers/access-fixture.ts";

const apps: Awaited<ReturnType<typeof createControlPlane>>[] = [];
const directories: string[] = [];
const cookie = "adc.session_token=api-test-session";

function fetchFor(app: Awaited<ReturnType<typeof createControlPlane>>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const injection: InjectOptions = {
      method: (init?.method ?? "GET") as any,
      url: `${url.pathname}${url.search}`,
      headers,
      ...(typeof init?.body === "string" ? { payload: init.body } : {})
    };
    const response: LightMyRequestResponse = await app.inject(injection);
    return new Response(new Uint8Array(response.rawPayload), {
      status: response.statusCode,
      headers: response.headers as Record<string, string>
    });
  }) as typeof fetch;
}

async function fixture(now?: () => Date, nodeDistribution?: NodeDistribution) {
  const store = new MemoryStore();
  const assets = new Map<string, Buffer>();
  const app = await createControlPlane({
    store,
    access: accessFixture({
      cookie,
      agents: {
        "approval-agent-token": { accountId: "acct_primary", grantId: "grant_example" },
        "other-agent-token": { accountId: "acct_primary", grantId: "grant_other" }
      }
    }),
    assetStore: {
      async put(sha256, data) {
        assets.set(sha256, Buffer.from(data));
      },
      async get(sha256) {
        const data = assets.get(sha256);
        if (!data) throw new Error("asset not found");
        return Buffer.from(data);
      }
    },
    ...(now ? { now } : {}),
    ...(nodeDistribution ? { nodeDistribution } : {})
  });
  apps.push(app);
  const fetcher = fetchFor(app);
  const owner = new AdcClient("http://adc.test", { cookie }, fetcher);
  const pairing = await owner.createPairingCode();
  const keys = generateNodeKeyPair();
  const unpaired = new NodeApiClient("http://adc.test", undefined, keys.privateKey, fetcher);
  const paired = await unpaired.pair({
    code: pairing.code,
    label: "test-mac",
    platform: "darwin",
    publicKey: keys.publicKey
  });
  const node = new NodeApiClient("http://adc.test", paired.nodeId, keys.privateKey, fetcher);
  const capability = CapabilitySchema.parse({
    schemaVersion: "0.1",
    nodeId: paired.nodeId,
    tools: [
      {
        name: "file.read",
        version: "0.1.0",
        risk: "read",
        sandboxProfiles: ["restricted-process"]
      }
    ],
    roots: [{ rootId: "root_workspace", label: "workspace", writable: true }],
    platform: "darwin",
    nodeVersion: "0.1.0",
    advertisedAt: new Date().toISOString()
  });
  return { app, store, assets, fetcher, owner, node, paired, keys, capability };
}

async function ownerRequest(
  app: Awaited<ReturnType<typeof createControlPlane>>,
  method: "GET" | "POST",
  url: string,
  payload?: unknown
) {
  const injection: InjectOptions = {
    method,
    url,
    headers: { cookie, origin: "http://adc.test" },
    ...(payload === undefined ? {} : { payload: payload as any })
  };
  return app.inject(injection);
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("control plane", () => {
  async function waitFixture(
    allowedTools: Array<"file.read" | "task.wait"> = ["file.read", "task.wait"],
    now?: () => Date
  ) {
    const setup = await fixture(now);
    await setup.node.poll(setup.capability);
    await setup.owner.createAccess({
      grantId: "grant_example",
      actorId: "actor_testagent",
      name: "Wait agent",
      profile: "read-only",
      nodeIds: [setup.paired.nodeId],
      rootAccess: "selected",
      rootIds: ["root_workspace"],
      approvalPolicy: "never",
      allowedTools
    });
    const invocation = buildInvocation({
      context: {
        accountId: "acct_primary",
        actorId: "actor_testagent",
        grantId: "grant_example",
        nodeIds: [setup.paired.nodeId],
        rootIds: ["root_workspace"]
      },
      tool: "file.read",
      args: { rootId: "root_workspace", path: "README.md" },
      source: "sdk"
    });
    const agent = new AdcClient("http://adc.test", "approval-agent-token", setup.fetcher);
    return { ...setup, invocation, agent };
  }

  async function inlinePoll(setup: Awaited<ReturnType<typeof waitFixture>>, waitMs = 0) {
    const path = `/api/v1/nodes/${setup.paired.nodeId}/poll`;
    const body = { capability: setup.capability, acknowledge: true, waitMs };
    const timestamp = new Date().toISOString();
    const nonce = randomBytes(18).toString("base64url");
    const response = await setup.app.inject({
      method: "POST",
      url: path,
      payload: body,
      headers: {
        "x-adc-node-id": setup.paired.nodeId,
        "x-adc-timestamp": timestamp,
        "x-adc-nonce": nonce,
        "x-adc-signature": signNodeRequest(setup.keys.privateKey, {
          method: "POST",
          path,
          timestamp,
          nonce,
          body
        })
      }
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it("advertises inline ACK while preserving legacy leased dispatches", async () => {
    const setup = await waitFixture();
    await setup.agent.invoke(setup.invocation);
    const response = await setup.node.poll(setup.capability);
    expect(response).toMatchObject({ inlineAckSupported: true, dispatch: { status: "leased" } });
    expect(response).not.toHaveProperty("acknowledgement");
    await setup.node.acknowledge(response.dispatch!.dispatchId, response.dispatch!.leaseToken);
  });

  it("acknowledges long-polled work and accepts its receipt without a separate ACK", async () => {
    const setup = await waitFixture();
    const polling = inlinePoll(setup, 2000);
    await setup.agent.invoke(setup.invocation);
    const response = await polling;
    expect(response).toMatchObject({
      longPoll: true,
      dispatch: { status: "running" },
      acknowledgement: { acknowledged: true, cancelRequested: false }
    });
    expect(response.acknowledgement.leaseExpiresAt).toBe(response.dispatch.leaseExpiresAt);
    await setup.node.complete({
      dispatchId: response.dispatch.dispatchId,
      leaseToken: response.dispatch.leaseToken,
      result: {
        schemaVersion: "0.1",
        invocationId: setup.invocation.invocationId,
        attemptId: setup.invocation.attemptId,
        status: "succeeded",
        output: { text: "inline" }
      }
    });
    expect(await setup.agent.invoke(setup.invocation)).toMatchObject({
      status: "succeeded",
      output: { text: "inline" }
    });
    expect(await inlinePoll(setup)).toMatchObject({ dispatch: null });
  });

  it("withholds inline dispatch when cancellation wins the claim to ACK race", async () => {
    const setup = await waitFixture();
    await setup.agent.invoke(setup.invocation);
    const acknowledge = setup.store.acknowledge.bind(setup.store);
    setup.store.acknowledge = async (id, token, now) => {
      await setup.store.requestCancel(id, now);
      return acknowledge(id, token, now);
    };
    const response = await inlinePoll(setup);
    expect(response.dispatch).toBeNull();
    expect(response).not.toHaveProperty("acknowledgement");
    expect(await setup.store.getDispatchByInvocation(setup.invocation.invocationId)).toMatchObject({
      status: "cancelled"
    });
  });

  it("recovers a lost inline response with the same invocation and a new lease", async () => {
    let clock = Date.now();
    const setup = await waitFixture(undefined, () => new Date(clock));
    await setup.agent.invoke(setup.invocation);
    const lost = await inlinePoll(setup);
    expect((await inlinePoll(setup)).dispatch).toBeNull();
    clock += 30_001;
    const retried = await inlinePoll(setup);
    expect(retried.dispatch.dispatchId).toBe(lost.dispatch.dispatchId);
    expect(retried.dispatch.invocation).toEqual(lost.dispatch.invocation);
    expect(retried.dispatch.leaseToken).not.toBe(lost.dispatch.leaseToken);
    expect(retried.acknowledgement.cancelRequested).toBe(false);
    await expect(
      setup.node.renewLease(lost.dispatch.dispatchId, lost.dispatch.leaseToken)
    ).rejects.toThrow();
  });

  it("returns cancellation for recovered inline work after access is revoked", async () => {
    let clock = Date.now();
    const setup = await waitFixture(undefined, () => new Date(clock));
    await setup.agent.invoke(setup.invocation);
    const first = await inlinePoll(setup);
    await setup.owner.revokeAccess("grant_example");
    clock += 30_001;
    const response = await inlinePoll(setup);
    expect(response).toMatchObject({
      dispatch: { dispatchId: first.dispatch.dispatchId, status: "cancel_requested" },
      acknowledgement: { acknowledged: true, cancelRequested: true }
    });
  });

  it("does not inline-acknowledge queued work after access is revoked", async () => {
    const setup = await waitFixture();
    await setup.agent.invoke(setup.invocation);
    await setup.owner.revokeAccess("grant_example");
    const response = await inlinePoll(setup);
    expect(response.dispatch).toBeNull();
    expect(response).not.toHaveProperty("acknowledgement");
  });

  it("does not return execution permission when the inline lease expires before ACK", async () => {
    const setup = await waitFixture();
    await setup.agent.invoke(setup.invocation);
    const acknowledge = setup.store.acknowledge.bind(setup.store);
    setup.store.acknowledge = (id, token, now) =>
      acknowledge(id, token, new Date(now.getTime() + 30_001));
    const response = await inlinePoll(setup);
    expect(response.dispatch).toBeNull();
    expect(response).not.toHaveProperty("acknowledgement");
  });

  it("waits on the submitted invocation and reuses it after completion", async () => {
    const { agent, node, capability, invocation, store } = await waitFixture();
    const waiting = agent.invoke(invocation, { waitMs: 2000 });
    const polled = await node.poll(capability, { waitMs: 2000 });
    const dispatch = polled.dispatch!;
    await node.acknowledge(dispatch.dispatchId, dispatch.leaseToken);
    await node.complete({
      dispatchId: dispatch.dispatchId,
      leaseToken: dispatch.leaseToken,
      result: {
        schemaVersion: "0.1",
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        status: "succeeded",
        output: { text: "ready" }
      }
    });
    await expect(waiting).resolves.toMatchObject({
      status: "succeeded",
      output: { text: "ready" }
    });
    await expect(
      agent.invoke(
        {
          ...invocation,
          expiresAt: new Date(Date.now() - 1).toISOString()
        },
        { waitMs: 0 }
      )
    ).resolves.toMatchObject({ status: "succeeded" });
    expect((await store.getDispatchByInvocation(invocation.invocationId))?.dispatchId).toBe(
      dispatch.dispatchId
    );
    await expect(node.poll(capability)).resolves.toMatchObject({ dispatch: null });
  });

  it("returns completion from the HTTP MCP tool call", async () => {
    const { app, node, paired, capability } = await waitFixture(["file.read"]);
    const waiting = app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer approval-agent-token",
        accept: "application/json, text/event-stream"
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "file.read",
          arguments: {
            args: { rootId: "root_workspace", path: "README.md" },
            target: { nodeId: paired.nodeId }
          }
        }
      }
    });
    const dispatch = (await node.poll(capability, { waitMs: 2000 })).dispatch!;
    expect(dispatch).toBeDefined();
    await node.acknowledge(dispatch.dispatchId, dispatch.leaseToken);
    await node.complete({
      dispatchId: dispatch.dispatchId,
      leaseToken: dispatch.leaseToken,
      result: {
        schemaVersion: "0.1",
        invocationId: dispatch.invocation.invocationId,
        attemptId: dispatch.invocation.attemptId,
        status: "succeeded",
        output: { text: "mcp-ready" }
      }
    });
    const response = await waiting;
    expect(response.statusCode).toBe(200);
    expect(response.json().result.structuredContent).toMatchObject({
      status: "succeeded",
      output: { text: "mcp-ready" }
    });
  });

  it("wait expiry keeps the task alive and task.wait resumes it", async () => {
    const { agent, invocation, fetcher } = await waitFixture();
    const queued = await agent.invoke(invocation, { waitMs: 10 });
    expect(queued.status).toBe("queued");
    const other = new AdcClient("http://adc.test", "other-agent-token", fetcher);
    await expect(other.taskWait(queued.jobId!, 2000)).rejects.toMatchObject({ statusCode: 404 });
    await expect(agent.taskWait(queued.jobId!, 0)).resolves.toMatchObject({ status: "queued" });
    await expect(
      agent.invoke(
        buildInvocation({
          context: {
            accountId: invocation.accountId,
            actorId: invocation.actor.id,
            grantId: invocation.authorization.grantId,
            nodeIds: ["node_placeholder"],
            rootIds: []
          },
          tool: "task.wait",
          args: { jobId: queued.jobId, waitMs: 10 },
          source: "sdk"
        })
      )
    ).resolves.toMatchObject({ status: "succeeded", output: { task: { status: "queued" } } });
    await expect(agent.taskWait(queued.jobId!, 30_001)).rejects.toThrow();
  });

  it("denies a result when the grant is revoked during a wait", async () => {
    const { agent, invocation, owner, node, capability } = await waitFixture();
    const waiting = agent.invoke(invocation, { waitMs: 2000 });
    const dispatch = (await node.poll(capability, { waitMs: 2000 })).dispatch!;
    await node.acknowledge(dispatch.dispatchId, dispatch.leaseToken);
    await owner.revokeAccess("grant_example");
    await node.complete({
      dispatchId: dispatch.dispatchId,
      leaseToken: dispatch.leaseToken,
      result: {
        schemaVersion: "0.1",
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        status: "succeeded",
        output: {}
      }
    });
    await expect(waiting).rejects.toThrow();
  });

  it("holds an idle long poll and marks the supported response", async () => {
    const { node, capability } = await fixture();
    const startedAt = Date.now();

    await expect(node.poll(capability, { waitMs: 40 })).resolves.toMatchObject({
      dispatch: null,
      longPoll: true
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
  });

  it("releases a long poll as soon as work is queued", async () => {
    const { app, owner, node, paired, capability } = await fixture();
    await node.poll(capability);
    await ownerRequest(app, "POST", "/api/v1/projects", {
      projectId: "proj_long_poll",
      label: "Long poll"
    });
    await ownerRequest(app, "POST", "/api/v1/projects/proj_long_poll/roots", {
      rootId: "root_workspace",
      nodeId: paired.nodeId,
      label: "Workspace",
      writable: true
    });
    await ownerRequest(app, "POST", "/api/v1/grants", {
      grantId: "grant_long_poll",
      projectId: "proj_long_poll",
      actorId: "actor_long_poll",
      profile: "read-only",
      nodeIds: [paired.nodeId],
      rootIds: ["root_workspace"],
      allowedTools: ["file.read"]
    });
    const polling = node.poll(capability, { waitMs: 5_000 });
    await new Promise((resolve) => setImmediate(resolve));
    const now = new Date();
    const invocation = InvocationSchema.parse({
      schemaVersion: "0.1",
      invocationId: createId("inv"),
      attemptId: createId("att"),
      accountId: "acct_primary",
      actor: { type: "agent", id: "actor_long_poll" },
      target: { nodeId: paired.nodeId },
      authorization: {
        projectId: "proj_long_poll",
        rootIds: ["root_workspace"],
        grantId: "grant_long_poll"
      },
      tool: "file.read",
      args: { rootId: "root_workspace", path: "README.md" },
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      metadata: { source: "sdk" }
    });

    await expect(owner.invoke(invocation)).resolves.toMatchObject({ status: "queued" });
    await expect(polling).resolves.toMatchObject({
      dispatch: { invocation: { invocationId: invocation.invocationId } },
      longPoll: true
    });
  });

  it("marks legacy desktop nodes without a build ID as updateable", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "adc-control-plane-release-"));
    directories.push(directory);
    const buildId = `sha256:${"b".repeat(64)}`;
    await writeFile(
      resolve(directory, "manifest-v2.json"),
      JSON.stringify({
        version: "0.1.1",
        runtimeVersion: "24.21.0",
        buildId
      })
    );
    const { owner, node, capability, paired } = await fixture(undefined, {
      directory,
      publicUrl: "https://devices.example.com"
    });

    await expect(node.poll(capability)).resolves.toMatchObject({
      update: {
        state: "update_available",
        currentBuildId: null,
        latest: { version: "0.1.1", buildId }
      }
    });
    await expect(owner.listNodes()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: paired.nodeId,
          update: expect.objectContaining({
            state: "update_available",
            currentBuildId: null,
            latest: expect.objectContaining({ version: "0.1.1", buildId })
          })
        })
      ])
    );
  });

  it("accepts native Windows nodes", async () => {
    const { owner, fetcher } = await fixture();
    const pairing = await owner.createPairingCode();
    const keys = generateNodeKeyPair();
    await expect(
      new NodeApiClient("http://adc.test", undefined, keys.privateKey, fetcher).pair({
        code: pairing.code,
        label: "test-windows",
        platform: "win32",
        publicKey: keys.publicKey
      })
    ).resolves.toMatchObject({ nodeId: expect.stringMatching(/^node_/) });
  });

  it("accepts an Android node backed by a P-256 device identity", async () => {
    const { owner, fetcher } = await fixture();
    const pairing = await owner.createPairingCode();
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const paired = await new NodeApiClient("http://adc.test", undefined, privateKey, fetcher).pair({
      code: pairing.code,
      label: "test-android",
      platform: "android",
      publicKey
    });
    const android = new NodeApiClient("http://adc.test", paired.nodeId, privateKey, fetcher);

    await expect(
      android.poll(
        CapabilitySchema.parse({
          schemaVersion: "0.1",
          nodeId: paired.nodeId,
          tools: [
            {
              name: "location.get",
              version: "0.1.0",
              risk: "read",
              sandboxProfiles: ["native-app"],
              availability: {
                state: "permission_required",
                reason: "Allow location access.",
                observedAt: new Date().toISOString()
              }
            }
          ],
          roots: [],
          accessMode: "none",
          platform: "android",
          nodeVersion: "0.1.0",
          advertisedAt: new Date().toISOString()
        })
      )
    ).resolves.toMatchObject({ dispatch: null });
  });

  it.each([
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"]
  ])(
    "stores %s screenshot bytes in the asset plane and only metadata in the database",
    async (extension, contentType) => {
      const { app, store, assets, owner, node, paired, capability } = await fixture();
      const mobileCapability = CapabilitySchema.parse({
        ...capability,
        roots: [],
        accessMode: "none",
        tools: [
          {
            name: "screen.capture",
            version: "0.1.0",
            risk: "read",
            sandboxProfiles: ["native-app"],
            availability: {
              state: "available",
              observedAt: new Date().toISOString()
            }
          }
        ]
      });
      await node.poll(mobileCapability);
      expect(
        (
          await owner.createAccess({
            grantId: "grant_example",
            actorId: "actor_testagent",
            name: "Screen agent",
            profile: "read-only",
            nodeIds: [paired.nodeId],
            rootAccess: "selected",
            rootIds: [],
            approvalPolicy: "never",
            allowedTools: ["screen.capture", "task.status", "task.result", "task.wait"]
          })
        ).grantId
      ).toBe("grant_example");
      const now = new Date();
      const invocation = InvocationSchema.parse({
        schemaVersion: "0.1",
        invocationId: createId("inv"),
        attemptId: createId("att"),
        accountId: "acct_primary",
        actor: { type: "agent", id: "actor_testagent" },
        target: { nodeId: paired.nodeId },
        authorization: { rootIds: [], grantId: "grant_example" },
        tool: "screen.capture",
        args: {},
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        metadata: { source: "sdk" }
      });
      const queued = await owner.invoke(invocation);
      const polled = await node.poll(mobileCapability);
      await node.acknowledge(polled.dispatch!.dispatchId, polled.dispatch!.leaseToken);

      const data = Buffer.from([0, 255, 128, 13, 10, 1]);
      const contentHash = `sha256:${createHash("sha256").update(data).digest("hex")}`;
      const artifactId = `artifact_0123456789abcdef0123456789abcdef.${extension}`;
      await expect(
        node.uploadArtifact({
          dispatchId: polled.dispatch!.dispatchId,
          artifactId,
          contentType: "text/plain",
          sha256: contentHash,
          data
        })
      ).rejects.toThrow(/content type/);
      await expect(
        node.uploadArtifact({
          dispatchId: polled.dispatch!.dispatchId,
          artifactId,
          contentType,
          sha256: `sha256:${"0".repeat(64)}`,
          data
        })
      ).rejects.toThrow(/hash mismatch/);
      await node.uploadArtifact({
        dispatchId: polled.dispatch!.dispatchId,
        artifactId,
        contentType,
        sha256: contentHash,
        data
      });
      await node.complete({
        dispatchId: polled.dispatch!.dispatchId,
        leaseToken: polled.dispatch!.leaseToken,
        result: ResultSchema.parse({
          schemaVersion: "0.1",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          status: "succeeded",
          output: { artifactId }
        })
      });

      expect(assets.get(contentHash)).toEqual(data);
      expect((await store.getArtifact(artifactId))?.byteSize).toBe(data.byteLength);
      expect((await store.getArtifact(artifactId))?.data).toHaveLength(0);
      await expect(owner.artifact(artifactId)).resolves.toEqual(new Uint8Array(data));
      await expect(owner.taskStatus(queued.jobId!)).resolves.toMatchObject({
        status: "succeeded",
        output: { artifactId }
      });
      const rpc = (method: string, params: unknown, token = "approval-agent-token") =>
        app.inject({
          method: "POST",
          url: "/mcp",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json, text/event-stream"
          },
          payload: { jsonrpc: "2.0", id: 1, method, params }
        });
      const uri = `adc://artifacts/${artifactId}`;
      const resource = await rpc("resources/read", { uri });
      expect(resource.json().result).toEqual({
        contents: [{ uri, mimeType: contentType, blob: data.toString("base64") }]
      });
      for (const name of ["task.status", "task.result", "task.wait"]) {
        const task = await rpc("tools/call", {
          name,
          arguments: { args: { jobId: queued.jobId! } }
        });
        expect(task.json().result.content).toContainEqual({
          type: "image",
          data: data.toString("base64"),
          mimeType: contentType
        });
      }
      await owner.createAccess({
        grantId: "grant_other",
        actorId: "actor_other",
        name: "Other agent",
        profile: "read-only",
        nodeIds: [paired.nodeId],
        rootAccess: "selected",
        rootIds: [],
        allowedTools: ["screen.capture", "task.result"],
        approvalPolicy: "never"
      });
      expect((await rpc("resources/read", { uri }, "other-agent-token")).json()).toHaveProperty(
        "error"
      );
      await owner.revokeAccess("grant_example");
      expect((await rpc("resources/read", { uri })).statusCode).toBe(403);
    }
  );

  it("pairs once, dispatches with a lease, accepts a terminal result and audits it", async () => {
    const { app, owner, node, paired, capability } = await fixture();
    await node.poll(capability);
    expect(
      (
        await ownerRequest(app, "POST", "/api/v1/projects", {
          projectId: "proj_example",
          label: "Example"
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await ownerRequest(app, "POST", "/api/v1/projects/proj_example/roots", {
          rootId: "root_workspace",
          nodeId: paired.nodeId,
          label: "Workspace",
          writable: true
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await ownerRequest(app, "POST", "/api/v1/grants", {
          grantId: "grant_example",
          projectId: "proj_example",
          actorId: "actor_testagent",
          profile: "read-only",
          nodeIds: [paired.nodeId],
          rootIds: ["root_workspace"],
          allowedTools: ["device.list", "file.read"]
        })
      ).statusCode
    ).toBe(200);

    const now = new Date();
    const devices = await owner.invoke(
      InvocationSchema.parse({
        schemaVersion: "0.1",
        invocationId: createId("inv"),
        attemptId: createId("att"),
        accountId: "acct_primary",
        actor: { type: "agent", id: "actor_testagent" },
        target: { projectId: "proj_example" },
        authorization: {
          projectId: "proj_example",
          rootIds: ["root_workspace"],
          grantId: "grant_example"
        },
        tool: "device.list",
        args: {},
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        metadata: { source: "sdk" }
      })
    );
    expect(devices).toMatchObject({
      status: "succeeded",
      output: { nodes: [{ nodeId: paired.nodeId }] }
    });
    expect(JSON.stringify(devices.output)).not.toContain("PUBLIC KEY");

    const invocation = InvocationSchema.parse({
      schemaVersion: "0.1",
      invocationId: createId("inv"),
      attemptId: createId("att"),
      accountId: "acct_primary",
      actor: { type: "agent", id: "actor_testagent" },
      target: { projectId: "proj_example" },
      authorization: {
        projectId: "proj_example",
        rootIds: ["root_workspace"],
        grantId: "grant_example"
      },
      tool: "file.read",
      args: { rootId: "root_workspace", path: "README.md" },
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      metadata: { source: "sdk" }
    });
    const queued = await owner.invoke(invocation);
    expect(queued.status).toBe("queued");

    await expect(node.poll(capability, { activeTaskCount: 6 })).resolves.toMatchObject({
      dispatch: null,
      maxConcurrency: 6
    });
    const polled = await node.poll(capability);
    expect(polled.dispatch!.invocation.invocationId).toBe(invocation.invocationId);
    await node.acknowledge(polled.dispatch!.dispatchId, polled.dispatch!.leaseToken);
    const result = ResultSchema.parse({
      schemaVersion: "0.1",
      invocationId: invocation.invocationId,
      attemptId: invocation.attemptId,
      status: "succeeded",
      output: { content: "ok" }
    });
    await node.complete({
      dispatchId: polled.dispatch!.dispatchId,
      leaseToken: polled.dispatch!.leaseToken,
      result
    });
    await expect(owner.taskStatus(queued.jobId!)).resolves.toMatchObject({
      status: "succeeded",
      output: { content: "ok" }
    });
    const audit = await owner.audit(invocation.invocationId);
    expect(audit).toHaveLength(2);
  });

  it("wakes an authenticated Node when work is queued", async () => {
    const { app, owner, node, paired, keys, capability } = await fixture();
    await node.poll(capability);
    await ownerRequest(app, "POST", "/api/v1/projects", {
      projectId: "proj_example",
      label: "Example"
    });
    await ownerRequest(app, "POST", "/api/v1/projects/proj_example/roots", {
      rootId: "root_workspace",
      nodeId: paired.nodeId,
      label: "Workspace",
      writable: true
    });
    await ownerRequest(app, "POST", "/api/v1/grants", {
      grantId: "grant_example",
      projectId: "proj_example",
      actorId: "actor_testagent",
      profile: "read-only",
      nodeIds: [paired.nodeId],
      rootIds: ["root_workspace"],
      allowedTools: ["file.read"]
    });

    const path = `/api/v1/nodes/${paired.nodeId}/events`;
    const timestamp = new Date().toISOString();
    const nonce = randomBytes(18).toString("base64url");
    const socket = await app.injectWS(path, {
      headers: {
        "x-adc-node-id": paired.nodeId,
        "x-adc-timestamp": timestamp,
        "x-adc-nonce": nonce,
        "x-adc-signature": signNodeRequest(keys.privateKey, {
          method: "GET",
          path,
          timestamp,
          nonce
        })
      }
    });
    const message = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("wake signal timed out")), 1_000);
      socket.once("message", (data) => {
        clearTimeout(timeout);
        resolve(JSON.parse(data.toString()));
      });
    });
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    const now = new Date();
    const queued = await owner.invoke(
      InvocationSchema.parse({
        schemaVersion: "0.1",
        invocationId: createId("inv"),
        attemptId: createId("att"),
        accountId: "acct_primary",
        actor: { type: "agent", id: "actor_testagent" },
        target: { nodeId: paired.nodeId },
        authorization: {
          projectId: "proj_example",
          rootIds: ["root_workspace"],
          grantId: "grant_example"
        },
        tool: "file.read",
        args: { rootId: "root_workspace", path: "README.md" },
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        metadata: { source: "sdk" }
      })
    );

    expect(queued.status).toBe("queued");
    expect(NodeWakeSignalSchema.parse(await message)).toMatchObject({
      type: "dispatch.available",
      nodeId: paired.nodeId
    });
    const revoked = await ownerRequest(app, "POST", `/api/v1/nodes/${paired.nodeId}/revoke`, {});
    expect(revoked.statusCode, revoked.body).toBe(200);
    await expect(closed).resolves.toBe(4001);
  });

  it("keeps a new Node offline and disconnects it when same-label pairing replaces it", async () => {
    const { app, store, owner, fetcher, paired, keys } = await fixture();
    const path = `/api/v1/nodes/${paired.nodeId}/events`;
    const timestamp = new Date().toISOString();
    const nonce = randomBytes(18).toString("base64url");
    const socket = await app.injectWS(path, {
      headers: {
        "x-adc-node-id": paired.nodeId,
        "x-adc-timestamp": timestamp,
        "x-adc-nonce": nonce,
        "x-adc-signature": signNodeRequest(keys.privateKey, {
          method: "GET",
          path,
          timestamp,
          nonce
        })
      }
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect((await store.getNode(paired.nodeId))?.lastSeenAt).toBeUndefined();
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    const replacementKeys = generateNodeKeyPair();
    const replacementCode = await owner.createPairingCode();
    const replacement = await new NodeApiClient(
      "http://adc.test",
      undefined,
      replacementKeys.privateKey,
      fetcher
    ).pair({
      code: replacementCode.code,
      label: "test-mac",
      platform: "darwin",
      publicKey: replacementKeys.publicKey
    });

    expect(replacement.nodeId).not.toBe(paired.nodeId);
    await expect(closed).resolves.toBe(4001);
  });

  it("rejects replayed proofs and enforces key rotation and revoke", async () => {
    const { app, paired, keys, capability, fetcher, node } = await fixture();
    const path = `/api/v1/nodes/${paired.nodeId}/poll`;
    const body = { capability };
    const timestamp = new Date().toISOString();
    const nonce = randomBytes(18).toString("base64url");
    const signature = signNodeRequest(keys.privateKey, {
      method: "POST",
      path,
      timestamp,
      nonce,
      body
    });
    const request = {
      method: "POST" as const,
      url: path,
      headers: {
        "x-adc-node-id": paired.nodeId,
        "x-adc-timestamp": timestamp,
        "x-adc-nonce": nonce,
        "x-adc-signature": signature
      },
      payload: body
    };
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(409);

    const rotatedKeys = generateNodeKeyPair();
    await node.rotateKey(rotatedKeys.publicKey);
    await expect(node.poll(capability)).rejects.toThrow("invalid device proof");
    const rotatedNode = new NodeApiClient(
      "http://adc.test",
      paired.nodeId,
      rotatedKeys.privateKey,
      fetcher
    );
    await expect(rotatedNode.poll(capability)).resolves.toMatchObject({ dispatch: null });

    expect(
      (await ownerRequest(app, "POST", `/api/v1/nodes/${paired.nodeId}/revoke`, {})).statusCode
    ).toBe(200);
    await expect(rotatedNode.poll(capability)).rejects.toThrow("device is unknown or revoked");
  });

  it("reports an explicit offline target instead of silently falling back", async () => {
    let currentTime = new Date();
    const { app, owner, paired, node, capability } = await fixture(() => currentTime);
    await node.poll(capability);
    await ownerRequest(app, "POST", "/api/v1/projects", {
      projectId: "proj_example",
      label: "Example"
    });
    await ownerRequest(app, "POST", "/api/v1/projects/proj_example/roots", {
      rootId: "root_workspace",
      nodeId: paired.nodeId,
      label: "Workspace",
      writable: true
    });
    await ownerRequest(app, "POST", "/api/v1/grants", {
      grantId: "grant_example",
      projectId: "proj_example",
      actorId: "actor_testagent",
      profile: "read-only",
      nodeIds: [paired.nodeId],
      rootIds: ["root_workspace"],
      allowedTools: ["file.read"]
    });
    currentTime = new Date(currentTime.getTime() + 60_000);
    const now = currentTime;
    const result = await owner.invoke(
      InvocationSchema.parse({
        schemaVersion: "0.1",
        invocationId: createId("inv"),
        attemptId: createId("att"),
        accountId: "acct_primary",
        actor: { type: "agent", id: "actor_testagent" },
        target: { nodeId: paired.nodeId },
        authorization: {
          projectId: "proj_example",
          rootIds: ["root_workspace"],
          grantId: "grant_example"
        },
        tool: "file.read",
        args: { rootId: "root_workspace", path: "README.md" },
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        metadata: { source: "sdk" }
      })
    );
    expect(result).toMatchObject({
      status: "offline",
      error: { code: "offline", retryable: true }
    });
  });

  it("persists required approvals and dispatches only after owner approval", async () => {
    const { app, owner, node, paired, capability } = await fixture();
    const writeCapability = CapabilitySchema.parse({
      ...capability,
      tools: [
        ...capability.tools,
        {
          name: "file.write",
          version: "0.1.0",
          risk: "write",
          sandboxProfiles: ["restricted-process"]
        }
      ]
    });
    await node.poll(writeCapability);
    await ownerRequest(app, "POST", "/api/v1/projects", {
      projectId: "proj_example",
      label: "Example"
    });
    await ownerRequest(app, "POST", "/api/v1/projects/proj_example/roots", {
      rootId: "root_workspace",
      nodeId: paired.nodeId,
      label: "Workspace",
      writable: true
    });
    await ownerRequest(app, "POST", "/api/v1/grants", {
      grantId: "grant_example",
      projectId: "proj_example",
      actorId: "actor_testagent",
      profile: "approve-required",
      nodeIds: [paired.nodeId],
      rootIds: ["root_workspace"],
      allowedTools: ["file.write", "task.status"]
    });
    const now = new Date();
    const invocation = InvocationSchema.parse({
      schemaVersion: "0.1",
      invocationId: createId("inv"),
      attemptId: createId("att"),
      accountId: "acct_primary",
      actor: { type: "agent", id: "actor_testagent" },
      target: { projectId: "proj_example" },
      authorization: {
        projectId: "proj_example",
        rootIds: ["root_workspace"],
        grantId: "grant_example"
      },
      tool: "file.write",
      args: { rootId: "root_workspace", path: "approved.txt", content: "ok" },
      idempotencyKey: "approval-write",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      metadata: { source: "sdk" }
    });
    const pending = await owner.invoke(invocation);
    expect(pending).toMatchObject({
      status: "approval_required",
      error: { code: "approval_required" }
    });
    const agent = new AdcClient("http://adc.test", "approval-agent-token", fetchFor(app));
    await expect(agent.invocationStatus(invocation.invocationId)).resolves.toMatchObject({
      status: "approval_required",
      error: { details: { approvalId: expect.any(String) } }
    });
    await expect(
      new AdcClient("http://adc.test", "other-agent-token", fetchFor(app)).invocationStatus(
        invocation.invocationId
      )
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(node.poll(writeCapability)).resolves.toMatchObject({ dispatch: null });

    const approvalId = pending.error?.details?.approvalId as string;
    const approved = await ownerRequest(app, "POST", `/api/v1/approvals/${approvalId}`, {
      decision: "approved"
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: "queued" });
    await expect(agent.invocationStatus(invocation.invocationId)).resolves.toMatchObject({
      status: "queued",
      jobId: expect.stringMatching(/^job_/)
    });
    const deniedInvocation = InvocationSchema.parse({
      ...invocation,
      invocationId: createId("inv"),
      attemptId: createId("att"),
      idempotencyKey: "approval-write-denied"
    });
    const awaitingDenial = await owner.invoke(deniedInvocation);
    await ownerRequest(
      app,
      "POST",
      `/api/v1/approvals/${String(awaitingDenial.error?.details?.approvalId)}`,
      { decision: "denied" }
    );
    await expect(agent.invocationStatus(deniedInvocation.invocationId)).resolves.toMatchObject({
      status: "denied",
      error: { code: "denied" }
    });
    const dispatched = await node.poll(
      CapabilitySchema.parse({
        ...capability,
        tools: [
          ...capability.tools,
          {
            name: "file.write",
            version: "0.1.0",
            risk: "write",
            sandboxProfiles: ["restricted-process"]
          }
        ]
      })
    );
    expect(dispatched.dispatch!.policyDecision).toMatchObject({
      outcome: "allow",
      reasonCode: "approval.granted"
    });
  });

  it("fails with ambiguous_target when a project matches multiple devices", async () => {
    const { app, owner, node, paired, capability, fetcher } = await fixture();
    await node.poll(capability);
    const secondPairing = await owner.createPairingCode();
    const secondKeys = generateNodeKeyPair();
    const secondPair = await new NodeApiClient(
      "http://adc.test",
      undefined,
      secondKeys.privateKey,
      fetcher
    ).pair({
      code: secondPairing.code,
      label: "second-mac",
      platform: "darwin",
      publicKey: secondKeys.publicKey
    });
    const secondNode = new NodeApiClient(
      "http://adc.test",
      secondPair.nodeId,
      secondKeys.privateKey,
      fetcher
    );
    await secondNode.poll(
      CapabilitySchema.parse({
        ...capability,
        nodeId: secondPair.nodeId,
        roots: [{ rootId: "root_secondary", label: "secondary", writable: true }]
      })
    );
    await ownerRequest(app, "POST", "/api/v1/projects", {
      projectId: "proj_example",
      label: "Example"
    });
    await ownerRequest(app, "POST", "/api/v1/projects/proj_example/roots", {
      rootId: "root_workspace",
      nodeId: paired.nodeId,
      label: "Primary",
      writable: true
    });
    await ownerRequest(app, "POST", "/api/v1/projects/proj_example/roots", {
      rootId: "root_secondary",
      nodeId: secondPair.nodeId,
      label: "Secondary",
      writable: true
    });
    await ownerRequest(app, "POST", "/api/v1/grants", {
      grantId: "grant_example",
      projectId: "proj_example",
      actorId: "actor_testagent",
      profile: "read-only",
      nodeIds: [paired.nodeId, secondPair.nodeId],
      rootIds: ["root_workspace", "root_secondary"],
      allowedTools: ["file.read"]
    });
    const now = new Date();
    const result = await owner.invoke(
      InvocationSchema.parse({
        schemaVersion: "0.1",
        invocationId: createId("inv"),
        attemptId: createId("att"),
        accountId: "acct_primary",
        actor: { type: "agent", id: "actor_testagent" },
        target: { projectId: "proj_example" },
        authorization: {
          projectId: "proj_example",
          rootIds: ["root_workspace", "root_secondary"],
          grantId: "grant_example"
        },
        tool: "file.read",
        args: { rootId: "root_workspace", path: "README.md" },
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        metadata: { source: "sdk" }
      })
    );
    expect(result).toMatchObject({
      status: "denied",
      error: {
        code: "ambiguous_target",
        details: { candidates: [paired.nodeId, secondPair.nodeId].sort() }
      }
    });
  });

  it("authorizes and dispatches only custom tools advertised by the selected device", async () => {
    const { app, owner, node, paired, capability } = await fixture();
    const tool = "mcp.github.search.1234abcd";
    const customCapability = CapabilitySchema.parse({
      ...capability,
      tools: [
        ...capability.tools,
        {
          name: tool,
          version: "1.0.0",
          risk: "execute",
          sandboxProfiles: ["full-trust"],
          description: "Search GitHub issues",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"]
          },
          provider: {
            kind: "mcp",
            providerId: "github",
            providerName: "GitHub",
            sourceToolName: "search"
          }
        }
      ]
    });
    await node.poll(customCapability);
    const rejected = await ownerRequest(app, "POST", "/api/v1/grants", {
      grantId: "grant_rejected",
      actorId: "actor_rejected",
      profile: "workspace-write",
      nodeIds: [paired.nodeId],
      rootIds: [],
      allowedTools: ["mcp.github.unknown.87654321"]
    });
    expect(rejected.statusCode).toBe(403);

    const created = await ownerRequest(app, "POST", "/api/v1/grants", {
      grantId: "grant_custom",
      actorId: "actor_custom",
      profile: "workspace-write",
      nodeIds: [paired.nodeId],
      rootIds: [],
      allowedTools: [tool]
    });
    expect(created.statusCode).toBe(200);
    const now = new Date();
    const invocation = InvocationSchema.parse({
      schemaVersion: "0.1",
      invocationId: createId("inv"),
      attemptId: createId("att"),
      accountId: "acct_primary",
      actor: { type: "agent", id: "actor_custom" },
      target: { nodeId: paired.nodeId },
      authorization: {
        rootIds: [],
        grantId: "grant_custom"
      },
      tool,
      args: { query: "is:open" },
      idempotencyKey: "custom-search-1",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      metadata: { source: "sdk" }
    });
    await expect(owner.invoke(invocation)).resolves.toMatchObject({ status: "queued" });
    await expect(node.poll(customCapability)).resolves.toMatchObject({
      dispatch: {
        invocation: { tool, args: { query: "is:open" } },
        policyDecision: { outcome: "allow" }
      }
    });
  });

  it("serves bounded management timelines and aggregate console data", async () => {
    const timestamp = new Date();
    const { app, store, node, paired, capability } = await fixture(() => timestamp);
    await node.poll(
      CapabilitySchema.parse({
        ...capability,
        roots: [
          {
            rootId: "root_workspace",
            label: "workspace",
            path: "/workspace",
            writable: true
          }
        ]
      })
    );
    await ownerRequest(app, "POST", "/api/v1/projects", {
      projectId: "proj_example",
      label: "Example"
    });
    await ownerRequest(app, "POST", "/api/v1/projects/proj_example/roots", {
      rootId: "root_workspace",
      nodeId: paired.nodeId,
      label: "Workspace",
      writable: true
    });

    const createdAt = new Date(timestamp.getTime() + 60_000).toISOString();
    const expiredAt = new Date(timestamp.getTime() - 1_000).toISOString();
    const validUntil = new Date(timestamp.getTime() + 60 * 60_000).toISOString();
    for (const eventId of [
      "evt_api_01",
      "evt_api_02",
      "evt_api_03",
      "evt_api_04",
      "evt_api_05",
      "evt_api_06"
    ]) {
      await store.putAudit({
        eventId,
        accountId: "acct_primary",
        type: eventId === "evt_api_03" ? "approval.requested" : "dispatch.queued",
        payload: {},
        createdAt
      });
    }

    const first = await ownerRequest(app, "GET", "/api/v1/audit?limit=2");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      events: [{ eventId: "evt_api_06" }, { eventId: "evt_api_05" }],
      hasMore: true,
      nextCursor: expect.any(String)
    });
    await store.putAudit({
      eventId: "evt_api_07",
      accountId: "acct_primary",
      type: "dispatch.queued",
      payload: {},
      createdAt
    });
    const second = await ownerRequest(
      app,
      "GET",
      `/api/v1/audit?limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`
    );
    expect(second.json().events.map((event: { eventId: string }) => event.eventId)).toEqual([
      "evt_api_04",
      "evt_api_03"
    ]);
    const approvals = await ownerRequest(app, "GET", "/api/v1/audit?category=approval");
    expect(approvals.json().events).toMatchObject([{ eventId: "evt_api_03" }]);
    expect((await ownerRequest(app, "GET", "/api/v1/audit?cursor=invalid")).statusCode).toBe(400);

    const overview = await ownerRequest(app, "GET", "/api/v1/overview");
    expect(overview.json()).toMatchObject({
      counts: {
        connectedDevices: 1,
        onlineNow: 1,
        activeAgents: 0,
        pendingApprovals: 0,
        clientConnections: 0
      },
      recentActivity: [
        { eventId: "evt_api_07" },
        { eventId: "evt_api_06" },
        { eventId: "evt_api_05" },
        { eventId: "evt_api_04" },
        { eventId: "evt_api_03" }
      ]
    });
    const projects = await ownerRequest(app, "GET", "/api/v1/projects?include=roots");
    expect(projects.json()).toMatchObject({
      projects: [{ projectId: "proj_example" }],
      roots: [
        {
          projectId: "proj_example",
          nodeId: paired.nodeId,
          rootId: "root_workspace",
          path: "/workspace"
        }
      ]
    });

    for (const [approvalId, status, expiresAt] of [
      ["apr_api_01", "approved", validUntil],
      ["apr_api_02", "pending", expiredAt],
      ["apr_api_03", "pending", validUntil]
    ] as const) {
      const invocation = InvocationSchema.parse({
        schemaVersion: "0.1",
        invocationId: createId("inv"),
        attemptId: createId("att"),
        accountId: "acct_primary",
        actor: { type: "agent", id: "actor_testagent" },
        target: { nodeId: paired.nodeId },
        authorization: { rootIds: ["root_workspace"], grantId: "grant_example" },
        tool: "file.read",
        args: { rootId: "root_workspace", path: `${approvalId}.txt` },
        issuedAt: createdAt,
        expiresAt: validUntil,
        metadata: { source: "sdk" }
      });
      await store.putApproval({
        approvalId,
        accountId: "acct_primary",
        invocation,
        nodeId: paired.nodeId,
        placementReason: "explicit_node",
        policyDecision: {
          outcome: "approval_required",
          reasonCode: "approval.required",
          explanation: "Approval required by test.",
          evaluatedLayers: ["account", "agent", "node", "root", "capability"],
          profile: "approve-required",
          decisionHash: `sha256:${"a".repeat(64)}`
        },
        status,
        createdAt,
        expiresAt
      });
    }
    expect(
      (await ownerRequest(app, "GET", "/api/v1/approvals?status=pending")).json()
    ).toMatchObject({
      approvals: [
        { approvalId: "apr_api_03", status: "pending", path: "/workspace/apr_api_03.txt" }
      ],
      pendingCount: 1,
      hasMore: false
    });
    expect(
      (await ownerRequest(app, "GET", "/api/v1/approvals?status=resolved&limit=1")).json()
    ).toMatchObject({
      approvals: [{ approvalId: "apr_api_02", status: "expired" }],
      pendingCount: 1,
      hasMore: true,
      nextCursor: expect.any(String)
    });
  });
});
