import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMemoryServer } from "postgres-memory-server";
import {
  FileTransferArgsSchema,
  InvocationSchema,
  ReceiptSchema,
  createId,
  type InvocationResult
} from "@adc/protocol";
import { MemoryStore } from "./memory-store.ts";
import { PostgresStore } from "./postgres-store.ts";
import { jsonBytes, storagePolicy } from "./storage-policy.ts";
import type { ArtifactRecord, DispatchRecord, Store, TransferRecord } from "./types.ts";

const epoch = new Date("2026-11-08T00:00:00Z");
const later = (ms: number) => new Date(epoch.getTime() + ms);
const hour = 60 * 60_000;
const day = 24 * hour;
const policy = storagePolicy();
let embedded: PostgresMemoryServer;
let databaseUrl: string;
const stores: Store[] = [];

beforeAll(async () => {
  embedded = await PostgresMemoryServer.create({
    database: "adc_storage",
    username: "adc_test",
    password: "adc_test"
  });
  databaseUrl = embedded.getUri();
}, 60_000);
afterAll(async () => {
  for (const store of stores) await store.close();
  await embedded?.stop();
});

async function fixture(kind: "memory" | "postgres", overrides = {}) {
  const store = kind === "memory" ? new MemoryStore() : new PostgresStore(databaseUrl);
  stores.push(store);
  store.configureStorage(storagePolicy(overrides));
  await store.migrate();
  if (kind === "postgres")
    await (store as PostgresStore).pool.query("TRUNCATE adc_accounts CASCADE");
  const accountId = `acct_${createId("inv").slice(4)}`;
  const nodeId = `node_${createId("inv").slice(4)}`;
  await store.putAccount({ accountId, ownerTokenHash: "test", createdAt: epoch.toISOString() });
  await store.putPairingCode({ codeHash: nodeId, accountId, expiresAt: later(hour).toISOString() });
  await store.pairNode({
    codeHash: nodeId,
    now: epoch,
    node: {
      nodeId,
      label: nodeId,
      publicKey: "test",
      platform: "linux",
      status: "active",
      createdAt: epoch.toISOString()
    }
  });
  const buildRecord = (write = false): DispatchRecord => {
    const invocation = InvocationSchema.parse({
      schemaVersion: "0.1",
      invocationId: createId("inv"),
      attemptId: createId("att"),
      accountId,
      actor: { type: "agent", id: "actor_storage" },
      target: { nodeId },
      authorization: { grantId: "grant_storage", rootIds: ["root_storage"] },
      tool: write ? "file.write" : "file.read",
      args: { rootId: "root_storage", path: "result.b64", ...(write ? { content: "source" } : {}) },
      ...(write ? { idempotencyKey: createId("inv") } : {}),
      issuedAt: epoch.toISOString(),
      expiresAt: later(hour).toISOString(),
      metadata: { source: "sdk" }
    });
    return {
      dispatchId: createId("dsp"),
      invocation,
      nodeId,
      status: "queued",
      policyDecision: {
        outcome: "allow",
        reasonCode: "allowed",
        explanation: "test",
        evaluatedLayers: [],
        profile: "workspace-write",
        decisionHash: `sha256:${"a".repeat(64)}`
      },
      createdAt: epoch.toISOString(),
      updatedAt: epoch.toISOString()
    };
  };
  const auditFor = (record: DispatchRecord) => ({
    eventId: createId("dsp"),
    accountId,
    invocationId: record.invocation.invocationId,
    type: "dispatch.queued",
    payload: {},
    createdAt: epoch.toISOString()
  });
  const queue = async (write = false) => {
    const record = buildRecord(write);
    await store.enqueue(record, auditFor(record));
    const claimed = await store.claim(nodeId, epoch, hour);
    expect(claimed?.dispatchId).toBe(record.dispatchId);
    return claimed!;
  };
  const finish = async (
    record: DispatchRecord,
    content = "payload",
    status: "succeeded" | "unknown_outcome" = "succeeded"
  ) => {
    const receipt =
      record.invocation.tool === "file.write"
        ? ReceiptSchema.parse({
            schemaVersion: "0.1",
            receiptId: createId("rcpt"),
            invocationId: record.invocation.invocationId,
            attemptId: record.invocation.attemptId,
            nodeId,
            tool: record.invocation.tool,
            terminalStatus: status,
            sideEffect: true,
            argsHash: `sha256:${"c".repeat(64)}`,
            policyDecisionHash: record.policyDecision.decisionHash,
            startedAt: epoch.toISOString(),
            completedAt: epoch.toISOString(),
            durationMs: 0,
            artifactRefs: []
          })
        : undefined;
    const result: InvocationResult = {
      schemaVersion: "0.1",
      invocationId: record.invocation.invocationId,
      attemptId: record.invocation.attemptId,
      status,
      output: { content },
      ...(status === "unknown_outcome"
        ? { error: { code: "unknown_outcome", message: "Reconcile effect", retryable: false } }
        : {}),
      ...(receipt ? { receipt } : {})
    };
    await store.complete(record.dispatchId, record.leaseToken!, result, receipt, epoch);
    return receipt;
  };
  const artifact = (record: DispatchRecord, content = "shared pixels"): ArtifactRecord => {
    const data = Buffer.from(content);
    return {
      artifactId: `artifact_${randomBytes(16).toString("hex")}.png`,
      accountId,
      nodeId,
      invocationId: record.invocation.invocationId,
      contentType: "image/png",
      sha256: `sha256:${createHash("sha256").update(data).digest("hex")}`,
      byteSize: data.length,
      data,
      createdAt: epoch.toISOString()
    };
  };
  return { store, queue, buildRecord, auditFor, finish, artifact, accountId };
}

