import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";

const ArchiveSchema = z
  .object({
    file: z.string().regex(/^adc-[a-zA-Z0-9._-]+\.(?:tar\.gz|zip)$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive()
  })
  .strict();
const ManifestEnvelopeSchema = z
  .object({
    version: z.string().min(1),
    runtimeVersion: z.string().min(1),
    buildId: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    archives: z.record(z.string(), z.unknown())
  })
  .strict();
const ReleaseSchema = z
  .object({
    version: z.string().min(1),
    runtime: z.string().min(1),
    buildId: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional()
  })
  .strict();
const NodeSourceSchema = z.object({ controlPlaneUrl: z.string().url() }).passthrough();
const UpdateNoticeSchema = z
  .object({
    checkedAt: z.iso.datetime({ offset: true }),
    currentRelease: z.string().min(1).optional(),
    available: z
      .object({
        version: z.string().min(1),
        release: z.string().min(1)
      })
      .strict()
      .optional(),
    updateAvailable: z.boolean()
  })
  .strict();

const UPDATE_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_NOTICE_COMMAND = "__update-notice";

export interface UpdateOptions {
  check: boolean;
  force: boolean;
  noService: boolean;
  downloadUrl?: string;
}

function updateURL(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Update URL must use HTTPS, or loopback HTTP, without credentials or query.");
  return url.href.replace(/\/$/, "");
}

function installDirectory(): string {
  return (
    process.env.ADC_INSTALL_DIR ??
    (process.platform === "win32"
      ? resolve(process.env.LOCALAPPDATA ?? homedir(), "Programs", "AgentDeviceCloud")
      : resolve(homedir(), ".local", "share", "agent-device-cloud"))
  );
}

function updateNoticePath(): string {
  if (process.env.ADC_UPDATE_NOTICE_CACHE) return resolve(process.env.ADC_UPDATE_NOTICE_CACHE);
  return process.platform === "win32"
    ? resolve(process.env.LOCALAPPDATA ?? homedir(), "AgentDeviceCloud", "cache", "update.json")
    : resolve(process.env.XDG_CACHE_HOME ?? resolve(homedir(), ".cache"), "adc", "update.json");
}

async function readUpdateNotice() {
  try {
    return UpdateNoticeSchema.parse(JSON.parse(await readFile(updateNoticePath(), "utf8")));
  } catch {
    return;
  }
}

async function writeUpdateNotice(notice: z.infer<typeof UpdateNoticeSchema>): Promise<void> {
  const path = updateNoticePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(notice)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function target(): string {
  const platform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform === "win32"
          ? "win32"
          : "";
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "";
  if (!platform || !architecture)
    throw new Error(`Updates are unavailable for ${process.platform}-${process.arch}.`);
  return `${platform}-${architecture}`;
}

async function fetchText(url: string, label: string): Promise<string> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error(`${label} is unexpectedly large.`);
  return text;
}

async function fetchOptionalText(url: string, label: string): Promise<string | undefined> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000)
  });
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error(`${label} is unexpectedly large.`);
  return text;
}

export function parseManifestForTarget(input: unknown, platform: string) {
  const manifest = ManifestEnvelopeSchema.parse(input);
  const candidate = manifest.archives[platform];
  if (candidate === undefined) throw new Error(`The update does not contain ${platform}.`);
  return { manifest, archive: ArchiveSchema.parse(candidate) };
}

async function releaseForTarget(downloadUrl: string, platform: string) {
  const current =
    (await fetchOptionalText(`${downloadUrl}/manifest-v2.json`, "Update manifest v2")) ??
    (await fetchText(`${downloadUrl}/manifest.json`, "Update manifest"));
  return parseManifestForTarget(JSON.parse(current), platform);
}

async function nodeControlPlane(): Promise<string | undefined> {
  const path =
    process.env.ADC_NODE_CONFIG ??
    (process.platform === "win32"
      ? resolve(process.env.LOCALAPPDATA ?? homedir(), "AgentDeviceCloud", "config", "node.json")
      : resolve(homedir(), ".config", "adc", "node.json"));
  try {
    return NodeSourceSchema.parse(JSON.parse(await readFile(path, "utf8"))).controlPlaneUrl;
  } catch {
    return;
  }
}

export function updateControlPlane(
  pairedControlPlane: string | undefined,
  environmentControlPlane: string | undefined
): string | undefined {
  return pairedControlPlane ?? environmentControlPlane;
}

