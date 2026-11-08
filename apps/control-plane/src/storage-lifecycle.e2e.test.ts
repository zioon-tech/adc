import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { AdcClient } from "@adc/client";
import { InvocationSchema, ReceiptSchema, createId } from "@adc/protocol";
import {
  MemoryStore,
  PostgresStore,
  storagePolicy,
  type DispatchRecord,
  type Store
} from "@adc/db";
import { createMcpServer } from "@adc/mcp-adapter";
import { createControlPlane } from "./app.ts";
import { LocalContentAddressedAssetStore } from "./asset-store.ts";
import { accessFixture } from "../../../tests/helpers/access-fixture.ts";
import { createPostgresFixture } from "../../../tests/helpers/postgres-fixture.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const epoch = new Date("2026-11-08T00:00:00Z");
const minute = 60_000;

async function fixture(
  intervalMs = minute,
  status: "succeeded" | "unknown_outcome" = "succeeded",
  store: Store = new MemoryStore()
) {
  const assets = new Map<string, Buffer>();
  let clock = epoch;
  let beforeAssetRead: (() => Promise<void>) | undefined;
  const app = await createControlPlane({
    store,
    now: () => clock,
    storagePolicy: { intervalMs },
    access: accessFixture({
      cookie: "adc.session_token=storage-test",
      agents: {
        "storage-agent": { accountId: "acct_primary", grantId: "grant_storage" },
        "other-agent": { accountId: "acct_primary", grantId: "grant_other" }
      }
    }),
    assetStore: {
      async put(hash, data) {
        assets.set(hash, Buffer.from(data));
      },
      async get(hash) {
        await beforeAssetRead?.();
        return Buffer.from(assets.get(hash)!);
      }
    }
  });
  cleanups.push(() => app.close());
  await store.putAccount({
    accountId: "acct_primary",
    ownerTokenHash: "test",
    createdAt: epoch.toISOString()
  });
  await store.putPairingCode({
    codeHash: "storage-node",
    accountId: "acct_primary",
    expiresAt: new Date(epoch.getTime() + minute).toISOString()
  });
  await store.pairNode({
    codeHash: "storage-node",
    now: epoch,
    node: {
      nodeId: "node_storage",
      label: "Storage test node",
      publicKey: "test",
      platform: "linux",
      status: "active",
      createdAt: epoch.toISOString()
    }
  });
  await store.putGrant({
    grantId: "grant_storage",
    accountId: "acct_primary",
    actorId: "actor_storage",
    profile: "workspace-write",
    nodeIds: ["node_storage"],
    rootIds: ["root_storage"],
    allowedTools: ["file.read", "file.write", "task.result", "task.wait"],
    createdAt: epoch.toISOString()
  });
  const record: DispatchRecord = {
    dispatchId: createId("dsp"),
    nodeId: "node_storage",
    status: "queued",
    invocation: InvocationSchema.parse({
      schemaVersion: "0.1",
      invocationId: createId("inv"),
      attemptId: createId("att"),
      accountId: "acct_primary",
      actor: { type: "agent", id: "actor_storage" },
      authorization: { grantId: "grant_storage", rootIds: ["root_storage"] },
      target: { nodeId: "node_storage" },
      tool: status === "unknown_outcome" ? "file.write" : "file.read",
      args: {
        rootId: "root_storage",
        path: "result.b64",
        ...(status === "unknown_outcome" ? { content: "source" } : {})
      },
      ...(status === "unknown_outcome" ? { idempotencyKey: createId("inv") } : {}),
      issuedAt: epoch.toISOString(),
      expiresAt: new Date(epoch.getTime() + minute).toISOString(),
      metadata: { source: "sdk" }
    }),
    policyDecision: {
      outcome: "allow",
      reasonCode: "test",
      explanation: "test",
      evaluatedLayers: [],
      profile: "read-only",
      decisionHash: `sha256:${"a".repeat(64)}`
    },
    createdAt: epoch.toISOString(),
    updatedAt: epoch.toISOString()
  };
  await store.enqueue(record, {
    eventId: createId("dsp"),
    accountId: "acct_primary",
    type: "dispatch.queued",
    payload: {},
    createdAt: epoch.toISOString()
  });
  const claimed = (await store.claim("node_storage", epoch, minute))!;
  const data = Buffer.from("image pixels");
  const artifactId = `artifact_${randomBytes(16).toString("hex")}.png`;
  const sha256 = `sha256:${createHash("sha256").update(data).digest("hex")}`;
  assets.set(sha256, data);
  await store.putArtifact({
    artifactId,
    accountId: "acct_primary",
    invocationId: record.invocation.invocationId,
    nodeId: "node_storage",
    contentType: "image/png",
    sha256,
    byteSize: data.length,
    data: Buffer.alloc(0),
    createdAt: epoch.toISOString()
  });
  const receipt =
    status === "unknown_outcome"
      ? ReceiptSchema.parse({
          schemaVersion: "0.1",
          receiptId: createId("rcpt"),
          invocationId: record.invocation.invocationId,
          attemptId: record.invocation.attemptId,
          nodeId: record.nodeId,
          tool: record.invocation.tool,
          terminalStatus: status,
          sideEffect: true,
          argsHash: `sha256:${"b".repeat(64)}`,
          policyDecisionHash: record.policyDecision.decisionHash,
          startedAt: epoch.toISOString(),
          completedAt: epoch.toISOString(),
          durationMs: 0,
          artifactRefs: []
        })
      : undefined;
  await store.complete(
    record.dispatchId,
    claimed.leaseToken!,
    {
      schemaVersion: "0.1",
      invocationId: record.invocation.invocationId,
      attemptId: record.invocation.attemptId,
      status,
      output: { artifactId, content: "large result" },
      ...(receipt
        ? {
            receipt,
            error: { code: "unknown_outcome", message: "Reconcile effect", retryable: false }
          }
        : {})
    },
    receipt,
    epoch
  );
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const response = await app.inject({
      method: (init.method ?? "GET") as "GET" | "POST",
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(typeof init.body === "string" ? { payload: init.body } : {})
    });
    return new Response(new Uint8Array(response.rawPayload), {
      status: response.statusCode,
      headers: response.headers as Record<string, string>
    });
  };
  const client = new AdcClient("http://adc.test", "storage-agent", fetcher);
  return {
    store,
    app,
    client,
    record,
    receipt,
    data,
    artifactId,
    sha256,
    beforeRead: (callback: () => Promise<void>) => {
      beforeAssetRead = callback;
    },
    advance: (ms: number) => {
      clock = new Date(epoch.getTime() + ms);
    }
  };
}

