import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export interface AndroidDistribution {
  directory: string;
  publicUrl: string;
}

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const AndroidReleaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    packageName: z.literal("cloud.agentdevice.node"),
    versionName: z.string().regex(/^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/),
    versionCode: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    minSdk: z.number().int().min(21).max(10_000),
    publishedAt: z.string().datetime(),
    required: z.boolean(),
    releaseNotes: z
      .object({
        "zh-CN": z.string().min(1).max(20_000),
        en: z.string().min(1).max(20_000)
      })
      .catchall(z.string().min(1).max(20_000)),
    apk: z
      .object({
        url: z.string().min(1),
        sha256: Sha256Schema,
        bytes: z
          .number()
          .int()
          .positive()
          .max(250 * 1024 * 1024),
        signingCertificateSha256: Sha256Schema
      })
      .strict()
  })
  .strict();
export type AndroidReleaseManifest = z.infer<typeof AndroidReleaseManifestSchema>;

const APK_FILE_PATTERN = /^adc-mobile-node-[0-9A-Za-z._+-]+-[a-f0-9]{16}\.apk$/;
const MANIFEST_FILE = "manifest.json";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_APK_BYTES = 250 * 1024 * 1024;
const PREVIEW_FILE = "preview.apk";

export async function androidPreviewInfo(
  distribution?: AndroidDistribution
): Promise<{ url: string; bytes: number } | undefined> {
  if (!distribution) return;
  try {
    const metadata = await stat(resolve(distribution.directory, PREVIEW_FILE));
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_APK_BYTES) return;
    return {
      url: new URL(`/downloads/android/${PREVIEW_FILE}`, distribution.publicUrl).href,
      bytes: metadata.size
    };
  } catch {
    return;
  }
}

export async function readAndroidRelease(
  distribution?: AndroidDistribution
): Promise<AndroidReleaseManifest | undefined> {
  if (!distribution) return;
  let metadata;
  let body;
  try {
    const path = resolve(distribution.directory, MANIFEST_FILE);
    metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) return;
    body = await readFile(path, "utf8");
  } catch {
    return;
  }
  const release = AndroidReleaseManifestSchema.parse(JSON.parse(body));
  const publicOrigin = new URL(distribution.publicUrl).origin;
  const apkUrl = new URL(release.apk.url, `${publicOrigin}/downloads/android/manifest.json`);
  const fileName = basename(apkUrl.pathname);
  if (
    apkUrl.origin !== publicOrigin ||
    apkUrl.username ||
    apkUrl.password ||
    apkUrl.search ||
    apkUrl.hash ||
    apkUrl.pathname !== `/downloads/android/${fileName}` ||
    !APK_FILE_PATTERN.test(fileName)
  ) {
    throw new Error("Android release APK URL must use the configured public download origin.");
  }
  const apk = await stat(resolve(distribution.directory, fileName));
  if (!apk.isFile() || apk.size !== release.apk.bytes) {
    throw new Error("Android release APK is missing or does not match the manifest size.");
  }
  return release;
}

export function registerAndroidDistributionRoutes(
  app: FastifyInstance,
  distribution?: AndroidDistribution
) {
  app.get("/downloads/android/preview.apk", async (_request, reply) => {
    const preview = await androidPreviewInfo(distribution);
    if (!preview) return reply.code(404).send({ error: "Android preview is not published." });
    reply
      .header("cache-control", "no-cache")
      .header("content-disposition", 'attachment; filename="adc-mobile-node-preview.apk"')
      .header("content-length", preview.bytes)
      .type("application/vnd.android.package-archive");
    return reply.send(createReadStream(resolve(distribution!.directory, PREVIEW_FILE)));
  });

  app.get(
    "/downloads/android/:file",
    async (request: FastifyRequest<{ Params: { file: string } }>, reply: FastifyReply) => {
      let release: AndroidReleaseManifest | undefined;
      try {
        release = await readAndroidRelease(distribution);
      } catch (error) {
        request.log.error({ err: error }, "Android release validation failed");
        return reply.code(503).send({ error: "Android release is temporarily unavailable." });
      }
      if (!release) return reply.code(404).send({ error: "Android release is not published." });
      const file = request.params.file;
      if (file === MANIFEST_FILE) {
        return reply.header("cache-control", "no-cache").type("application/json").send(release);
      }
      const publicOrigin = new URL(distribution!.publicUrl).origin;
      const apkFile = basename(
        new URL(release.apk.url, `${publicOrigin}/downloads/android/manifest.json`).pathname
      );
      if (file !== apkFile) {
        return reply.code(404).send({ error: "Android release file not found." });
      }
      reply
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("content-disposition", `attachment; filename="${apkFile}"`)
        .type("application/vnd.android.package-archive");
      return reply.send(createReadStream(resolve(distribution!.directory, apkFile)));
    }
  );
}
