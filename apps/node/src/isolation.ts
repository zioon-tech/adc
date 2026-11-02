import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  ProtocolError, ResultSchema, absolutePathForToolArgs, relativePathFromRoot, rootForAbsolutePath,
  type Invocation, type PolicyDecision
} from "@adc/protocol";
import { assertNotSensitive, resolveResourcePath, type CommandTemplate, type LocalRoot } from "@adc/tool-runtime";
const exec = promisify(execFile);

/** Each invocation uses a fresh copy. No guest writes or processes survive on the host. */
export class DockerIsolation {
  private imageId?: string;
  constructor(private readonly options: {
    stateDirectory: string; workerBundle: string; image: string; docker?: string; nodeId?: string;
  }) {}

  async verify() {
    if (process.platform !== "linux")
      throw new ProtocolError("denied", "Isolated sharing requires a Linux device with local Docker.", false);
    const docker = this.options.docker ?? "docker";
    const { stdout } = await exec(docker, ["info", "--format", "{{json .}}"], { timeout: 10_000, maxBuffer: 512_000 });
    const info = JSON.parse(stdout);
    if (info.OSType !== "linux" || !info.SecurityOptions?.some((entry: string) => entry.startsWith("name=seccomp")))
      throw new ProtocolError("denied", "A Linux Docker daemon with seccomp is required.", false);
    const image = JSON.parse((await exec(docker, ["image", "inspect", this.options.image], { timeout: 10_000 })).stdout)[0];
    if (!image?.Id || !image.RepoDigests?.includes(this.options.image))
      throw new ProtocolError("denied", "Install the exact pinned isolation image before enabling sharing.", false);
    await readFile(this.options.workerBundle);
    await exec(docker, [
      "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", "--user", "65534:65534",
      "--entrypoint", "node", image.Id, "-e",
      "if (Number(process.versions.node.split('.')[0]) < 24 || !require('node:fs').existsSync('/bin/bash')) process.exit(1)"
    ], { timeout: 10_000, maxBuffer: 32_768 });
    this.imageId = image.Id as string;
    if (this.options.nodeId) {
      const orphaned = (await exec(docker, ["ps", "--all", "--filter", `label=adc.nodeId=${this.options.nodeId}`, "--format", "{{.ID}}"], { timeout: 10_000 })).stdout.trim().split("\n").filter(Boolean);
      for (const id of orphaned) {
        const container = JSON.parse((await exec(docker, ["inspect", id], { timeout: 10_000 })).stdout)[0];
        if (!container.State.Running) await exec(docker, ["rm", id], { timeout: 10_000 });
      }
    }
  }