it("validates consumed bytes, protects authorization, and returns explicit HTTP 410 for expired images", async () => {
  const { app, client, store, record, data, artifactId, sha256, advance } = await fixture();
  expect(await client.artifact(artifactId)).toEqual(new Uint8Array(data));
  const wrong = await app.inject({
    method: "POST",
    url: `/api/v1/artifacts/${artifactId}/consumed`,
    headers: { authorization: "Bearer storage-agent" },
    payload: { byteSize: data.length, sha256: "wrong" }
  });
  expect(wrong.statusCode).toBe(409);
  const denied = await app.inject({
    method: "POST",
    url: `/api/v1/artifacts/${artifactId}/consumed`,
    headers: { authorization: "Bearer other-agent" },
    payload: { byteSize: data.length, sha256 }
  });
  expect(denied.statusCode).toBe(404);
  await client.acknowledgeArtifact(artifactId, data);
  await client.acknowledgeResult(record.invocation.invocationId);
  advance(storagePolicy().deliveryGraceMs);
  // Expiry is enforced at reads even if the periodic janitor is backlogged.
  const expired = await app.inject({
    url: `/api/v1/artifacts/${artifactId}`,
    headers: { authorization: "Bearer storage-agent" }
  });
  expect(expired.statusCode).toBe(410);
  expect(expired.json().error.code).toBe("expired");
  const result = await client.invocationStatus(record.invocation.invocationId);
  expect(result).toMatchObject({ status: "succeeded", output: { contentRetired: true } });
  await store.maintainStorage(new Date(epoch.getTime() + storagePolicy().deliveryGraceMs));
  expect((await store.getArtifact(artifactId))?.retiredAt).toBeDefined();
});

it("allows result consumption through a task-only grant after original tool permission is removed", async () => {
  const { store, client, record } = await fixture();
  const grant = (await store.getGrant("grant_storage"))!;
  await store.putGrant({ ...grant, allowedTools: ["task.result"] });
  expect(await client.invocationStatus(record.invocation.invocationId)).toMatchObject({
    status: "succeeded"
  });
  await expect(client.acknowledgeResult(record.invocation.invocationId)).resolves.toBeUndefined();
  expect((await store.getDispatchById(record.dispatchId))?.resultExpiresAt).toBe(
    new Date(epoch.getTime() + storagePolicy().deliveryGraceMs).toISOString()
  );
});