for (const kind of ["memory", "postgres"] as const) {
  describe(`storage lifecycle (${kind})`, () => {
    it("starts grace only after acknowledgment and does not extend it on duplicate acknowledgments", async () => {
      const { store, queue, finish } = await fixture(kind);
      const record = await queue();
      await finish(record);
      await store.maintainStorage(later(hour));
      expect((await store.getDispatchById(record.dispatchId))?.result?.output).toEqual({
        content: "payload"
      });
      await store.acknowledgeResult(record.invocation.invocationId, later(hour));
      await store.acknowledgeResult(record.invocation.invocationId, later(hour + 5 * 60_000));
      await store.maintainStorage(later(hour + policy.deliveryGraceMs - 1));
      expect((await store.getDispatchById(record.dispatchId))?.result?.output).toEqual({
        content: "payload"
      });
      await store.maintainStorage(later(hour + policy.deliveryGraceMs));
      expect(await store.getDispatchById(record.dispatchId)).toMatchObject({
        status: "succeeded",
        updatedAt: epoch.toISOString(),
        result: { output: { contentRetired: true, contentRetiredReason: "expired" } }
      });
    });

    it("expires unconsumed bodies after 24h and protects active artifacts independently of task age", async () => {
      const { store, queue, finish, artifact } = await fixture(kind);
      const completed = await queue();
      await finish(completed);
      const active = await queue();
      const asset = artifact(active);
      await store.putArtifact(asset);
      await store.acknowledgeArtifact(asset.artifactId, epoch);
      await store.maintainStorage(later(90 * day));
      expect((await store.getDispatchById(completed.dispatchId))?.result?.output).toMatchObject({
        contentRetired: true
      });
      expect((await store.getArtifact(asset.artifactId))?.retiredAt).toBeUndefined();
      expect(await store.hasLiveArtifact(asset.sha256)).toBe(true);
      expect((await store.getDispatchById(active.dispatchId))?.invocation.args).toEqual(
        active.invocation.args
      );
    });

    it("keeps receipts and deduplication after request details and summaries expire", async () => {
      const { store, queue, finish, accountId } = await fixture(kind);
      const record = await queue(true);
      const receipt = await finish(record, "output", "unknown_outcome");
      await store.maintainStorage(later(31 * day));
      const retired = await store.getDispatchById(record.dispatchId);
      expect(retired?.invocation.args).not.toHaveProperty("content");
      expect(retired?.receipt).toEqual(receipt);
      expect(retired?.status).toBe("unknown_outcome");
      const duplicate = await store.enqueue(
        {
          ...record,
          dispatchId: createId("dsp"),
          invocation: {
            ...record.invocation,
            invocationId: createId("inv"),
            attemptId: createId("att")
          }
        },
        {
          eventId: createId("dsp"),
          accountId,
          type: "dispatch.queued",
          payload: {},
          createdAt: later(31 * day).toISOString()
        }
      );
      expect(duplicate.dispatchId).toBe(record.dispatchId);
      await expect(store.claim(record.nodeId, later(31 * day), hour)).resolves.toBeUndefined();
      await expect(
        store.enqueue(
          {
            ...record,
            dispatchId: createId("dsp"),
            invocation: {
              ...record.invocation,
              args: { ...(record.invocation.args as object), content: "changed" }
            }
          },
          {
            eventId: createId("dsp"),
            accountId,
            type: "dispatch.queued",
            payload: {},
            createdAt: epoch.toISOString()
          }
        )
      ).rejects.toMatchObject({ code: "conflict" });
    });

    it("protects shared content until every reference is retired and forbids resurrection", async () => {
      const { store, queue, finish, artifact } = await fixture(kind);
      const first = await queue();
      const second = await queue();
      const a = artifact(first);
      const b = artifact(second);
      await store.putArtifact(a);
      await store.putArtifact(b);
      await finish(first);
      await store.acknowledgeArtifact(a.artifactId, epoch);
      await store.maintainStorage(later(policy.deliveryGraceMs));
      expect((await store.getArtifact(a.artifactId))?.retiredAt).toBeDefined();
      expect(await store.hasLiveArtifact(a.sha256)).toBe(true);
      await expect(store.putArtifact(a)).rejects.toMatchObject({ code: "expired" });
      await finish(second);
      await store.maintainStorage(later(day));
      expect(await store.hasLiveArtifact(a.sha256)).toBe(false);
    });

    it("enforces cumulative quota atomically before persisting concurrent attachments", async () => {
      const { store, queue, artifact } = await fixture(kind, {
        accountBytes: 1000,
        globalBytes: 1200
      });
      const first = await queue(),
        second = await queue();
      let persisted = 0;
      const uploads = await Promise.allSettled(
        [first, second].map((record) =>
          store.putArtifact(artifact(record, "x".repeat(600)), async () => {
            persisted++;
          })
        )
      );
      expect(uploads.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(persisted).toBe(1);
      expect((await store.storageUsage(epoch)).temporaryBytes).toBeLessThanOrEqual(1000);
    });

    it("records terminal success and receipt even when a result exceeds the byte budget", async () => {
      const { store, queue, finish } = await fixture(kind, { maxResultBytes: 256 });
      const record = await queue(true);
      const receipt = await finish(record, "x".repeat(300));
      const persisted = await store.getDispatchById(record.dispatchId);
      expect(persisted).toMatchObject({
        status: "succeeded",
        receipt,
        result: { output: { contentRetired: true, contentRetiredReason: "size_exceeded" } }
      });
      const retry = await store.complete(
        record.dispatchId,
        record.leaseToken!,
        {
          schemaVersion: "0.1",
          invocationId: record.invocation.invocationId,
          attemptId: record.invocation.attemptId,
          status: "succeeded",
          output: { content: "replacement" }
        },
        receipt,
        later(hour)
      );
      expect(retry?.result).toEqual(persisted?.result);
    });

    it("admits compact UTF-8 JSON exactly at quota and rejects only the next admission", async () => {
      const { store, buildRecord, auditFor } = await fixture(kind);
      const first = buildRecord();
      first.invocation.args = { rootId: "root_storage", path: '中文\n"result"' };
      const bytes = jsonBytes(first.invocation.args);
      store.configureStorage(storagePolicy({ accountBytes: bytes * 2, globalBytes: bytes * 2 }));
      const second = buildRecord();
      second.invocation.args = first.invocation.args;
      await store.enqueue(first, auditFor(first));
      await store.enqueue(second, auditFor(second));
      expect((await store.storageUsage(epoch)).temporaryBytes).toBe(bytes * 2);
      const rejected = buildRecord();
      rejected.invocation.args = first.invocation.args;
      await expect(store.enqueue(rejected, auditFor(rejected))).rejects.toMatchObject({
        code: "invalid_request"
      });
      expect(await store.getDispatchById(rejected.dispatchId)).toBeUndefined();
    });

    it("converts a pending approval without charging its input a second time", async () => {
      const { store, buildRecord, auditFor, accountId } = await fixture(kind);
      const record = buildRecord(true);
      const bytes = jsonBytes(record.invocation.args);
      store.configureStorage(storagePolicy({ accountBytes: bytes, globalBytes: bytes }));
      const approvalId = createId("dsp");
      await store.putApproval({
        approvalId,
        accountId,
        invocation: record.invocation,
        nodeId: record.nodeId,
        placementReason: "explicit approval",
        policyDecision: record.policyDecision,
        status: "pending",
        createdAt: epoch.toISOString(),
        expiresAt: later(hour).toISOString()
      });
      expect((await store.storageUsage(epoch)).temporaryBytes).toBe(bytes);
      await expect(
        store.approveAndEnqueue(approvalId, record, auditFor(record), epoch)
      ).resolves.toMatchObject({ dispatchId: record.dispatchId });
      expect((await store.storageUsage(epoch)).temporaryBytes).toBe(bytes);
      expect((await store.getApproval(approvalId))?.status).toBe("approved");
      expect((await store.claim(record.nodeId, epoch, hour))?.dispatchId).toBe(record.dispatchId);
    });

    it("rolls back all transfer dispatches on quota failure and allows the same transfer to retry", async () => {
      const { store, buildRecord, auditFor, accountId } = await fixture(kind);
      const first = buildRecord(),
        second = buildRecord();
      const destination = (await store.getNode(first.nodeId))!;
      second.nodeId = `${first.nodeId}_dest`;
      second.invocation.target = { nodeId: second.nodeId };
      await store.putPairingCode({
        codeHash: second.nodeId,
        accountId,
        expiresAt: later(hour).toISOString()
      });
      await store.pairNode({
        codeHash: second.nodeId,
        now: epoch,
        node: { ...destination, nodeId: second.nodeId }
      });
      const transferArgs = FileTransferArgsSchema.parse({
        source: { nodeId: first.nodeId, rootId: "root_storage", path: "source.bin" },
        destination: { nodeId: second.nodeId, rootId: "root_storage", path: "target.bin" }
      });
      const transfer: TransferRecord = {
        transferId: createId("dsp"),
        invocation: InvocationSchema.parse({
          ...buildRecord(true).invocation,
          tool: "file.transfer",
          args: transferArgs
        }),
        args: transferArgs,
        status: "queued",
        sourceDispatchId: first.dispatchId,
        destinationDispatchId: second.dispatchId,
        bytesTransferred: 0,
        createdAt: epoch.toISOString(),
        updatedAt: epoch.toISOString()
      };
      const bytes = jsonBytes(first.invocation.args);
      store.configureStorage(storagePolicy({ accountBytes: bytes, globalBytes: bytes }));
      const audits = [auditFor(first), auditFor(second)];
      await expect(store.createTransfer(transfer, [first, second], audits)).rejects.toMatchObject({
        code: "invalid_request"
      });
      expect(await store.getTransferByInvocation(transfer.invocation.invocationId)).toBeUndefined();
      expect(
        await store.getTransferByIdempotency(
          accountId,
          transfer.invocation.actor.id,
          transfer.invocation.idempotencyKey!
        )
      ).toBeUndefined();
      expect(await store.getDispatchById(first.dispatchId)).toBeUndefined();
      expect(await store.getDispatchById(second.dispatchId)).toBeUndefined();
      expect(await store.listAudit(accountId)).toEqual([]);
      expect(await store.claim(first.nodeId, epoch, hour)).toBeUndefined();
      store.configureStorage(storagePolicy());
      await store.createTransfer(transfer, [first, second], audits);
      expect(await store.getTransferByDispatch(first.dispatchId)).toMatchObject({
        transferId: transfer.transferId
      });
      expect((await store.claim(first.nodeId, epoch, hour))?.dispatchId).toBe(first.dispatchId);
    });
  });
}

it("backfills legacy terminal payloads in bounded PostgreSQL batches", async () => {
  const { store, queue, finish } = await fixture("postgres", { batchSize: 1 });
  const first = await queue(),
    second = await queue();
  await finish(first);
  await finish(second);
  const pg = store as PostgresStore;
  await pg.pool.query(
    "UPDATE adc_dispatches SET result_bytes = 0, result_expires_at = NULL, result_initialized = false WHERE account_id = $1",
    [first.invocation.accountId]
  );
  expect((await pg.storageUsage(epoch)).temporaryBytes).toBeGreaterThan(0);
  const retired = await pg.maintainStorage(later(2 * day));
  expect(retired.results).toBe(1);
  await pg.maintainStorage(later(2 * day));
  for (const record of [first, second]) {
    expect(await pg.getDispatchById(record.dispatchId)).toMatchObject({
      status: "succeeded",
      updatedAt: epoch.toISOString(),
      result: { output: { contentRetired: true, sha256: expect.stringMatching(/^sha256:/) } }
    });
  }
});

it("initializes a legacy result acknowledged before the janitor and retains its original expiry", async () => {
  const { store, queue, finish } = await fixture("postgres");
  const record = await queue();
  await finish(record, '中文\n"legacy payload"');
  const pg = store as PostgresStore;
  const {
    rows: [original]
  } = await pg.pool.query(
    `UPDATE adc_dispatches SET result_bytes = 0, result_sha256 = NULL,
      result_initialized = false, result_expires_at = NULL WHERE dispatch_id = $1
      RETURNING octet_length((result->'output')::text)::int AS bytes,
      'sha256:' || encode(sha256(convert_to((result->'output')::text, 'UTF8')), 'hex') AS hash`,
    [record.dispatchId]
  );
  await pg.acknowledgeResult(record.invocation.invocationId, later(23 * hour + 59 * 60_000));
  const {
    rows: [initialized]
  } = await pg.pool.query(
    "SELECT result_bytes::int AS bytes, result_sha256 AS hash, result_expires_at FROM adc_dispatches WHERE dispatch_id = $1",
    [record.dispatchId]
  );
  expect(initialized.bytes).toBe(original.bytes);
  expect(initialized.hash).toBe(original.hash);
  expect(initialized.result_expires_at.toISOString()).toBe(later(day).toISOString());
  await pg.maintainStorage(later(day));
  expect((await pg.getDispatchById(record.dispatchId))?.result?.output).toMatchObject({
    contentRetired: true,
    byteSize: original.bytes,
    sha256: original.hash
  });
});

it("orders uploads after account locks so revocation can lock a dispatch without deadlocking", async () => {
  const { store, queue, artifact, accountId } = await fixture("postgres");
  const record = await queue();
  const pg = store as PostgresStore;
  const revocation = await pg.pool.connect();
  let upload: Promise<void> | undefined;
  try {
    await revocation.query("BEGIN");
    await revocation.query("SET LOCAL statement_timeout = '2s'");
    await revocation.query("SELECT 1 FROM adc_accounts WHERE account_id = $1 FOR UPDATE", [
      accountId
    ]);
    upload = pg.putArtifact(artifact(record));
    // Observe the waiting SQL transaction; no wall-clock sleep or timing guess.
    await expect
      .poll(
        async () => {
          const { rows } = await pg.pool.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active' AND pid <> pg_backend_pid()"
          );
          return rows[0].count;
        },
        { timeout: 1500 }
      )
      .toBeGreaterThan(0);
    await revocation.query("SELECT 1 FROM adc_dispatches WHERE dispatch_id = $1 FOR UPDATE", [
      record.dispatchId
    ]);
  } finally {
    await revocation.query("ROLLBACK");
    revocation.release();
    await upload;
  }
});

