import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { AdcClient, buildInvocation } from "@adc/client";
import type { InvocationResult } from "@adc/protocol";

/** Two bounded passes: bind authorization to a digest, then upload chunks without loading the file. */
export async function uploadFile(
  client: AdcClient,
  input: {
    path: string;
    destination: { nodeId: string; rootId: string; path: string };
    idempotencyKey: string;
    chunkSizeBytes?: number;
    executionTimeoutMs?: number;
  }
): Promise<InvocationResult> {
  const me = await client.me();
  if (me.kind !== "agent") throw new Error("An Agent connection is required.");
  const chunkSize = input.chunkSizeBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1024 * 1024 || chunkSize > 32 * 1024 * 1024) {
    throw new Error("chunk size must be between 1 and 32 MiB");
  }
  const handle = await open(input.path, "r");
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) throw new Error("upload source must be a regular file");
    const contentHash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(chunkSize, Math.max(1, initial.size)));
    const readChunk = async (offset: number): Promise<Buffer> => {
      const length = Math.min(chunkSize, initial.size - offset);
      let read = 0;
      while (read < length) {
        const result = await handle.read(buffer, read, length - read, offset + read);
        if (!result.bytesRead) throw new Error("upload source was truncated");
        read += result.bytesRead;
      }
      return buffer.subarray(0, length);
    };
    for (let offset = 0; offset < initial.size; offset += chunkSize) {
      contentHash.update(await readChunk(offset));
    }
    const contentSha256 = `sha256:${contentHash.digest("hex")}`;
    const result = await client.invoke(
      buildInvocation({
        context: me.context,
        tool: "file.transfer",
        args: {
          source: {
            kind: "agent",
            path: basename(input.path),
            byteSize: initial.size,
            contentSha256
          },
          destination: input.destination,
          chunkSizeBytes: chunkSize
        },
        idempotencyKey: input.idempotencyKey,
        source: "cli",
        executionTimeoutMs: input.executionTimeoutMs ?? 30 * 60_000
      })
    );
    if (!["queued", "running"].includes(result.status)) return result;
    const { transferId, expiresAt } = result.output as { transferId: string; expiresAt: string };
    const remainingMs = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remainingMs)) throw new Error("transfer deadline is missing");
    const signal = AbortSignal.timeout(
      Math.max(1, Math.min(input.executionTimeoutMs ?? 30 * 60_000, remainingMs))
    );
    const uploadedHash = createHash("sha256");
    try {
      for (let offset = 0, index = 0; offset < initial.size; offset += chunkSize, index++) {
        signal.throwIfAborted();
        const chunk = await readChunk(offset);
        uploadedHash.update(chunk);
        await client.uploadTransferChunk(transferId, index, chunk, signal);
      }
      const final = await handle.stat();
      if (
        final.size !== initial.size ||
        final.mtimeMs !== initial.mtimeMs ||
        `sha256:${uploadedHash.digest("hex")}` !== contentSha256
      ) {
        throw new Error("upload source changed during transfer");
      }
    } catch (error) {
      if (result.jobId) await client.cancelTask(result.jobId).catch(() => undefined);
      throw error;
    }
    return result;
  } finally {
    await handle.close();
  }
}
