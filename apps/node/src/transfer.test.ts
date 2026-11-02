import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeApiClient } from "@adc/client/node";
import { InvocationSchema, createId, type Invocation, type PolicyDecision } from "@adc/protocol";
import { ReceiptLedger } from "@adc/tool-runtime";
import { NodeTransferRuntime } from "./transfer.ts";

const temporaryDirectories: string[] = [];
const allowed: PolicyDecision = {
  outcome: "allow",
  reasonCode: "policy.allowed",
  explanation: "Allowed by test.",
  evaluatedLayers: ["account", "agent", "node", "root", "capability"],
  profile: "workspace-write",
  decisionHash: `sha256:${"a".repeat(64)}`
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture() {
  const base = await mkdtemp(resolve(tmpdir(), "adc-node-transfer-"));
  temporaryDirectories.push(base);
  const root = resolve(base, "root");
  const state = resolve(base, "state");
  await mkdir(root);
  return { root, state };
}

function sourceInvocation(): Invocation {
  const now = new Date();
  return InvocationSchema.parse({
    schemaVersion: "0.1",
    invocationId: createId("inv"),
    attemptId: createId("att"),
    accountId: "acct_primary",
    actor: { type: "agent", id: "actor_transfer" },
    target: { nodeId: "node_source" },
    authorization: {
      rootIds: ["root_source"],
      grantId: "grant_transfer"
    },
    tool: "file.transfer",
    args: {
      source: {
        nodeId: "node_source",
        rootId: "root_source",
        path: "model.bin"
      },
      destination: {
        nodeId: "node_destination",
        rootId: "root_destination",
        path: "cache.bin"
      },
      chunkSizeBytes: 1024 * 1024
    },
    idempotencyKey: "xfr_example-source",
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    metadata: { source: "internal", correlationId: "xfr_example" }
  });
}

describe("NodeTransferRuntime", () => {
  it("resumes a transfer-specific orphaned ledger entry and then replays its receipt", async () => {
    const { root, state } = await fixture();
    const payload = Buffer.from("resumable native transfer");
    await writeFile(resolve(root, "model.bin"), payload);
    const invocation = sourceInvocation();
    await new ReceiptLedger(resolve(state, "transfer-receipts")).begin({
      scope: `${invocation.accountId}:${invocation.actor.id}`,
      idempotencyKey: invocation.idempotencyKey!,
      input: { tool: invocation.tool, args: invocation.args, target: invocation.target },
      invocationId: invocation.invocationId,
      attemptId: invocation.attemptId,
      now: new Date()
    });
    const uploadTransferChunk = vi.fn().mockResolvedValue({ accepted: true });
    const api = {
      prepareTransfer: vi.fn().mockResolvedValue({ accepted: true }),
      uploadTransferChunk,
      finalizeTransferSource: vi.fn().mockResolvedValue({ accepted: true })
    } as unknown as NodeApiClient;
    const runtime = new NodeTransferRuntime("node_source", api, state);

    const result = await runtime.execute(invocation, allowed, [
      { rootId: "root_source", path: root, writable: false }
    ]);

    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        transferId: "xfr_example",
        byteSize: payload.byteLength,
        role: "source"
      },
      receipt: { replayed: false }
    });
    expect(uploadTransferChunk.mock.calls[0]![2]).toEqual(payload);

    await expect(
      runtime.execute(invocation, allowed, [{ rootId: "root_source", path: root, writable: false }])
    ).resolves.toMatchObject({
      status: "succeeded",
      receipt: { replayed: true }
    });
  });

  it("never overwrites an existing destination", async () => {
    const { root, state } = await fixture();
    const original = Buffer.from("keep this file");
    const payload = Buffer.from("replacement is forbidden");
    await writeFile(resolve(root, "cache.bin"), original);
    const source = sourceInvocation();
    const invocation = InvocationSchema.parse({
      ...source,
      invocationId: createId("inv"),
      attemptId: createId("att"),
      target: { nodeId: "node_destination" },
      authorization: { ...source.authorization, rootIds: ["root_destination"] },
      idempotencyKey: "xfr_example-destination"
    });
    const digest = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
    const downloadTransferChunk = vi.fn().mockResolvedValue({ data: payload, sha256: digest });
    const api = {
      transferMetadata: vi.fn().mockResolvedValue({
        status: "transferring",
        byteSize: payload.byteLength,
        chunkCount: 1,
        contentSha256: digest
      }),
      downloadTransferChunk,
      updateTransferProgress: vi.fn().mockResolvedValue({ accepted: true })
    } as unknown as NodeApiClient;
    const runtime = new NodeTransferRuntime("node_destination", api, state);

    await expect(
      runtime.execute(invocation, allowed, [
        { rootId: "root_destination", path: root, writable: true }
      ])
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "conflict", retryable: false }
    });
    expect(downloadTransferChunk).not.toHaveBeenCalled();
    await expect(readFile(resolve(root, "cache.bin"))).resolves.toEqual(original);
  });

  it("recovers a committed destination after a crash before the terminal receipt", async () => {
    const { root, state } = await fixture();
    const payload = Buffer.from("already committed");
    const digest = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
    const target = resolve(root, "cache.bin");
    const destinationLedger = resolve(root, ".cache.bin.xfr_example.part.json");
    await writeFile(target, payload);
    await writeFile(
      destinationLedger,
      `${JSON.stringify({
        transferId: "xfr_example",
        byteSize: payload.byteLength,
        chunkSizeBytes: 1024 * 1024,
        completedChunks: 1,
        completedBytes: payload.byteLength,
        committed: true,
        contentSha256: digest
      })}\n`
    );
    const source = sourceInvocation();
    const invocation = InvocationSchema.parse({
      ...source,
      invocationId: createId("inv"),
      attemptId: createId("att"),
      target: { nodeId: "node_destination" },
      authorization: { ...source.authorization, rootIds: ["root_destination"] },
      idempotencyKey: "xfr_example-destination"
    });
    await new ReceiptLedger(resolve(state, "transfer-receipts")).begin({
      scope: `${invocation.accountId}:${invocation.actor.id}`,
      idempotencyKey: invocation.idempotencyKey!,
      input: { tool: invocation.tool, args: invocation.args, target: invocation.target },
      invocationId: invocation.invocationId,
      attemptId: invocation.attemptId,
      now: new Date()
    });
    const downloadTransferChunk = vi.fn();
    const api = {
      transferMetadata: vi.fn().mockResolvedValue({
        status: "verifying",
        byteSize: payload.byteLength,
        chunkCount: 1,
        contentSha256: digest
      }),
      downloadTransferChunk,
      updateTransferProgress: vi.fn()
    } as unknown as NodeApiClient;
    const runtime = new NodeTransferRuntime("node_destination", api, state);

    await expect(
      runtime.execute(invocation, allowed, [
        { rootId: "root_destination", path: root, writable: true }
      ])
    ).resolves.toMatchObject({
      status: "succeeded",
      output: { transferId: "xfr_example", role: "destination" }
    });
    expect(downloadTransferChunk).not.toHaveBeenCalled();
    await expect(readFile(destinationLedger)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(target)).resolves.toEqual(payload);
  });

  it("restarts from chunk zero when the partial file is shorter than its durable ledger", async () => {
    const { root, state } = await fixture();
    const chunks = [Buffer.alloc(1024 * 1024, 7), Buffer.from("tail")];
    const payload = Buffer.concat(chunks);
    const digest = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
    const temporary = resolve(root, ".cache.bin.xfr_example.part");
    await writeFile(temporary, Buffer.from("truncated"));
    await writeFile(
      `${temporary}.json`,
      `${JSON.stringify({
        transferId: "xfr_example",
        byteSize: payload.byteLength,
        chunkSizeBytes: 1024 * 1024,
        completedChunks: 1,
        completedBytes: 1024 * 1024
      })}\n`
    );
    const source = sourceInvocation();
    const invocation = InvocationSchema.parse({
      ...source,
      invocationId: createId("inv"),
      attemptId: createId("att"),
      target: { nodeId: "node_destination" },
      authorization: { ...source.authorization, rootIds: ["root_destination"] },
      idempotencyKey: "xfr_example-destination"
    });
    const downloadTransferChunk = vi.fn(async (_transferId: string, index: number) => ({
      data: chunks[index]!,
      sha256: `sha256:${createHash("sha256").update(chunks[index]!).digest("hex")}`
    }));
    const api = {
      transferMetadata: vi.fn().mockResolvedValue({
        status: "transferring",
        byteSize: payload.byteLength,
        chunkCount: chunks.length,
        contentSha256: digest
      }),
      downloadTransferChunk,
      updateTransferProgress: vi.fn().mockResolvedValue({ accepted: true })
    } as unknown as NodeApiClient;
    const runtime = new NodeTransferRuntime("node_destination", api, state);

    await expect(
      runtime.execute(invocation, allowed, [
        { rootId: "root_destination", path: root, writable: true }
      ])
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(downloadTransferChunk.mock.calls.map((call) => call[1])).toEqual([0, 1]);
    await expect(readFile(resolve(root, "cache.bin"))).resolves.toEqual(payload);
  });
});