it.each(["enqueue", "approval", "approve"] as const)(
  "sorts both collaboration accounts before %s admission while revocation holds the resource account",
  async (operation) => {
    const { store, buildRecord, auditFor, accountId } = await fixture("postgres");
    const pg = store as PostgresStore;
    const record = buildRecord();
    const resourceAccountId = "acct_000_storage";
    expect(resourceAccountId < accountId).toBe(true);
    await pg.putAccount({
      accountId: resourceAccountId,
      ownerTokenHash: "test",
      createdAt: epoch.toISOString()
    });
    await pg.pool.query("UPDATE adc_nodes SET account_id = $2 WHERE node_id = $1", [
      record.nodeId,
      resourceAccountId
    ]);
    await pg.putGrant({
      grantId: record.invocation.authorization.grantId,
      accountId,
      actorId: record.invocation.actor.id,
      responsibleUserId: "storage-user",
      profile: "read-only",
      nodeIds: [record.nodeId],
      rootIds: ["root_storage"],
      allowedTools: ["file.read"],
      createdAt: epoch.toISOString()
    });
    record.invocation = InvocationSchema.parse({
      ...record.invocation,
      delegation: {
        version: 1,
        requesterAccountId: accountId,
        requesterUserId: "storage-user",
        resourceAccountId,
        grantRevision: 1,
        scope: { roots: [], allowedTools: ["file.read"] },
        expiresAt: new Date(Date.now() + day).toISOString()
      }
    });
    const approval = {
      approvalId: createId("dsp"),
      accountId,
      invocation: record.invocation,
      nodeId: record.nodeId,
      placementReason: "collaboration",
      policyDecision: record.policyDecision,
      status: "pending" as const,
      createdAt: epoch.toISOString(),
      expiresAt: later(hour).toISOString()
    };
    if (operation === "approve") await pg.putApproval(approval);
    const revocation = await pg.pool.connect();
    let admission: Promise<unknown> | undefined;
    try {
      await revocation.query("BEGIN");
      await revocation.query("SET LOCAL statement_timeout = '2s'");
      await revocation.query("SELECT 1 FROM adc_accounts WHERE account_id = $1 FOR UPDATE", [
        resourceAccountId
      ]);
      admission =
        operation === "enqueue"
          ? pg.enqueue(record, auditFor(record))
          : operation === "approval"
            ? pg.putApproval(approval)
            : pg.approveAndEnqueue(approval.approvalId, record, auditFor(record), epoch);
      await expect
        .poll(
          async () => {
            const { rows } = await pg.pool.query(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active' AND pid <> pg_backend_pid()"
            );
            return rows[0].count;
          },
          { timeout: 1500 }
        )
        .toBeGreaterThan(0);
      // Same account order as real collaboration revocation. Must not wait on the requester.
      await revocation.query("SELECT 1 FROM adc_accounts WHERE account_id = $1 FOR UPDATE", [
        accountId
      ]);
    } finally {
      await revocation.query("ROLLBACK");
      revocation.release();
      await admission;
    }
    if (operation === "approval") {
      expect((await pg.getApproval(approval.approvalId))?.status).toBe("pending");
    } else {
      expect((await pg.getDispatchById(record.dispatchId))?.status).toBe("queued");
    }
  }
);

