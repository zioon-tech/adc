import { constants } from "node:fs";
import { link, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  ErrorCodes,
  FileTransferArgsSchema,
  InvocationSchema,
  ProtocolError,
  ReceiptSchema,
  ResultSchema,
  createId,
  type Invocation,
  type InvocationResult,
  type PolicyDecision,
  type Receipt
} from "@adc/protocol";
import { AdcClientError, type NodeApiClient } from "@adc/client/node";
import {
  ReceiptLedger,
  resolveResourcePath,
  syncDirectory,
  type LocalRoot
} from "@adc/tool-runtime";

interface DestinationLedger {
  transferId: string;
  byteSize: number;
  chunkSizeBytes: number;
  completedChunks: number;
  completedBytes: number;
  committed?: boolean;
  contentSha256?: `sha256:${string}`;
}

export class NodeTransferRuntime {
  private readonly ledger: ReceiptLedger;

  constructor(
    private readonly nodeId: string,
    private readonly api: NodeApiClient,
    stateDirectory: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.ledger = new ReceiptLedger(resolve(stateDirectory, "transfer-receipts"));
  }

  async execute(
    rawInvocation: Invocation,
    policyDecision: PolicyDecision,
    roots: LocalRoot[],
    signal?: AbortSignal
  ): Promise<InvocationResult> {
    const invocation = InvocationSchema.parse(rawInvocation);
    const attemptStartedAt = this.now();
    const argsHash = sha256(invocation.args);
    if (policyDecision.outcome !== "allow") {
      return ResultSchema.parse({
        schemaVersion: "0.1",
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        status: policyDecision.outcome === "approval_required" ? "approval_required" : "denied",
        error: {
          code:
            policyDecision.outcome === "approval_required"
              ? ErrorCodes.APPROVAL_REQUIRED
              : ErrorCodes.DENIED,
          message: policyDecision.explanation,
          retryable: false
        }
      });
    }
    const transferId = invocation.metadata.correlationId;
    if (!transferId || !/^xfr_[a-z0-9][a-z0-9_-]{2,127}$/.test(transferId)) {
      throw new ProtocolError(ErrorCodes.INVALID_REQUEST, "transfer ID is missing", false);
    }
    const args = FileTransferArgsSchema.parse(invocation.args);
    const ledgerState = await this.ledger.begin({
      scope: `${invocation.accountId}:${invocation.actor.id}`,
      idempotencyKey: invocation.idempotencyKey!,
      input: { tool: invocation.tool, args: invocation.args, target: invocation.target },
      invocationId: invocation.invocationId,
      attemptId: invocation.attemptId,
      now: attemptStartedAt
    });
    if (ledgerState.state === "replay") {
      if (args.destination.nodeId === this.nodeId) {
        await this.cleanupDestinationState(transferId, args, roots).catch(() => undefined);
      }
      return ResultSchema.parse({
        ...ledgerState.result,
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        receipt: {
          ...ledgerState.receipt,
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          replayed: true
        }
      });
    }
    // Transfer chunks and the destination partial-file ledger are independently idempotent,
    // so an interrupted child dispatch can safely continue instead of becoming unknown_outcome.
    const ledgerKeyHash =
      ledgerState.state === "new" ? ledgerState.keyHash : ledgerState.entry.keyHash;
    const startedAt =
      ledgerState.state === "new" ? attemptStartedAt : new Date(ledgerState.entry.startedAt);

    let output: unknown;
    let error: ProtocolError | undefined;
    try {
      assertCurrent(invocation, this.now());
      const source = "nodeId" in args.source && args.source.nodeId === this.nodeId;
      const destination = args.destination.nodeId === this.nodeId;
      if (source === destination) {
        throw new ProtocolError(
          ErrorCodes.INVALID_REQUEST,
          "transfer dispatch does not match this node",
          false
        );
      }
      output = source
        ? await this.upload(transferId, args, roots, signal)
        : await this.download(transferId, args, roots, signal);
    } catch (caught) {
      error = signal?.aborted
        ? new ProtocolError(ErrorCodes.CANCELLED, "transfer was cancelled", false)
        : caught instanceof ProtocolError
          ? caught
          : caught instanceof AdcClientError
            ? new ProtocolError(
                caught.error.code,
                caught.error.message,
                caught.error.retryable,
                caught.error.details
              )
            : new ProtocolError(
                ErrorCodes.EXECUTION_FAILED,
                "local transfer failed; check device logs and storage availability",
                false
              );
    }
    const result = this.result({
      invocation,
      policyDecision,
      status: error
        ? error.code === ErrorCodes.CANCELLED
          ? "cancelled"
          : error.code === ErrorCodes.DENIED
            ? "denied"
            : "failed"
        : "succeeded",
      startedAt,
      argsHash,
      ...(output !== undefined ? { output } : {}),
      ...(error ? { error } : {})
    });
    try {
      await this.ledger.complete(ledgerKeyHash, result, result.receipt!, this.now());
      if (!error && args.destination.nodeId === this.nodeId) {
        await this.cleanupDestinationState(transferId, args, roots).catch(() => undefined);
      }
      return result;
    } catch {
      return this.result({
        invocation,
        policyDecision,
        status: "unknown_outcome",
        startedAt,
        argsHash,
        error: new ProtocolError(
          ErrorCodes.UNKNOWN_OUTCOME,
          "transfer ended but its terminal receipt could not be persisted",
          false
        )
      });
    }
  }