  async execute(invocation: Invocation, roots: LocalRoot[], templates: CommandTemplate[], policyDecision: PolicyDecision, signal?: AbortSignal, leaseDeadline?: () => number): Promise<{
    output: Record<string, unknown>; artifactRefs: string[]; succeeded: boolean;
  }> {
    if (!this.imageId) throw new ProtocolError("denied", "Device isolation has not been verified.", false);
    if (signal?.aborted) throw new ProtocolError("cancelled", "Invocation was cancelled.", false);
    const docker = this.options.docker ?? "docker";
    const parent = resolve(this.options.stateDirectory, "isolated");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(resolve(parent, "invocation-"));
    const workspace = resolve(directory, "workspace");
    const worker = resolve(directory, "worker.mjs");
    const lifecycle = resolve(directory, "lifecycle");
    const name = `adc-guest-${randomBytes(16).toString("hex")}`;
    let created = false;
    let cleanup: Promise<unknown> | undefined;
    let leaseWriter: ReturnType<typeof setInterval> | undefined;
    let writingLease = false;
    const remove = () => cleanup ??= exec(docker, ["rm", "--force", name], { timeout: 15_000 }).catch(async () => {
      try {
        const listing = await exec(docker, ["ps", "--all", "--filter", `name=^${name}$`, "--format", "{{.Names}}"], { timeout: 10_000 });
        if (!listing.stdout.trim()) return;
      } catch {}
      throw new ProtocolError("unknown_outcome", "Device could not confirm teardown of the isolated environment.", false);
    });
    try {
      await mkdir(workspace, { mode: 0o777 });
      await chmod(directory, 0o755);
      await writeFile(worker, await readFile(this.options.workerBundle), { mode: 0o444 });
      await mkdir(lifecycle, { mode: 0o755 });
      const writeLease = async () => {
        const expiresAt = Math.min(
          leaseDeadline?.() ?? Date.parse(invocation.expiresAt), Date.parse(invocation.expiresAt),
          Date.parse(invocation.delegation!.expiresAt)
        );
        await writeFile(resolve(lifecycle, "lease.next"), JSON.stringify({ expiresAt }), { mode: 0o444 });
        await rename(resolve(lifecycle, "lease.next"), resolve(lifecycle, "lease.json"));
      };
      await writeLease();
      leaseWriter = setInterval(() => {
        if (writingLease) return;
        writingLease = true;
        void writeLease().catch(() => { void remove().catch(() => {}); }).finally(() => { writingLease = false; });
      }, 100);
      const budget = { files: 0, bytes: 0 };
      for (const root of roots) {
        await snapshot(root, "", resolve(workspace, root.rootId), budget, signal);
      }
      const args = { ...invocation.args } as Record<string, unknown>;
      const absolute = absolutePathForToolArgs(invocation.tool, args);
      if (absolute) {
        const root = rootForAbsolutePath(absolute, roots);
        if (!root) throw new ProtocolError("denied", "Select a shared folder.", false);
        const relative = relativePathFromRoot(root.path, absolute);
        if (invocation.tool === "shell.exec") args.cwd = relative;
        else args.path = relative;
        args.rootId = root.rootId;
      }
      const payload = JSON.stringify({
        invocation: { ...invocation, args }, nodeId: "nodeId" in invocation.target ? invocation.target.nodeId : "",
        roots: roots.map((root) => ({ ...root, path: `/workspace/${root.rootId}`, allowSensitivePaths: false })),
        templates, policyDecision
      });
      if (signal?.aborted) throw new ProtocolError("cancelled", "Invocation was cancelled.", false);
      created = true;
      await exec(docker, [
        "create", "--name", name, "--interactive",
        "--label", `adc.nodeId=${this.options.nodeId ?? ("nodeId" in invocation.target ? invocation.target.nodeId : "")}`,
        "--network", "none", "--ipc", "private",
        "--read-only", "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID",
        "--security-opt", "no-new-privileges:true",
        "--pids-limit", "128", "--memory", "1g", "--cpus", "1", "--user", "0:0",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=128m,uid=65534,gid=65534",
        "--tmpfs", "/workspace:rw,nosuid,nodev,size=256m,uid=0,gid=0,mode=0755",
        "--tmpfs", "/workspace/.state:rw,nosuid,nodev,noexec,size=32m,uid=65534,gid=65534,mode=0700",
        "--mount", `type=bind,src=${workspace},dst=/snapshot,readonly`,
        "--mount", `type=bind,src=${worker},dst=/adc/worker.mjs,readonly`,
        "--mount", `type=bind,src=${lifecycle},dst=/adc/lifecycle,readonly`,
        ...roots.filter(root => !root.writable).flatMap(root => [
          "--mount", `type=bind,src=${workspace}/${root.rootId},dst=/workspace/${root.rootId},readonly`
        ]),
        "--workdir", "/workspace", "--entrypoint", "node", this.imageId, "/adc/worker.mjs"
      ], { timeout: 15_000, maxBuffer: 512_000 });
      if (signal?.aborted) throw new ProtocolError("cancelled", "Invocation was cancelled.", false);
      const child = spawn(docker, ["start", "--attach", "--interactive", name], { stdio: ["pipe", "pipe", "pipe"] });
      const parts: Buffer[] = [];
      const errors: Buffer[] = [];
      let bytes = 0;
      let overflow = false;
      child.stdout.on("data", (part: Buffer) => {
        bytes += part.length;
        if (bytes <= 4 * 1024 * 1024) parts.push(part);
        else { overflow = true; void remove().catch(() => {}); }
      });
      child.stderr.on("data", (part: Buffer) => { if (errors.reduce((n, p) => n + p.length, 0) < 32_768) errors.push(part); });
      child.stdin.on("error", () => {});
      const onAbort = () => { void remove().catch(() => {}); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.stdin.end(payload);
      const timeout = setTimeout(onAbort, Math.max(1, Math.min(
        Date.parse(invocation.expiresAt), Date.parse(invocation.delegation!.expiresAt)
      ) - Date.now()));
      try {
        const code = await new Promise<number | null>((resolveExit, reject) => {
          child.once("error", reject);
          child.once("close", resolveExit);
        });
        if (signal?.aborted) throw new ProtocolError("cancelled", "The isolated environment was cancelled.", false);
        if (overflow || code !== 0) throw new ProtocolError("execution_failed", "The isolated environment did not return a complete result.", false);
        const envelope = JSON.parse(Buffer.concat(parts).toString("utf8"));
        const result = ResultSchema.parse(envelope.result);
        if (result.invocationId !== invocation.invocationId) throw new ProtocolError("denied", "Invalid isolated result.", false);
        if (result.error) throw new ProtocolError(result.error.code, result.error.message, false, { output: result.output });
        // Guest writes stay on size-limited tmpfs. Only bounded result data leaves.
        const artifactRefs = result.receipt?.artifactRefs ?? [];
        for (const artifactId of artifactRefs) {
          if (!/^artifact_[a-f0-9]{32}\.log$/.test(artifactId) || typeof envelope.artifacts?.[artifactId] !== "string")
            throw new ProtocolError("denied", "Invalid isolated artifact.", false);
          const data = Buffer.from(envelope.artifacts[artifactId], "base64");
          if (data.length > 2 * 1024 * 1024) throw new ProtocolError("denied", "Invalid isolated artifact.", false);
          await mkdir(resolve(this.options.stateDirectory, "artifacts"), { recursive: true, mode: 0o700 });
          await writeFile(resolve(this.options.stateDirectory, "artifacts", artifactId), data, { mode: 0o600, flag: "wx" });
        }
        return {
          output: { ...(result.output as Record<string, unknown> ?? {}), isolation: "container", workspaceChanges: "discarded" },
          artifactRefs, succeeded: result.status === "succeeded"
        };
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    } finally {
      if (leaseWriter) clearInterval(leaseWriter);
      try { if (created) await remove(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
}

async function snapshot(root: LocalRoot, path: string, destination: string, budget: { files: number; bytes: number }, signal?: AbortSignal) {
  if (signal?.aborted) throw new ProtocolError("cancelled", "Snapshot was cancelled.", false);
  assertNotSensitive(path);
  const source = await resolveResourcePath({ ...root, allowSensitivePaths: false }, "", "read");
  const canonical = await realpath(source);
  assertNotSensitive(canonical);
  if (canonical !== resolve(root.path))
    throw new ProtocolError("denied", "Shared folders must use their approved canonical paths.", false);
  const metadata = await lstat(canonical);
  const rootHandle = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const current = await rootHandle.stat();
    // Pin a directory descriptor. Nested traversal uses this descriptor rather than
    // re-opening parent paths that a collaborating host process could replace.
    if (current.dev !== metadata.dev || current.ino !== metadata.ino ||
        await realpath(`/proc/self/fd/${rootHandle.fd}`) !== canonical)
      throw new ProtocolError("conflict", "Shared folder changed while creating the snapshot.", false);
    await snapshotEntry(rootHandle, "", destination, budget, signal);
  } finally { await rootHandle.close(); }
}

async function snapshotEntry(parent: FileHandle, name: string, destination: string, budget: { files: number; bytes: number }, signal?: AbortSignal, depth = 0) {
  if (signal?.aborted) throw new ProtocolError("cancelled", "Snapshot was cancelled.", false);
  const source = `/proc/self/fd/${parent.fd}${name ? `/${name}` : ""}`;
  const metadata = name ? await lstat(source) : await parent.stat();
  if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) return;
  if (++budget.files > 4096 || depth > 64)
    throw new ProtocolError("denied", "The shared snapshot exceeds 4096 entries or 64 directory levels. Select a smaller folder.", false);
  if (metadata.isDirectory()) {
    const directory = name ? await open(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) : parent;
    try {
      const current = await directory.stat();
      if (current.dev !== metadata.dev || current.ino !== metadata.ino)
        throw new ProtocolError("conflict", "Shared folder changed while creating the snapshot.", false);
      await mkdir(destination, { recursive: true, mode: 0o777 });
      await chmod(destination, 0o777);
      for (const child of await readdir(`/proc/self/fd/${directory.fd}`)) {
        try { assertNotSensitive(child); } catch { continue; }
        await snapshotEntry(directory, child, resolve(destination, child), budget, signal, depth + 1);
      }
    } finally { if (directory !== parent) await directory.close(); }
  } else if (metadata.isFile() && metadata.nlink === 1) {
    if ((budget.bytes += metadata.size) > 100 * 1024 * 1024)
      throw new ProtocolError("denied", "The shared snapshot exceeds 100 MiB. Select a smaller folder.", false);
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.nlink !== 1 || current.ino !== metadata.ino || current.dev !== metadata.dev || current.size > metadata.size)
        throw new ProtocolError("conflict", "Shared files changed while creating the snapshot.", false);
      const data = Buffer.alloc(metadata.size + 1);
      let bytesRead = 0;
      while (bytesRead < data.length) {
        const next = await handle.read(data, bytesRead, data.length - bytesRead, bytesRead);
        if (!next.bytesRead) break;
        bytesRead += next.bytesRead;
      }
      if (bytesRead !== metadata.size) throw new ProtocolError("conflict", "Shared files changed during the snapshot.", false);
      const final = await handle.stat();
      if (final.nlink !== 1 || final.size !== metadata.size || final.mtimeMs !== current.mtimeMs || final.ctimeMs !== current.ctimeMs)
        throw new ProtocolError("conflict", "Shared files changed during the snapshot.", false);
      await writeFile(destination, data.subarray(0, bytesRead), { mode: metadata.mode & 0o111 ? 0o777 : 0o666 });
    } finally { await handle.close(); }
  }
}