it.each([day - 60_000, 2 * day])(
  "never extends a legacy artifact's terminal TTL when acknowledged at %i ms",
  async (age) => {
    const { store, queue, finish, artifact } = await fixture("postgres");
    const pg = store as PostgresStore;
    const record = await queue();
    const asset = artifact(record);
    await pg.putArtifact(asset);
    await finish(record);
    await pg.pool.query("UPDATE adc_artifacts SET expires_at = NULL WHERE artifact_id = $1", [
      asset.artifactId
    ]);
    await pg.acknowledgeArtifact(asset.artifactId, later(age));
    expect((await pg.getArtifact(asset.artifactId))?.expiresAt).toBe(later(day).toISOString());
    await pg.maintainStorage(later(Math.max(day, age)));
    expect((await pg.getArtifact(asset.artifactId))?.retiredAt).toBeDefined();
  }
);

it.each(["complete", "artifact"] as const)(
  "allows grant deletion to finish its audit while delegated %s waits for the dispatch",
  async (operation) => {
    const { store, buildRecord, auditFor, artifact, accountId } = await fixture("postgres");
    const pg = store as PostgresStore;
    const record = buildRecord();
    const resourceAccountId = "acct_000_storage";
    await pg.putAccount({
      accountId: resourceAccountId,
      ownerTokenHash: "test",
      createdAt: epoch.toISOString()
    });
    await pg.pool.query("UPDATE adc_nodes SET account_id = $2 WHERE node_id = $1", [
      record.nodeId,
      resourceAccountId
    ]);
    await pg.putGrant({
      grantId: record.invocation.authorization.grantId,
      accountId,
      actorId: record.invocation.actor.id,
      responsibleUserId: "storage-user",
      profile: "read-only",
      nodeIds: [record.nodeId],
      rootIds: ["root_storage"],
      allowedTools: ["file.read"],
      createdAt: epoch.toISOString()
    });
    record.invocation = InvocationSchema.parse({
      ...record.invocation,
      delegation: {
        version: 1,
        requesterAccountId: accountId,
        requesterUserId: "storage-user",
        resourceAccountId,
        grantRevision: 1,
        scope: { roots: [], allowedTools: ["file.read"] },
        expiresAt: new Date(Date.now() + day).toISOString()
      }
    });
    await pg.enqueue(record, auditFor(record));
    const claimed = (await pg.claim(record.nodeId, epoch, hour))!;
    await pg.acknowledge(record.dispatchId, claimed.leaseToken!, epoch);
    const asset = artifact(claimed);
    // A database trigger gates the real audit INSERT after deleteGrant has locked
    // the dispatch. The test does not substitute either operation or its SQL.
    await pg.pool.query(`CREATE FUNCTION adc_test_audit_gate() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'grant.deleted' THEN
          PERFORM pg_advisory_xact_lock(728194039);
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await pg.pool.query(`CREATE TRIGGER adc_test_audit_gate BEFORE INSERT ON adc_audit_events
      FOR EACH ROW EXECUTE FUNCTION adc_test_audit_gate()`);
    const gate = await pg.pool.connect();
    let deletion: Promise<void> | undefined, delivery: Promise<unknown> | undefined;
    try {
      await gate.query("SELECT pg_advisory_lock(728194039)");
      deletion = pg.deleteGrant(accountId, record.invocation.authorization.grantId, 1, {
        ...auditFor(record),
        type: "grant.deleted"
      });
      await expect
        .poll(
          async () => {
            const { rows } = await pg.pool.query(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%INSERT INTO adc_audit_events%'"
            );
            return rows[0].count;
          },
          { timeout: 1500 }
        )
        .toBeGreaterThan(0);
      delivery =
        operation === "artifact"
          ? pg.putArtifact(asset)
          : pg.complete(
              record.dispatchId,
              claimed.leaseToken!,
              {
                schemaVersion: "0.1",
                invocationId: record.invocation.invocationId,
                attemptId: record.invocation.attemptId,
                status: "succeeded",
                output: "delivered"
              },
              undefined,
              epoch
            );
      await expect
        .poll(
          async () => {
            const { rows } = await pg.pool.query(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SELECT * FROM adc_dispatches%FOR UPDATE%'"
            );
            return rows[0].count;
          },
          { timeout: 1500 }
        )
        .toBeGreaterThan(0);
    } finally {
      await gate.query("SELECT pg_advisory_unlock(728194039)");
      gate.release();
      const outcomes = await Promise.allSettled([deletion, delivery]);
      await pg.pool.query("DROP TRIGGER adc_test_audit_gate ON adc_audit_events");
      await pg.pool.query("DROP FUNCTION adc_test_audit_gate()");
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    }
    expect((await pg.getGrant(record.invocation.authorization.grantId))?.deletedAt).toBeDefined();
    if (operation === "artifact") expect(await pg.getArtifact(asset.artifactId)).toBeDefined();
    else expect((await pg.getDispatchById(record.dispatchId))?.status).toBe("succeeded");
  }
);