it("returns the independent unknown-outcome receipt after all temporary details retire", async () => {
  const { store, client, record, receipt, advance } = await fixture(minute, "unknown_outcome");
  const age = 31 * 24 * 60 * minute;
  advance(age);
  await store.maintainStorage(new Date(epoch.getTime() + age));
  expect(await client.invocationStatus(record.invocation.invocationId)).toMatchObject({
    status: "unknown_outcome",
    receipt,
    error: { code: "unknown_outcome", retryable: false },
    output: { contentRetired: true }
  });
  expect((await store.getDispatchById(record.dispatchId))?.invocation.args).not.toHaveProperty(
    "content"
  );
});

it("rejects old image content before legacy expiry metadata is backfilled", async () => {
  const { store, app, artifactId, advance } = await fixture();
  const getArtifact = store.getArtifact.bind(store);
  // Legacy rows from pre-0017 storage have no deadline until their bounded batch runs.
  store.getArtifact = async (id) => {
    const artifact = await getArtifact(id);
    if (artifact) delete artifact.expiresAt;
    return artifact;
  };
  advance(24 * 60 * minute);
  const response = await app.inject({
    url: `/api/v1/artifacts/${artifactId}`,
    headers: { authorization: "Bearer storage-agent" }
  });
  expect(response.statusCode).toBe(410);
  expect(response.json().error.code).toBe("expired");
});

it("keeps an expired legacy PostgreSQL image unavailable after a late valid consumption acknowledgment", async () => {
  const embedded = await createPostgresFixture("adc_delivery");
  cleanups.push(() => embedded.stop());
  const pg = new PostgresStore(embedded.databaseUrl);
  const { app, client, artifactId, data, advance } = await fixture(minute, "succeeded", pg);
  await pg.pool.query("UPDATE adc_artifacts SET expires_at = NULL WHERE artifact_id = $1", [
    artifactId
  ]);
  advance(48 * 60 * minute);
  const read = () =>
    app.inject({
      url: `/api/v1/artifacts/${artifactId}`,
      headers: { authorization: "Bearer storage-agent" }
    });
  expect((await read()).statusCode).toBe(410);
  await client.acknowledgeArtifact(artifactId, data);
  expect((await read()).statusCode).toBe(410);
  expect((await pg.getArtifact(artifactId))?.expiresAt).toBe(
    new Date(epoch.getTime() + storagePolicy().temporaryTtlMs).toISOString()
  );
});

it("does not acknowledge externally prepared MCP content until explicit SDK consumption", async () => {
  const { store, client: adc, artifactId, data, record } = await fixture();
  const server = createMcpServer({
    client: adc,
    context: {
      accountId: "acct_primary",
      actorId: "actor_storage",
      grantId: "grant_storage",
      rootIds: ["root_storage"],
      nodeIds: ["node_storage"],
      allowedTools: ["task.result"]
    }
  });
  const mcp = new Client({ name: "storage-delivery-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  cleanups.push(() => server.close());
  cleanups.push(() => mcp.close());
  const response = await mcp.readResource({ uri: `adc://artifacts/${artifactId}` });
  expect(response.contents[0]).toMatchObject({ blob: data.toString("base64") });
  const toolResult = await mcp.callTool({
    name: "task.result",
    arguments: { args: { jobId: `job_${record.dispatchId.slice(4)}` } }
  });
  expect(toolResult.isError).toBe(false);
  expect(toolResult.structuredContent).toMatchObject({ output: { task: { status: "succeeded" } } });
  expect((await store.getArtifact(artifactId))?.consumedAt).toBeUndefined();
  expect((await store.getDispatchById(record.dispatchId))?.resultExpiresAt).toBe(
    new Date(epoch.getTime() + storagePolicy().temporaryTtlMs).toISOString()
  );
  await adc.acknowledgeArtifact(artifactId, data);
  expect((await store.getArtifact(artifactId))?.consumedAt).toBe(epoch.toISOString());
});

it("marks expired MCP task content as a delivery error while preserving terminal execution status", async () => {
  const { app, record, advance } = await fixture();
  advance(24 * 60 * minute);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(epoch.getTime() + 24 * 60 * minute));
  cleanups.push(async () => {
    vi.useRealTimers();
  });
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: "Bearer storage-agent",
      accept: "application/json, text/event-stream"
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "task.result",
        arguments: { args: { jobId: `job_${record.dispatchId.slice(4)}` } }
      }
    }
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().error).toBeUndefined();
  expect(response.json().result).toMatchObject({
    isError: true,
    structuredContent: {
      output: { task: { status: "succeeded", output: { contentRetired: true } } }
    }
  });
});

