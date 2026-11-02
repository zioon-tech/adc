import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { NodeReleaseUpdate } from "@adc/client";

export interface NodeDistribution {
  directory: string;
  publicUrl: string;
  downloadUrl?: string;
}

const ReleaseSummarySchema = z
  .object({
    version: z.string().min(1),
    runtimeVersion: z.string().min(1),
    buildId: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  });
export type NodeReleaseSummary = z.infer<typeof ReleaseSummarySchema>;
const releaseCache = new Map<
  string,
  { expiresAt: number; value: NodeReleaseSummary | undefined; downloadUrl: string | undefined; installable: boolean }
>();
const releaseLoads = new Map<string, Promise<NodeReleaseSummary | undefined>>();

export function compareReleaseVersions(a: string, b: string): number | undefined {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  const left = parse(a), right = parse(b);
  if (!left || !right) return;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference) return difference;
  }
  if (!!left[4] !== !!right[4]) return left[4] ? -1 : 1;
  return left[4] === right[4] ? 0 : undefined;
}

export function nodeReleaseUpdate(
  buildId: string | undefined, latest: NodeReleaseSummary | undefined, currentVersion?: string
): NodeReleaseUpdate {
  const current = { currentBuildId: buildId ?? null, ...(currentVersion ? { currentVersion } : {}) };
  if (!latest) return { ...current, state: "unknown", reason: "release_unavailable" };
  if (!buildId && !currentVersion) return { ...current, state: "unknown", reason: "version_unreported", latest };
  const difference = currentVersion ? compareReleaseVersions(currentVersion, latest.version) : undefined;
  if (difference !== undefined && difference > 0) return { ...current, state: "ahead", latest };
  if (buildId === latest.buildId) return { ...current, state: "current", latest };
  if (!buildId && difference === 0) return { ...current, state: "unknown", reason: "build_unreported", latest };
  return { ...current, state: "update_available", latest };
}

export function distributionInfo(distribution?: NodeDistribution) {
  if (!distribution) return { available: false };
  const controlPlaneUrl = new URL(distribution.publicUrl).origin;
  const downloadUrl = distribution.downloadUrl
    ? new URL(distribution.downloadUrl).href.replace(/\/$/, "")
    : `${controlPlaneUrl}/downloads/node`;
  const parsed = new URL(downloadUrl);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== "https:" &&
      !(
        parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
      ))
  ) {
    throw new Error(
      "ADC_NODE_DOWNLOAD_URL must be HTTPS or loopback HTTP, without credentials/query/hash."
    );
  }
  return {
    available:
      !!distribution.downloadUrl ||
      (existsSync(resolve(distribution.directory, "install.sh")) &&
        existsSync(resolve(distribution.directory, "install.ps1"))),
    controlPlaneUrl,
    downloadUrl,
    installerUrl: `${downloadUrl}/install.sh`,
    windowsInstallerUrl: `${downloadUrl}/install.ps1`
  };
}

export async function latestNodeRelease(
  distribution?: NodeDistribution
): Promise<NodeReleaseSummary | undefined> {
  if (!distribution) return;
  const cacheKey = `${resolve(distribution.directory)}|${distribution.downloadUrl ?? ""}`;
  const cached = releaseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const running = releaseLoads.get(cacheKey);
  if (running) return running;
  const load = (async () => {
    let local: NodeReleaseSummary | undefined, remote: NodeReleaseSummary | undefined;
    for (const file of ["manifest-v2.json", "manifest.json"]) {
      try {
        local = ReleaseSummarySchema.parse(JSON.parse(await readFile(resolve(distribution.directory, file), "utf8")));
        break;
      } catch { /* Try the compatible local manifest. */ }
    }
    if (distribution.downloadUrl) {
      const info = distributionInfo(distribution);
      for (const file of ["manifest-v2.json", "manifest.json"]) {
        try {
          const response = await fetch(`${info.downloadUrl}/${file}`, { signal: AbortSignal.timeout(3_000) });
          if (!response.ok) continue;
          const body = await response.text();
          if (Buffer.byteLength(body) > 1024 * 1024) continue;
          remote = ReleaseSummarySchema.parse(JSON.parse(body));
          break;
        } catch { /* Keep local/last-known release available during network failure. */ }
      }
    }
    // Pair the version and its installer source. A stale external mirror cannot
    // mask a newer release already published by this control plane.
    let value = remote ?? local;
    let downloadUrl = remote ? distribution.downloadUrl : undefined;
    if (local && (!remote || (compareReleaseVersions(local.version, remote.version) ?? -1) > 0)) {
      value = local; downloadUrl = undefined;
    }
    const installable = !!value;
    // Retain metadata only when no source could be read. A successful refresh
    // describes what that source actually publishes, including a planned rollback.
    if (!value && cached?.value) {
      value = cached.value; downloadUrl = cached.downloadUrl;
    }
    releaseCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value, downloadUrl, installable });
    return value;
  })();
  releaseLoads.set(cacheKey, load);
  try { return await load; } finally { releaseLoads.delete(cacheKey); }
}

export async function currentNodeDistributionInfo(distribution?: NodeDistribution) {
  const latest = await latestNodeRelease(distribution);
  if (!distribution) return { ...distributionInfo(), latest };
  const selected = releaseCache.get(`${resolve(distribution.directory)}|${distribution.downloadUrl ?? ""}`);
  const { downloadUrl: _configured, ...local } = distribution;
  const info = distributionInfo(selected?.downloadUrl ? { ...local, downloadUrl: selected.downloadUrl } : local);
  return { ...info, available: info.available && selected?.installable === true, latest };
}

export function registerDistributionRoutes(app: FastifyInstance, distribution?: NodeDistribution) {
  distributionInfo(distribution); // Validate configured URLs before accepting requests.
  async function serve(file: string, reply: FastifyReply) {
    const allowed =
      ["install.sh", "install.ps1", "manifest.json", "manifest-v2.json", "SHA256SUMS"].includes(
        file
      ) ||
      /^adc-[a-zA-Z0-9._-]+-(?:(?:darwin|linux)-(?:arm64|x64)|win32-x64)-[a-f0-9]{16}\.(?:tar\.gz|zip)$/.test(
        file
      );
    if (!distribution || !allowed)
      return reply.code(404).send({ error: "Release file not found." });
    const path = resolve(distribution.directory, file);
    try {
      if (!(await stat(path)).isFile())
        return reply.code(404).send({ error: "Release file not found." });
    } catch {
      return reply.code(404).send({
        error: "Release is not built. Run pnpm build:node or configure ADC_NODE_DOWNLOAD_URL."
      });
    }
    reply.header(
      "cache-control",
      file.endsWith(".tar.gz") || file.endsWith(".zip")
        ? "public, max-age=31536000, immutable"
        : "no-cache"
    );
    reply.type(
      file.endsWith(".tar.gz") || file.endsWith(".zip")
        ? file.endsWith(".zip")
          ? "application/zip"
          : "application/gzip"
        : file.endsWith(".json")
          ? "application/json"
          : "text/plain; charset=utf-8"
    );
    return reply.send(createReadStream(path));
  }
  app.get("/install.sh", async (_request, reply) => serve("install.sh", reply));
  app.get("/install.ps1", async (_request, reply) => serve("install.ps1", reply));
  app.get(
    "/downloads/node/:file",
    async (request: FastifyRequest<{ Params: { file: string } }>, reply) =>
      serve(request.params.file, reply)
  );
}
