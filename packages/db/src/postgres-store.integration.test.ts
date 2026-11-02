import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMemoryServer } from "postgres-memory-server";
import {
  CapabilitySchema,
  FileTransferArgsSchema,
  InvocationSchema,
  createId
} from "@adc/protocol";
import { PostgresStore } from "./postgres-store.ts";
import type { AuditEvent, DispatchRecord, TransferRecord } from "./types.ts";

function dispatch(index: number): DispatchRecord {
  const now = new Date().toISOString();
  const invocation = InvocationSchema.parse({
    schemaVersion: "0.1",
    invocationId: createId("inv"),
    attemptId: createId("att"),
    accountId: "acct_primary",
    actor: { type: "agent", id: "actor_testagent" },
    target: { nodeId: "node_postgres" },
    authorization: {
      projectId: "proj_example",
      rootIds: ["root_workspace"],
      grantId: "grant_example"
    },
    tool: "file.read",
    args: { rootId: "root_workspace", path: `file-${index}.txt` },
    issuedAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    metadata: { source: "sdk" }
  });
  return {
    dispatchId: createId("dsp"),
    invocation,
    nodeId: "node_postgres",
    policyDecision: {
      outcome: "allow",
      reasonCode: "policy.allowed",
      explanation: "Allowed in integration test.",
      evaluatedLayers: ["account", "agent", "node", "root", "capability"],
      profile: "read-only",
      decisionHash: `sha256:${"a".repeat(64)}`
    },
    status: "queued",
    createdAt: now,
    updatedAt: now
  };
}