it("acknowledges hosted MCP resources only after a successful HTTP response finishes", async () => {
  const { store, app, artifactId, data } = await fixture();
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: "Bearer storage-agent",
      accept: "application/json, text/event-stream"
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: `adc://artifacts/${artifactId}` }
    }
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().result.contents[0].blob).toBe(data.toString("base64"));
  await expect
    .poll(async () => (await store.getArtifact(artifactId))?.consumedAt)
    .toBe(epoch.toISOString());
});

it("does not acknowledge a hosted MCP resource when its HTTP consumer disconnects", async () => {
  const { store, app, artifactId, beforeRead } = await fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  beforeRead(async () => {
    entered();
    await gate;
  });
  cleanups.push(async () => {
    release();
  });
  let disconnected!: () => void;
  const serverDisconnected = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/mcp") reply.raw.once("close", disconnected);
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const request = httpRequest(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer storage-agent",
      accept: "application/json, text/event-stream",
      "content-type": "application/json"
    }
  });
  request.on("error", () => {});
  const closed = new Promise<void>((resolve) => request.once("close", resolve));
  request.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: `adc://artifacts/${artifactId}` }
    })
  );
  await started;
  request.destroy();
  await closed;
  await serverDisconnected;
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect((await store.getArtifact(artifactId))?.consumedAt).toBeUndefined();
});

it("continues scheduled cleanup when no further invocations arrive", async () => {
  const { store, client, record, advance } = await fixture(10);
  await client.acknowledgeResult(record.invocation.invocationId);
  advance(storagePolicy().deliveryGraceMs);
  await expect
    .poll(async () => (await store.getDispatchById(record.dispatchId))?.result?.output, {
      timeout: 1000
    })
    .toMatchObject({ contentRetired: true });
});

it("collects old orphan files and temporary writes while preserving live shared hashes and reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adc-storage-gc-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const assets = new LocalContentAddressedAssetStore(directory);
  cleanups.push(() => assets.close());
  const store = new MemoryStore();
  const data = Buffer.from("orphan");
  const hash = `sha256:${createHash("sha256").update(data).digest("hex")}`;
  await store.withArtifactLock(hash, () => assets.put(hash, data));
  const path = join(directory, hash.slice(7, 9), hash.slice(7));
  await utimes(path, epoch, epoch);
  const temporary = join(directory, hash.slice(7, 9), `.${hash.slice(7)}.${"1".repeat(16)}.tmp`);
  await writeFile(temporary, "partial");
  await utimes(temporary, epoch, epoch);
  const liveData = Buffer.from("live shared image");
  const liveHash = `sha256:${createHash("sha256").update(liveData).digest("hex")}`;
  await assets.put(liveHash, liveData);
  await utimes(join(directory, liveHash.slice(7, 9), liveHash.slice(7)), epoch, epoch);
  await store.putArtifact({
    artifactId: `artifact_${randomBytes(16).toString("hex")}.png`,
    accountId: "acct_primary",
    invocationId: createId("inv"),
    nodeId: "node_storage",
    contentType: "image/png",
    sha256: liveHash,
    byteSize: liveData.length,
    data: Buffer.alloc(0),
    createdAt: epoch.toISOString()
  });
  let release!: () => void;
  let locked!: () => void;
  const lockedPromise = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = store.withArtifactLock(hash, async () => {
    locked();
    await hold;
    expect(await assets.get(hash)).toEqual(data);
  });
  await lockedPromise;
  const sweep = assets.sweep(
    new Date(),
    100,
    (sha256, operation) => store.withArtifactLock(sha256, operation),
    (sha256) => store.hasLiveArtifact(sha256)
  );
  release();
  await reading;
  expect(await sweep).toEqual({ files: 2, bytes: data.length + 7 });
  await expect(assets.get(hash)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await assets.get(liveHash)).toEqual(liveData);
});
