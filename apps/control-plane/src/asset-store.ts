import { createHash, randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  statfs,
  unlink,
  writeFile
} from "node:fs/promises";
import { join, resolve } from "node:path";

const sha256Pattern = /^sha256:([a-f0-9]{64})$/;

export interface AssetStore {
  put(sha256: string, data: Buffer): Promise<void>;
  get(sha256: string): Promise<Buffer>;
  availableBytes?(): Promise<number>;
  sweep?(
    before: Date,
    limit: number,
    withLock: <T>(sha256: string, operation: () => Promise<T>) => Promise<T>,
    hasLive: (sha256: string) => Promise<boolean>
  ): Promise<{ files: number; bytes: number }>;
  close?(): Promise<void>;
}

export class LocalContentAddressedAssetStore implements AssetStore {
  private readonly root: string;
  private scan: AsyncGenerator<{ path: string; sha256: string; temporary: boolean }> | undefined;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  async put(sha256: string, data: Buffer): Promise<void> {
    const digest = digestOf(sha256);
    verifyDigest(data, sha256);
    const shard = join(this.root, digest.slice(0, 2));
    await ensureDirectory(this.root);
    await ensureDirectory(shard);
    const target = join(shard, digest);
    const temporary = join(shard, `.${digest}.${randomBytes(8).toString("hex")}.tmp`);
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, target);
      const directoryHandle = await open(shard, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await verifyContent(target, sha256);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async get(sha256: string): Promise<Buffer> {
    const digest = digestOf(sha256);
    const data = await readFile(join(this.root, digest.slice(0, 2), digest));
    verifyDigest(data, sha256);
    return data;
  }

  async availableBytes(): Promise<number> {
    await ensureDirectory(this.root);
    const info = await statfs(this.root);
    return info.bavail * info.bsize;
  }

  private async *candidates() {
    await ensureDirectory(this.root);
    const root = await opendir(this.root);
    for await (const shard of root) {
      if (!/^[a-f0-9]{2}$/.test(shard.name) || !shard.isDirectory() || shard.isSymbolicLink())
        continue;
      const directory = await opendir(join(this.root, shard.name));
      for await (const file of directory) {
        if (!file.isFile() || file.isSymbolicLink()) continue;
        const digest =
          /^([a-f0-9]{64})$/.exec(file.name)?.[1] ??
          /^\.([a-f0-9]{64})\.[a-f0-9]{16}\.tmp$/.exec(file.name)?.[1];
        if (!digest || !digest.startsWith(shard.name)) continue;
        yield {
          path: join(this.root, shard.name, file.name),
          sha256: `sha256:${digest}`,
          temporary: file.name.startsWith(".")
        };
      }
    }
  }

  async sweep(
    before: Date,
    limit: number,
    withLock: <T>(sha256: string, operation: () => Promise<T>) => Promise<T>,
    hasLive: (sha256: string) => Promise<boolean>
  ): Promise<{ files: number; bytes: number }> {
    const result = { files: 0, bytes: 0 };
    this.scan ??= this.candidates();
    for (let i = 0; i < limit; i++) {
      const next = await this.scan.next();
      if (next.done) {
        this.scan = undefined;
        break;
      }
      const candidate = next.value;
      await withLock(candidate.sha256, async () => {
        const metadata = await lstat(candidate.path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        });
        if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.mtimeMs > before.getTime())
          return;
        if (!candidate.temporary && (await hasLive(candidate.sha256))) return;
        await unlink(candidate.path);
        result.files++;
        result.bytes += metadata.size;
      });
    }
    return result;
  }

  async close(): Promise<void> {
    await this.scan?.return(undefined);
    this.scan = undefined;
  }
}

function digestOf(sha256: string): string {
  const match = sha256Pattern.exec(sha256);
  if (!match) throw new Error("invalid asset SHA-256");
  return match[1]!;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`asset path is not a physical directory: ${path}`);
  }
}

async function verifyContent(path: string, expected: string): Promise<void> {
  verifyDigest(await readFile(path), expected);
}

function verifyDigest(data: Buffer, expected: string): void {
  const actual = `sha256:${createHash("sha256").update(data).digest("hex")}`;
  if (actual !== expected) throw new Error("asset content hash mismatch");
}