  private async upload(
    transferId: string,
    args: ReturnType<typeof FileTransferArgsSchema.parse>,
    roots: LocalRoot[],
    signal?: AbortSignal
  ): Promise<unknown> {
    if (!("nodeId" in args.source)) {
      throw new ProtocolError(
        ErrorCodes.INVALID_REQUEST,
        "Agent source cannot run on a Node",
        false
      );
    }
    const root = requiredRoot(roots, args.source.rootId);
    const target = await resolveResourcePath(root, args.source.path, "read");
    const handle = await open(
      target,
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const initial = await handle.stat();
      if (!initial.isFile()) {
        throw new ProtocolError(
          ErrorCodes.INVALID_REQUEST,
          "transfer source is not a regular file",
          false
        );
      }
      const checked = await resolveResourcePath(root, args.source.path, "read");
      const current = await lstat(checked);
      if (checked !== target || current.dev !== initial.dev || current.ino !== initial.ino) {
        throw new ProtocolError(ErrorCodes.CONFLICT, "transfer source changed", true);
      }
      const chunkCount = Math.ceil(initial.size / args.chunkSizeBytes);
      await this.api.prepareTransfer(transferId, { byteSize: initial.size, chunkCount }, signal);
      const contentHash = createHash("sha256");
      for (let index = 0; index < chunkCount; index++) {
        throwIfAborted(signal);
        const length = Math.min(args.chunkSizeBytes, initial.size - index * args.chunkSizeBytes);
        const chunk = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
          const read = await handle.read(
            chunk,
            offset,
            length - offset,
            index * args.chunkSizeBytes + offset
          );
          if (!read.bytesRead) {
            throw new ProtocolError(ErrorCodes.CONFLICT, "transfer source was truncated", true);
          }
          offset += read.bytesRead;
        }
        contentHash.update(chunk);
        const chunkSha256 = sha256Bytes(chunk);
        await this.api.uploadTransferChunk(transferId, index, chunk, chunkSha256, signal);
      }
      const final = await handle.stat();
      if (
        final.size !== initial.size ||
        final.mtimeMs !== initial.mtimeMs ||
        final.ctimeMs !== initial.ctimeMs
      ) {
        throw new ProtocolError(ErrorCodes.CONFLICT, "transfer source changed during upload", true);
      }
      const contentSha256 = `sha256:${contentHash.digest("hex")}`;
      await this.api.finalizeTransferSource(transferId, contentSha256, signal);
      return { transferId, byteSize: initial.size, chunkCount, contentSha256, role: "source" };
    } finally {
      await handle.close();
    }
  }

  private async download(
    transferId: string,
    args: ReturnType<typeof FileTransferArgsSchema.parse>,
    roots: LocalRoot[],
    signal?: AbortSignal
  ): Promise<unknown> {
    const root = requiredRoot(roots, args.destination.rootId);
    const target = await resolveResourcePath(root, args.destination.path, "write");
    const directory = dirname(target);
    const temporary = join(directory, `.${basename(target)}.${transferId}.part`);
    const ledgerPath = `${temporary}.json`;
    const metadata = await this.waitForMetadata(transferId, signal);
    let ledger = await readDestinationLedger(ledgerPath);
    if (
      !ledger ||
      ledger.transferId !== transferId ||
      ledger.byteSize !== metadata.byteSize ||
      ledger.chunkSizeBytes !== args.chunkSizeBytes ||
      ledger.completedChunks > metadata.chunkCount ||
      ledger.completedBytes !==
        Math.min(ledger.completedChunks * args.chunkSizeBytes, metadata.byteSize)
    ) {
      await unlink(temporary).catch(() => undefined);
      await unlink(ledgerPath).catch(() => undefined);
      ledger = {
        transferId,
        byteSize: metadata.byteSize,
        chunkSizeBytes: args.chunkSizeBytes,
        completedChunks: 0,
        completedBytes: 0
      };
    }
    if (ledger.committed) {
      return this.verifyCommittedDestination(
        transferId,
        target,
        temporary,
        ledger,
        metadata,
        signal
      );
    }
    if (ledger.completedChunks === metadata.chunkCount) {
      const recovered = await this.recoverLinkedDestination(
        transferId,
        target,
        temporary,
        ledgerPath,
        ledger,
        metadata,
        signal
      );
      if (recovered) return recovered;
    }
    try {
      await lstat(target);
      throw new ProtocolError(ErrorCodes.CONFLICT, "destination already exists", false);
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (ledger.completedChunks) {
      try {
        const partial = await lstat(temporary);
        if (!partial.isFile() || partial.isSymbolicLink()) {
          throw new ProtocolError(
            ErrorCodes.DENIED,
            "transfer partial path is not a regular file",
            false
          );
        }
        if (partial.size < ledger.completedBytes) {
          await unlink(temporary);
          await unlink(ledgerPath).catch(() => undefined);
          ledger.completedChunks = 0;
          ledger.completedBytes = 0;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        ledger.completedChunks = 0;
        ledger.completedBytes = 0;
      }
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const handle = await open(
      temporary,
      ledger.completedChunks
        ? constants.O_RDWR | noFollow
        : constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
      0o600
    );
    try {
      await handle.truncate(ledger.completedBytes);
      for (let index = ledger.completedChunks; index < metadata.chunkCount; index++) {
        throwIfAborted(signal);
        const chunk = await this.waitForChunk(transferId, index, signal);
        if (sha256Bytes(chunk.data) !== chunk.sha256) {
          throw new ProtocolError(ErrorCodes.CONFLICT, "downloaded chunk hash mismatch", true);
        }
        let written = 0;
        while (written < chunk.data.length) {
          const result = await handle.write(
            chunk.data,
            written,
            chunk.data.length - written,
            index * args.chunkSizeBytes + written
          );
          written += result.bytesWritten;
        }
        await handle.sync();
        ledger.completedChunks = index + 1;
        ledger.completedBytes += chunk.data.length;
        await writeLedger(ledgerPath, ledger);
        await this.api.updateTransferProgress(
          transferId,
          {
            bytesTransferred: ledger.completedBytes,
            status: "transferring"
          },
          signal
        );
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.api.updateTransferProgress(
      transferId,
      {
        bytesTransferred: ledger.completedBytes,
        status: "verifying"
      },
      signal
    );
    const finalMetadata = await this.waitForFinalDigest(transferId, signal);
    const actual = await sha256File(temporary);
    if (ledger.completedBytes !== metadata.byteSize || actual !== finalMetadata.contentSha256) {
      throw new ProtocolError(ErrorCodes.CONFLICT, "transferred file hash mismatch", true);
    }
    const revalidatedTarget = await resolveResourcePath(root, args.destination.path, "write");
    if (revalidatedTarget !== target) {
      throw new ProtocolError(ErrorCodes.CONFLICT, "destination path changed", true);
    }
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ProtocolError(ErrorCodes.CONFLICT, "destination already exists", false);
      }
      throw error;
    }
    await syncDirectory(directory);
    ledger.committed = true;
    ledger.contentSha256 = finalMetadata.contentSha256;
    await writeLedger(ledgerPath, ledger);
    await unlink(temporary).catch(() => undefined);
    await syncDirectory(directory).catch(() => undefined);
    return {
      transferId,
      byteSize: metadata.byteSize,
      chunkCount: metadata.chunkCount,
      contentSha256: finalMetadata.contentSha256,
      role: "destination"
    };
  }

  private async verifyCommittedDestination(
    transferId: string,
    target: string,
    temporary: string,
    ledger: DestinationLedger,
    metadata: { byteSize: number; chunkCount: number },
    signal?: AbortSignal
  ): Promise<unknown> {
    const finalMetadata = await this.waitForFinalDigest(transferId, signal);
    if (
      ledger.completedChunks !== metadata.chunkCount ||
      ledger.completedBytes !== metadata.byteSize ||
      ledger.contentSha256 !== finalMetadata.contentSha256
    ) {
      throw new ProtocolError(ErrorCodes.CONFLICT, "transfer commit marker is invalid", false);
    }
    const targetMetadata = await lstat(target);
    if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) {
      throw new ProtocolError(ErrorCodes.CONFLICT, "transfer destination changed", false);
    }
    if ((await sha256File(target)) !== finalMetadata.contentSha256) {
      throw new ProtocolError(ErrorCodes.CONFLICT, "transfer destination changed", false);
    }
    await unlink(temporary).catch(() => undefined);
    await syncDirectory(dirname(target)).catch(() => undefined);
    return {
      transferId,
      byteSize: metadata.byteSize,
      chunkCount: metadata.chunkCount,
      contentSha256: finalMetadata.contentSha256,
      role: "destination"
    };
  }

  private async recoverLinkedDestination(
    transferId: string,
    target: string,
    temporary: string,
    ledgerPath: string,
    ledger: DestinationLedger,
    metadata: { byteSize: number; chunkCount: number },
    signal?: AbortSignal
  ): Promise<unknown> {
    let targetMetadata;
    let temporaryMetadata;
    try {
      [targetMetadata, temporaryMetadata] = await Promise.all([lstat(target), lstat(temporary)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (
      !targetMetadata.isFile() ||
      targetMetadata.isSymbolicLink() ||
      !temporaryMetadata.isFile() ||
      temporaryMetadata.isSymbolicLink() ||
      targetMetadata.dev !== temporaryMetadata.dev ||
      targetMetadata.ino !== temporaryMetadata.ino
    ) {
      return;
    }
    const finalMetadata = await this.waitForFinalDigest(transferId, signal);
    if ((await sha256File(target)) !== finalMetadata.contentSha256) {
      throw new ProtocolError(ErrorCodes.CONFLICT, "transfer destination changed", false);
    }
    ledger.committed = true;
    ledger.contentSha256 = finalMetadata.contentSha256;
    await writeLedger(ledgerPath, ledger);
    return this.verifyCommittedDestination(transferId, target, temporary, ledger, metadata, signal);
  }

  private async cleanupDestinationState(
    transferId: string,
    args: ReturnType<typeof FileTransferArgsSchema.parse>,
    roots: LocalRoot[]
  ): Promise<void> {
    const root = requiredRoot(roots, args.destination.rootId);
    const target = await resolveResourcePath(root, args.destination.path, "write");
    const temporary = join(dirname(target), `.${basename(target)}.${transferId}.part`);
    await unlink(temporary).catch(() => undefined);
    await unlink(`${temporary}.json`).catch(() => undefined);
    await syncDirectory(dirname(target)).catch(() => undefined);
  }

  private async waitForMetadata(
    transferId: string,
    signal?: AbortSignal
  ): Promise<{ byteSize: number; chunkCount: number }> {
    for (;;) {
      throwIfAborted(signal);
      const metadata = await this.api.transferMetadata(transferId, signal);
      if (
        Number.isSafeInteger(metadata.byteSize) &&
        metadata.byteSize >= 0 &&
        Number.isSafeInteger(metadata.chunkCount) &&
        metadata.chunkCount >= 0 &&
        metadata.chunkCount <= 1_000_000
      ) {
        return { byteSize: metadata.byteSize, chunkCount: metadata.chunkCount };
      }
      if (metadata.byteSize !== undefined || metadata.chunkCount !== undefined) {
        throw new ProtocolError(ErrorCodes.INVALID_REQUEST, "transfer metadata is invalid", false);
      }
      assertTransferPending(metadata);
      await delay(200, signal);
    }
  }

  private async waitForFinalDigest(
    transferId: string,
    signal?: AbortSignal
  ): Promise<{ contentSha256: `sha256:${string}` }> {
    for (;;) {
      throwIfAborted(signal);
      const metadata = await this.api.transferMetadata(transferId, signal);
      if (
        typeof metadata.contentSha256 === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(metadata.contentSha256)
      ) {
        return { contentSha256: metadata.contentSha256 as `sha256:${string}` };
      }
      assertTransferPending(metadata);
      await delay(200, signal);
    }
  }

  private async waitForChunk(
    transferId: string,
    index: number,
    signal?: AbortSignal
  ): Promise<{ data: Buffer; sha256: string }> {
    for (;;) {
      throwIfAborted(signal);
      try {
        return await this.api.downloadTransferChunk(transferId, index, signal);
      } catch (error) {
        if (!(error instanceof AdcClientError) || error.error.code !== ErrorCodes.NOT_FOUND) {
          throw error;
        }
        assertTransferPending(await this.api.transferMetadata(transferId, signal));
      }
      await delay(150, signal);
    }
  }

  private result(input: {
    invocation: Invocation;
    policyDecision: PolicyDecision;
    status: Receipt["terminalStatus"];
    startedAt: Date;
    argsHash: `sha256:${string}`;
    output?: unknown;
    error?: ProtocolError;
  }): InvocationResult {
    const completedAt = this.now();
    const receipt = ReceiptSchema.parse({
      schemaVersion: "0.1",
      receiptId: createId("rcpt"),
      invocationId: input.invocation.invocationId,
      attemptId: input.invocation.attemptId,
      nodeId: this.nodeId,
      tool: input.invocation.tool,
      terminalStatus: input.status,
      sideEffect: true,
      replayed: false,
      idempotencyKeyHash: sha256(input.invocation.idempotencyKey!),
      argsHash: input.argsHash,
      policyDecisionHash: input.policyDecision.decisionHash,
      ...(input.output === undefined ? {} : { outputHash: sha256(input.output) }),
      startedAt: input.startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - input.startedAt.getTime()),
      artifactRefs: []
    });
    return ResultSchema.parse({
      schemaVersion: "0.1",
      invocationId: input.invocation.invocationId,
      attemptId: input.invocation.attemptId,
      status: input.status,
      ...(input.output === undefined ? {} : { output: input.output }),
      ...(input.error ? { error: input.error.toJSON() } : {}),
      receipt
    });
  }
}

function requiredRoot(roots: LocalRoot[], rootId: string): LocalRoot {
  const root = roots.find((candidate) => candidate.rootId === rootId);
  if (!root) {
    throw new ProtocolError(ErrorCodes.DENIED, "transfer root is not configured", false);
  }
  return root;
}

function assertCurrent(invocation: Invocation, now: Date): void {
  if (Date.parse(invocation.expiresAt) <= now.getTime()) {
    throw new ProtocolError(ErrorCodes.EXPIRED, "transfer invocation expired", false);
  }
}

function assertTransferPending(metadata: any): void {
  if (["failed", "denied", "cancelled", "unknown_outcome"].includes(metadata.status)) {
    throw new ProtocolError(
      metadata.error?.code ?? ErrorCodes.EXECUTION_FAILED,
      metadata.error?.message ?? `transfer ${metadata.status}`,
      false
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProtocolError(ErrorCodes.CANCELLED, "transfer cancelled", false);
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function readDestinationLedger(path: string): Promise<DestinationLedger | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.transferId !== "string" ||
      !/^xfr_[a-z0-9][a-z0-9_-]{2,127}$/.test(value.transferId) ||
      !Number.isSafeInteger(value.byteSize) ||
      Number(value.byteSize) < 0 ||
      !Number.isSafeInteger(value.chunkSizeBytes) ||
      Number(value.chunkSizeBytes) < 1024 * 1024 ||
      !Number.isSafeInteger(value.completedChunks) ||
      Number(value.completedChunks) < 0 ||
      !Number.isSafeInteger(value.completedBytes) ||
      Number(value.completedBytes) < 0 ||
      (value.committed !== undefined && typeof value.committed !== "boolean") ||
      (value.contentSha256 !== undefined &&
        (typeof value.contentSha256 !== "string" ||
          !/^sha256:[a-f0-9]{64}$/.test(value.contentSha256)))
    ) {
      return;
    }
    return {
      transferId: value.transferId,
      byteSize: Number(value.byteSize),
      chunkSizeBytes: Number(value.chunkSizeBytes),
      completedChunks: Number(value.completedChunks),
      completedBytes: Number(value.completedBytes),
      ...(value.committed === undefined ? {} : { committed: value.committed }),
      ...(value.contentSha256 === undefined
        ? {}
        : { contentSha256: value.contentSha256 as `sha256:${string}` })
    };
  } catch {
    return undefined;
  }
}

async function writeLedger(path: string, ledger: DestinationLedger): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(ledger)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (!result.bytesRead) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return `sha256:${hash.digest("hex")}`;
}

function sha256Bytes(data: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