describe("PostgresStore", () => {
  let store: PostgresStore;
  let embedded: PostgresMemoryServer | undefined;
  let databaseUrl: string;

  it("persists Agent upload metadata, its single destination and cleanup checkpoint", async () => {
    const base = dispatch(99);
    const invocation = InvocationSchema.parse({
      ...base.invocation,
      tool: "file.transfer",
      idempotencyKey: "pg-agent-upload",
      args: {
        source: {
          kind: "agent",
          path: "source.bin",
          byteSize: 23,
          contentSha256: `sha256:${"b".repeat(64)}`
        },
        destination: { nodeId: "node_postgres", rootId: "root_workspace", path: "target.bin" }
      }
    });
    const child = { ...base, invocation };
    const transfer: TransferRecord = {
      transferId: "xfr_pg_agent",
      invocation,
      args: FileTransferArgsSchema.parse(invocation.args),
      status: "queued",
      bytesTransferred: 0,
      byteSize: 23,
      chunkCount: 1,
      contentSha256: `sha256:${"b".repeat(64)}`,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt
    };
    const persisted = await store.createTransfer(
      transfer,
      [child],
      [
        {
          eventId: createId("dsp"),
          accountId: "acct_primary",
          type: "dispatch.queued",
          payload: {},
          createdAt: base.createdAt
        }
      ]
    );
    expect(persisted).toMatchObject({
      byteSize: 23,
      chunkCount: 1,
      contentSha256: transfer.contentSha256,
      destinationDispatchId: child.dispatchId
    });
    expect(persisted.sourceDispatchId).toBeUndefined();
    const future = new Date(Date.now() + 2 * 60 * 60_000);
    expect(await store.listTransferCleanupCandidates(future, 100)).toContain(transfer.transferId);
    await store.markTransferCleaned(transfer.transferId);
    expect(await store.listTransferCleanupCandidates(future, 100)).not.toContain(
      transfer.transferId
    );
    await store.requestCancelTransfer(transfer.transferId, new Date());
  });

  beforeAll(async () => {
    databaseUrl =
      process.env.ADC_TEST_DATABASE_URL ??
      (await PostgresMemoryServer.create({
        database: "adc_test",
        username: "adc_test",
        password: "adc_test"
      }).then((server) => {
        embedded = server;
        return server.getUri();
      }));
    store = new PostgresStore(databaseUrl);
    await store.migrate();
    await store.pool.query(`
      TRUNCATE adc_node_nonces, adc_audit_events, adc_dispatches, adc_agent_grants,
        adc_roots, adc_projects, adc_nodes, adc_pairing_codes, adc_accounts CASCADE
    `);
    await store.putAccount({
      accountId: "acct_primary",
      ownerTokenHash: "hash",
      createdAt: new Date().toISOString()
    });
    await store.putPairingCode({
      codeHash: "pair-code",
      accountId: "acct_primary",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await store.pairNode({
      codeHash: "pair-code",
      now: new Date(),
      node: {
        nodeId: "node_postgres",
        accountId: "acct_primary",
        label: "postgres-node",
        publicKey: "test-key",
        platform: "linux",
        status: "active",
        createdAt: new Date().toISOString()
      }
    });
    await store.putProject({
      projectId: "proj_example",
      accountId: "acct_primary",
      label: "Example",
      createdAt: new Date().toISOString()
    });
    await store.putRoot({
      rootId: "root_workspace",
      projectId: "proj_example",
      nodeId: "node_postgres",
      label: "Workspace",
      writable: true,
      createdAt: new Date().toISOString()
    });
    await store.putGrant({
      grantId: "grant_example",
      accountId: "acct_primary",
      actorId: "actor_testagent",
      profile: "workspace-write",
      nodeIds: ["node_postgres"],
      rootIds: ["root_workspace"],
      allowedTools: ["file.read", "file.write"],
      createdAt: new Date().toISOString()
    });
  });

  afterAll(async () => {
    await store.close();
    await embedded?.stop();
  });

  it("admits only eight concurrent account transfers and releases cancelled slots", async () => {
    const transfers = Array.from({ length: 12 }, (_, index): TransferRecord => {
      const base = dispatch(200 + index);
      const invocation = InvocationSchema.parse({
        ...base.invocation,
        tool: "file.transfer",
        idempotencyKey: `quota-transfer-${index}`,
        args: {
          source: {
            kind: "agent",
            path: "source.bin",
            byteSize: 1,
            contentSha256: `sha256:${"b".repeat(64)}`
          },
          destination: { nodeId: "node_postgres", rootId: "root_workspace", path: `quota-${index}` }
        }
      });
      return {
        transferId: createId("xfr"),
        invocation,
        args: FileTransferArgsSchema.parse(invocation.args),
        status: "queued",
        bytesTransferred: 0,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt
      };
    });
    const admitted = await Promise.allSettled(
      transfers.map((transfer) => store.createTransfer(transfer, [], []))
    );
    const accepted = admitted.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );
    expect(accepted).toHaveLength(8);
    for (const result of admitted) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "conflict", retryable: true });
      }
    }
    expect(await store.createTransfer(accepted[0]!, [], [])).toMatchObject({
      transferId: accepted[0]!.transferId
    });
    for (const transfer of accepted) {
      await store.requestCancelTransfer(transfer.transferId, new Date());
    }
    expect(await store.createTransfer(transfers[11]!, [], [])).toMatchObject({
      transferId: transfers[11]!.transferId
    });
    await store.requestCancelTransfer(transfers[11]!.transferId, new Date());
  });

  it("stores Windows nodes after the platform constraint migration", async () => {
    await store.putPairingCode({
      codeHash: "pair-windows",
      accountId: "acct_primary",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await expect(
      store.pairNode({
        codeHash: "pair-windows",
        now: new Date(),
        node: {
          nodeId: "node_windows",
          label: "windows-node",
          publicKey: "windows-key",
          platform: "win32",
          status: "active",
          createdAt: new Date().toISOString()
        }
      })
    ).resolves.toMatchObject({ node: { platform: "win32" } });
  });

  it("stores Android nodes after the platform constraint migration", async () => {
    await store.putPairingCode({
      codeHash: "pair-android",
      accountId: "acct_primary",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await expect(
      store.pairNode({
        codeHash: "pair-android",
        now: new Date(),
        node: {
          nodeId: "node_android",
          label: "android-node",
          publicKey: "android-key",
          platform: "android",
          status: "active",
          createdAt: new Date().toISOString()
        }
      })
    ).resolves.toMatchObject({ node: { platform: "android" } });
  });

  it("reports nodes replaced during same-label pairing", async () => {
    const now = new Date();
    await store.putPairingCode({
      codeHash: "replace-old",
      accountId: "acct_primary",
      expiresAt: new Date(now.getTime() + 60_000).toISOString()
    });
    await store.pairNode({
      codeHash: "replace-old",
      now,
      node: {
        nodeId: "node_replace_old",
        label: "replace-me",
        publicKey: "old-key",
        platform: "linux",
        status: "active",
        createdAt: now.toISOString()
      }
    });
    await store.putPairingCode({
      codeHash: "replace-new",
      accountId: "acct_primary",
      expiresAt: new Date(now.getTime() + 60_000).toISOString()
    });

    await expect(
      store.pairNode({
        codeHash: "replace-new",
        now,
        node: {
          nodeId: "node_replace_new",
          label: "replace-me",
          publicKey: "new-key",
          platform: "linux",
          status: "active",
          createdAt: now.toISOString()
        }
      })
    ).resolves.toMatchObject({
      node: { nodeId: "node_replace_new" },
      replacedNodeIds: ["node_replace_old"]
    });
  });

  it("keeps presence and capability updates monotonic", async () => {
    const capability = (nodeVersion: string) =>
      CapabilitySchema.parse({
        schemaVersion: "0.1",
        nodeId: "node_postgres",
        tools: [],
        roots: [],
        platform: "linux",
        nodeVersion,
        advertisedAt: "2026-09-24T00:00:00.000Z"
      });
    await store.updateNodePresence(
      "node_postgres",
      capability("new"),
      new Date("2026-09-24T00:03:00.000Z")
    );
    await store.updateNodePresence(
      "node_postgres",
      capability("old"),
      new Date("2026-09-24T00:02:00.000Z")
    );
    await store.rotateNodeKey("node_postgres", "new-key", new Date("2026-09-24T00:02:30.000Z"));

    await expect(store.getNode("node_postgres")).resolves.toMatchObject({
      lastSeenAt: "2026-09-24T00:03:00.000Z",
      capability: { nodeVersion: "new" },
      publicKey: "new-key"
    });
  });

  it("claims queued work once across concurrent pollers", async () => {
    const first = dispatch(1);
    const second = dispatch(2);
    for (const item of [first, second]) {
      await store.enqueue(item, {
        eventId: createId("dsp"),
        accountId: "acct_primary",
        invocationId: item.invocation.invocationId,
        type: "dispatch.queued",
        payload: {},
        createdAt: item.createdAt
      });
    }
    const claims = await Promise.all([
      store.claim("node_postgres", new Date(), 30_000),
      store.claim("node_postgres", new Date(), 30_000)
    ]);
    expect(new Set(claims.map((claim) => claim?.dispatchId)).size).toBe(2);
    await expect(store.claim("node_postgres", new Date(), 30_000)).resolves.toBeUndefined();
  });

  it("retains dispatch and audit state across store instances", async () => {
    const item = dispatch(3);
    await store.enqueue(item, {
      eventId: createId("dsp"),
      accountId: "acct_primary",
      invocationId: item.invocation.invocationId,
      type: "dispatch.queued",
      payload: { persisted: true },
      createdAt: item.createdAt
    });
    await store.putArtifact({
      artifactId: "artifact_0123456789abcdef0123456789abcdef.log",
      accountId: "acct_primary",
      invocationId: item.invocation.invocationId,
      nodeId: "node_postgres",
      contentType: "text/plain",
      sha256: `sha256:${"b".repeat(64)}`,
      byteSize: Buffer.byteLength("artifact-body"),
      data: Buffer.from("artifact-body"),
      createdAt: item.createdAt
    });
    const restarted = new PostgresStore(databaseUrl!);
    try {
      await expect(restarted.getGrant("grant_example")).resolves.toMatchObject({
        nodeIds: ["node_postgres"],
        rootIds: ["root_workspace"],
        allowedTools: ["file.read", "file.write"]
      });
      await expect(restarted.getDispatchById(item.dispatchId)).resolves.toMatchObject({
        dispatchId: item.dispatchId,
        status: "queued"
      });
      await expect(
        restarted.listAudit("acct_primary", item.invocation.invocationId)
      ).resolves.toHaveLength(1);
      const artifact = await restarted.getArtifact("artifact_0123456789abcdef0123456789abcdef.log");
      expect(artifact?.byteSize).toBe(Buffer.byteLength("artifact-body"));
      expect(artifact?.data.toString("utf8")).toBe("artifact-body");
    } finally {
      await restarted.close();
    }
  });

  it("uses stable keyset pagination for filtered audit timelines", async () => {
    const createdAt = "2030-09-24T00:00:00.000Z";
    for (const eventId of [
      "evt_page_01",
      "evt_page_02",
      "evt_page_03",
      "evt_page_04",
      "evt_page_05"
    ]) {
      await store.putAudit({
        eventId,
        accountId: "acct_primary",
        type: "credential.page_test",
        payload: {},
        createdAt
      });
    }

    const first = await store.listAuditPage("acct_primary", {
      limit: 2,
      eventTypePrefix: "credential"
    });
    expect(first.events.map((event) => event.eventId)).toEqual(["evt_page_05", "evt_page_04"]);
    await store.putAudit({
      eventId: "evt_page_06",
      accountId: "acct_primary",
      type: "credential.page_test",
      payload: {},
      createdAt
    });
    const second = await store.listAuditPage("acct_primary", {
      limit: 2,
      eventTypePrefix: "credential",
      before: first.nextCursor!
    });
    const third = await store.listAuditPage("acct_primary", {
      limit: 2,
      eventTypePrefix: "credential",
      before: second.nextCursor!
    });
    expect(
      [...first.events, ...second.events, ...third.events].map((event) => event.eventId)
    ).toEqual(["evt_page_05", "evt_page_04", "evt_page_03", "evt_page_02", "evt_page_01"]);
  });

  it("persists and resolves approvals once", async () => {
    const item = dispatch(4);
    const createdAt = new Date();
    const approval = await store.putApproval({
      approvalId: createId("apr"),
      accountId: "acct_primary",
      invocation: item.invocation,
      nodeId: "node_postgres",
      placementReason: "explicit_node",
      policyDecision: {
        ...item.policyDecision,
        outcome: "approval_required",
        reasonCode: "approval.required"
      },
      status: "pending",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 60_000).toISOString()
    });
    await expect(
      store.getApprovalByInvocation(item.invocation.invocationId)
    ).resolves.toMatchObject({ approvalId: approval.approvalId });
    await expect(
      store.resolveApproval(approval.approvalId, "approved", new Date())
    ).resolves.toMatchObject({ status: "approved" });
    await expect(
      store.resolveApproval(approval.approvalId, "denied", new Date())
    ).resolves.toBeUndefined();
  });

  it("persists transfer state and rejects changed or terminal metadata", async () => {
    const timestamp = new Date();
    await store.putPairingCode({
      codeHash: "pair-transfer-destination",
      accountId: "acct_primary",
      expiresAt: new Date(timestamp.getTime() + 60_000).toISOString()
    });
    await store.pairNode({
      codeHash: "pair-transfer-destination",
      now: timestamp,
      node: {
        nodeId: "node_postgres_destination",
        label: "postgres-transfer-destination",
        publicKey: "transfer-destination-key",
        platform: "linux",
        status: "active",
        createdAt: timestamp.toISOString()
      }
    });
    await store.putRoot({
      rootId: "root_destination",
      projectId: "proj_example",
      nodeId: "node_postgres_destination",
      label: "Destination",
      writable: true,
      createdAt: timestamp.toISOString()
    });
    const parent = InvocationSchema.parse({
      schemaVersion: "0.1",
      invocationId: createId("inv"),
      attemptId: createId("att"),
      accountId: "acct_primary",
      actor: { type: "agent", id: "actor_testagent" },
      target: { nodeId: "node_postgres" },
      authorization: {
        projectId: "proj_example",
        rootIds: ["root_workspace"],
        grantId: "grant_example"
      },
      tool: "file.transfer",
      args: {
        source: {
          nodeId: "node_postgres",
          rootId: "root_workspace",
          path: "source.bin"
        },
        destination: {
          nodeId: "node_postgres_destination",
          rootId: "root_destination",
          path: "destination.bin"
        },
        chunkSizeBytes: 1024 * 1024
      },
      idempotencyKey: "postgres-transfer",
      issuedAt: timestamp.toISOString(),
      expiresAt: new Date(timestamp.getTime() + 60_000).toISOString(),
      metadata: { source: "sdk" }
    });
    const child = (role: "source" | "destination"): DispatchRecord => {
      const endpoint = FileTransferArgsSchema.parse(parent.args)[role];
      if (!("nodeId" in endpoint)) throw new Error("fixture requires a Node endpoint");
      return {
        dispatchId: createId("dsp"),
        invocation: InvocationSchema.parse({
          ...parent,
          invocationId: createId("inv"),
          attemptId: createId("att"),
          target: { nodeId: endpoint.nodeId },
          authorization: { ...parent.authorization, rootIds: [endpoint.rootId] },
          idempotencyKey: `xfr_postgres-${role}`,
          metadata: { source: "internal", correlationId: "xfr_postgres" }
        }),
        nodeId: endpoint.nodeId,
        policyDecision: {
          outcome: "allow",
          reasonCode: "policy.allowed",
          explanation: "Allowed in integration test.",
          evaluatedLayers: ["account", "agent", "node", "root", "capability"],
          profile: "workspace-write",
          decisionHash: `sha256:${"a".repeat(64)}`
        },
        status: "queued",
        createdAt: timestamp.toISOString(),
        updatedAt: timestamp.toISOString()
      };
    };
    const dispatches = [child("source"), child("destination")] as const;
    const audits = dispatches.map((item): AuditEvent => ({
      eventId: createId("dsp"),
      accountId: "acct_primary",
      invocationId: parent.invocationId,
      type: "dispatch.queued",
      payload: { dispatchId: item.dispatchId },
      createdAt: timestamp.toISOString()
    })) as [AuditEvent, AuditEvent];
    const transfer: TransferRecord = {
      transferId: "xfr_postgres",
      invocation: parent,
      args: FileTransferArgsSchema.parse(parent.args),
      status: "queued",
      sourceDispatchId: dispatches[0].dispatchId,
      destinationDispatchId: dispatches[1].dispatchId,
      bytesTransferred: 0,
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString()
    };

    await expect(store.createTransfer(transfer, [...dispatches], audits)).resolves.toMatchObject({
      transferId: "xfr_postgres",
      status: "queued"
    });
    await expect(
      store.prepareTransfer("xfr_postgres", "node_postgres", {
        byteSize: 5,
        chunkCount: 1
      })
    ).resolves.toMatchObject({ status: "transferring", byteSize: 5, chunkCount: 1 });
    await expect(
      store.prepareTransfer("xfr_postgres", "node_postgres", {
        byteSize: 6,
        chunkCount: 1
      })
    ).rejects.toMatchObject({ code: "conflict" });

    const digest = `sha256:${"b".repeat(64)}`;
    await expect(
      store.finalizeTransferSource("xfr_postgres", "node_postgres", digest)
    ).resolves.toMatchObject({ contentSha256: digest });
    await expect(
      store.finalizeTransferSource("xfr_postgres", "node_postgres", `sha256:${"c".repeat(64)}`)
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.updateTransferProgress("xfr_postgres", "node_postgres_destination", 5, "verifying")
    ).resolves.toMatchObject({ status: "verifying", bytesTransferred: 5 });
    await expect(
      store.updateTransferProgress("xfr_postgres", "node_postgres_destination", 4, "transferring")
    ).resolves.toMatchObject({ status: "verifying", bytesTransferred: 5 });

    await store.requestCancelTransfer("xfr_postgres", new Date());
    await expect(
      store.reconcileTransfer(dispatches[0].dispatchId, new Date())
    ).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      store.prepareTransfer("xfr_postgres", "node_postgres", {
        byteSize: 5,
        chunkCount: 1
      })
    ).resolves.toBeUndefined();
  });

  it("filters approval pages by effective status", async () => {
    const createdAt = "2031-09-24T00:00:00.000Z";
    const now = "2031-09-24T00:30:00.000Z";
    const statuses = [
      ["apr_page_01", "approved", "2031-09-24T01:00:00.000Z"],
      ["apr_page_02", "pending", "2031-09-24T00:10:00.000Z"],
      ["apr_page_03", "denied", "2031-09-24T01:00:00.000Z"],
      ["apr_page_04", "pending", "2031-09-24T01:00:00.000Z"]
    ] as const;
    for (const [approvalId, status, expiresAt] of statuses) {
      const item = dispatch(Number(approvalId.at(-1)));
      await store.putApproval({
        approvalId,
        accountId: "acct_primary",
        invocation: item.invocation,
        nodeId: item.nodeId,
        placementReason: "explicit_node",
        policyDecision: item.policyDecision,
        status,
        createdAt,
        expiresAt
      });
    }

    await expect(
      store.listApprovalsPage("acct_primary", { limit: 10, status: "pending", now })
    ).resolves.toMatchObject({
      approvals: [{ approvalId: "apr_page_04", status: "pending" }],
      pendingCount: 1
    });
    const resolved = await store.listApprovalsPage("acct_primary", {
      limit: 2,
      status: "resolved",
      now
    });
    expect(resolved.approvals).toMatchObject([
      { approvalId: "apr_page_03", status: "denied" },
      { approvalId: "apr_page_02", status: "expired" }
    ]);
    const next = await store.listApprovalsPage("acct_primary", {
      limit: 2,
      status: "resolved",
      now,
      before: resolved.nextCursor!
    });
    expect(next.approvals[0]).toMatchObject({
      approvalId: "apr_page_01",
      status: "approved"
    });
    expect(
      new Set([...resolved.approvals, ...next.approvals].map((approval) => approval.approvalId))
        .size
    ).toBe(resolved.approvals.length + next.approvals.length);
  });
});
