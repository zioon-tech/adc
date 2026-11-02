import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const transferIdPattern = /^xfr_[a-z0-9][a-z0-9_-]{2,127}$/;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;

export interface TransferBlobStore {
  putChunk(transferId: string, index: number, data: Buffer, sha256: string): Promise<void>;
  getChunk(transferId: string, index: number): Promise<Buffer>;
  deleteTransfer(transferId: string): Promise<void>;
}

export class LocalTransferBlobStore implements TransferBlobStore {
  private readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  async putChunk(transferId: string, index: number, data: Buffer, sha256: string): Promise<void> {
    assertTransferId(transferId);
    assertChunkIndex(index);
    verifyDigest(data, sha256);
    await ensureDirectory(this.root);
    const directory = join(this.root, transferId);
    await ensureDirectory(directory);
    const target = join(directory, chunkName(index));
    const temporary = join(directory, `.${chunkName(index)}.${randomBytes(8).toString("hex")}.tmp`);
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, target);
      await syncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      verifyDigest(await readFile(target), sha256);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async getChunk(transferId: string, index: number): Promise<Buffer> {
    assertTransferId(transferId);
    assertChunkIndex(index);
    return readFile(join(this.root, transferId, chunkName(index)));
  }

  async deleteTransfer(transferId: string): Promise<void> {
    assertTransferId(transferId);
    await rm(join(this.root, transferId), { recursive: true, force: true });
  }
}

function assertTransferId(transferId: string): void {
  if (!transferIdPattern.test(transferId)) throw new Error("invalid transfer ID");
}

function assertChunkIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index > 999_999_999) {
    throw new Error("invalid transfer chunk index");
  }
}

function chunkName(index: number): string {
  return `${index.toString().padStart(9, "0")}.chunk`;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`transfer path is not a physical directory: ${path}`);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function verifyDigest(data: Buffer, expected: string): void {
  if (!sha256Pattern.test(expected)) throw new Error("invalid chunk SHA-256");
  const actual = `sha256:${createHash("sha256").update(data).digest("hex")}`;
  if (actual !== expected) throw new Error("transfer chunk hash mismatch");
}