async function runInstaller(
  script: string,
  options: { controlPlaneUrl?: string; downloadUrl: string; noService: boolean }
): Promise<void> {
  let temporary: string | undefined;
  let executable: string;
  let args: string[];
  if (process.platform === "win32") {
    temporary = await mkdtemp(resolve(tmpdir(), "adc-update-"));
    const installer = resolve(temporary, "install.ps1");
    await writeFile(installer, script, "utf8");
    executable = resolve(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installer,
      "-DownloadUrl",
      options.downloadUrl,
      ...(options.controlPlaneUrl ? ["-Url", options.controlPlaneUrl] : []),
      ...(options.noService ? ["-NoService"] : [])
    ];
  } else {
    executable = "/bin/sh";
    args = [
      "-s",
      "--",
      "--download-url",
      options.downloadUrl,
      ...(options.controlPlaneUrl ? ["--url", options.controlPlaneUrl] : []),
      ...(options.noService ? ["--no-service"] : [])
    ];
  }
  const child = spawn(executable, args, {
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let diagnostics = "";
  const relay = (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString()}`.slice(-16_384);
    process.stderr.write(chunk);
  };
  child.stdout.on("data", relay);
  child.stderr.on("data", relay);
  child.stdin.end(process.platform === "win32" ? undefined : script);
  const status = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  }).finally(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });
  if (status !== 0) {
    const detail = diagnostics.trim().split("\n").at(-1);
    throw new Error(
      detail ? `Update failed: ${detail}` : `Update failed with exit code ${status}.`
    );
  }
}

function releaseName(file: string): string {
  return file.replace(/\.(?:tar\.gz|zip)$/, "");
}

async function currentReleaseDirectory(installDirectory: string): Promise<string> {
  if (process.platform !== "win32") return realpath(resolve(installDirectory, "current"));
  const current = (await readFile(resolve(installDirectory, "current.txt"), "utf8")).trim();
  if (!current || basename(current) !== current)
    throw new Error("ADC installation has an invalid current release pointer.");
  return realpath(resolve(installDirectory, "releases", current));
}

export async function cachedUpdateNotice(
  activeRelease?: string,
  now = Date.now()
): Promise<{
  stale: boolean;
  update?: { version: string; release: string };
}> {
  const notice = await readUpdateNotice();
  const current =
    activeRelease ??
    (await currentReleaseDirectory(installDirectory())
      .then((directory) => basename(directory))
      .catch(() => undefined));
  const checkedAt = notice ? Date.parse(notice.checkedAt) : Number.NaN;
  const stale = !Number.isFinite(checkedAt) || now - checkedAt >= UPDATE_NOTICE_INTERVAL_MS;
  const update =
    notice?.updateAvailable &&
    notice.available &&
    current !== undefined &&
    notice.currentRelease === current
      ? notice.available
      : undefined;
  return { stale, ...(update ? { update } : {}) };
}

export async function refreshUpdateNotice(): Promise<void> {
  const checkedAt = new Date().toISOString();
  const previous = await readUpdateNotice();
  try {
    const status = await updateClient({
      check: true,
      force: false,
      noService: true
    });
    await writeUpdateNotice({
      checkedAt,
      currentRelease: status.current.release,
      available: {
        version: status.available.version,
        release: status.available.release
      },
      updateAvailable: status.updateAvailable
    });
  } catch {
    await writeUpdateNotice({
      ...(previous ?? { updateAvailable: false }),
      checkedAt
    }).catch(() => {});
  }
}

export function launchUpdateNoticeRefresh(entrypoint = process.argv[1]): void {
  if (!entrypoint) return;
  try {
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv.filter((argument) => !argument.startsWith("--inspect")),
        entrypoint,
        UPDATE_NOTICE_COMMAND
      ],
      {
        detached: true,
        env: process.env,
        stdio: "ignore",
        windowsHide: true
      }
    );
    child.unref();
  } catch {
    // Update discovery must never interfere with the foreground command.
  }
}

export async function updateClient(options: UpdateOptions) {
  const installation = installDirectory();
  const currentDirectory = await currentReleaseDirectory(installation).catch(() => {
    throw new Error("ADC is not installed through the managed installer.");
  });
  const current = ReleaseSchema.parse(
    JSON.parse(await readFile(resolve(currentDirectory, "release.json"), "utf8"))
  );
  // A managed launcher can outlive the server it was first installed from.
  // The paired node config is the durable identity source and must win.
  const controlPlaneUrl = updateControlPlane(
    await nodeControlPlane(),
    process.env.ADC_CONTROL_PLANE_URL
  );
  const source =
    options.downloadUrl ??
    process.env.ADC_UPDATE_URL ??
    (controlPlaneUrl ? `${controlPlaneUrl.replace(/\/$/, "")}/downloads/node` : undefined);
  if (!source)
    throw new Error("Update source is unavailable. Pass --download-url or reinstall ADC once.");
  const downloadUrl = updateURL(source);
  const platform = target();
  const { manifest, archive } = await releaseForTarget(downloadUrl, platform);
  const expectedRelease = releaseName(archive.file);
  const installedRelease = basename(currentDirectory);
  const updateAvailable =
    current.buildId && manifest.buildId
      ? current.buildId !== manifest.buildId
      : installedRelease !== expectedRelease;
  const status = {
    schemaVersion: "0.1",
    current: {
      version: current.version,
      runtimeVersion: current.runtime,
      buildId: current.buildId ?? null,
      release: installedRelease
    },
    available: {
      version: manifest.version,
      runtimeVersion: manifest.runtimeVersion,
      buildId: manifest.buildId ?? null,
      release: expectedRelease,
      bytes: archive.bytes
    },
    updateAvailable
  };
  if (options.check || (!updateAvailable && !options.force)) return status;

  const installerName = process.platform === "win32" ? "install.ps1" : "install.sh";
  const installer = await fetchText(`${downloadUrl}/${installerName}`, "Installer");
  if (
    process.platform === "win32"
      ? !installer.includes("# Generated release installer") ||
        !installer.includes("REM ADC managed launcher")
      : !installer.startsWith("#!/bin/sh") || !installer.includes("# ADC managed launcher")
  )
    throw new Error("Downloaded installer is not an ADC installer.");
  await runInstaller(installer, {
    ...(controlPlaneUrl ? { controlPlaneUrl } : {}),
    downloadUrl,
    noService: options.noService
  });
  const installedDirectory = await currentReleaseDirectory(installation);
  const installed = ReleaseSchema.parse(
    JSON.parse(await readFile(resolve(installedDirectory, "release.json"), "utf8"))
  );
  if (
    manifest.buildId
      ? installed.buildId !== manifest.buildId
      : basename(installedDirectory) !== expectedRelease
  )
    throw new Error("The installer completed but the expected release is not active.");
  return {
    ...status,
    updated: true,
    updateAvailable: false,
    current: {
      version: installed.version,
      runtimeVersion: installed.runtime,
      buildId: installed.buildId ?? null,
      release: basename(installedDirectory)
    }
  };
}
