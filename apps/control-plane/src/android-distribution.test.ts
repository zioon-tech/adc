import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  readAndroidRelease,
  registerAndroidDistributionRoutes,
  type AndroidDistribution
} from "./android-distribution.ts";

const directories: string[] = [];
const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "adc-android-release-"));
  directories.push(directory);
  const distribution: AndroidDistribution = {
    directory,
    publicUrl: "https://devices.example.com"
  };
  const apk = Buffer.from("signed-apk-fixture");
  const file = "adc-mobile-node-0.1.2-aaaaaaaaaaaaaaaa.apk";
  const manifest = {
    schemaVersion: 1,
    packageName: "cloud.agentdevice.node",
    versionName: "0.1.2",
    versionCode: 3,
    minSdk: 26,
    publishedAt: "2026-10-11T08:00:00.000Z",
    required: false,
    releaseNotes: {
      "zh-CN": "新增版本检测和安全更新入口。",
      en: "Adds version discovery and verified updates."
    },
    apk: {
      url: `https://devices.example.com/downloads/android/${file}`,
      sha256: "a".repeat(64),
      bytes: apk.byteLength,
      signingCertificateSha256: "b".repeat(64)
    }
  };
  await writeFile(resolve(directory, file), apk);
  await writeFile(resolve(directory, "manifest.json"), JSON.stringify(manifest));
  return { directory, distribution, apk, file, manifest };
}

describe("Android release distribution", () => {
  it("validates and serves only the current manifest and APK", async () => {
    const { distribution, apk, file } = await fixture();
    const app = Fastify();
    apps.push(app);
    registerAndroidDistributionRoutes(app, distribution);

    await expect(readAndroidRelease(distribution)).resolves.toMatchObject({
      versionName: "0.1.2",
      versionCode: 3
    });
    const manifestResponse = await app.inject({
      method: "GET",
      url: "/downloads/android/manifest.json"
    });
    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.headers["cache-control"]).toBe("no-cache");
    expect(manifestResponse.json()).toMatchObject({ versionCode: 3 });

    const apkResponse = await app.inject({
      method: "GET",
      url: `/downloads/android/${file}`
    });
    expect(apkResponse.statusCode).toBe(200);
    expect(apkResponse.headers["content-type"]).toContain(
      "application/vnd.android.package-archive"
    );
    expect(apkResponse.rawPayload).toEqual(apk);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/downloads/android/adc-mobile-node-0.1.1-cccccccccccccccc.apk"
        })
      ).statusCode
    ).toBe(404);
  });

  it("returns not found while no signed Android release is published", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "adc-android-empty-"));
    directories.push(directory);
    const app = Fastify();
    apps.push(app);
    registerAndroidDistributionRoutes(app, {
      directory,
      publicUrl: "https://devices.example.com"
    });

    const response = await app.inject({
      method: "GET",
      url: "/downloads/android/manifest.json"
    });
    expect(response.statusCode).toBe(404);
  });

  it("serves a manual preview without publishing it as an automatic update", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "adc-android-preview-"));
    directories.push(directory);
    const preview = Buffer.from("manually-installed-preview-apk");
    await writeFile(resolve(directory, "preview.apk"), preview);
    const app = Fastify();
    apps.push(app);
    registerAndroidDistributionRoutes(app, {
      directory,
      publicUrl: "https://devices.example.com"
    });

    const previewResponse = await app.inject({
      method: "GET",
      url: "/downloads/android/preview.apk"
    });
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.headers["cache-control"]).toBe("no-cache");
    expect(previewResponse.headers["content-disposition"]).toContain("adc-mobile-node-preview.apk");
    expect(previewResponse.rawPayload).toEqual(preview);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/downloads/android/manifest.json"
        })
      ).statusCode
    ).toBe(404);
  });

  it("rejects a manifest whose APK is cross-origin or the wrong size", async () => {
    const { directory, distribution, manifest } = await fixture();
    await writeFile(
      resolve(directory, "manifest.json"),
      JSON.stringify({
        ...manifest,
        apk: {
          ...manifest.apk,
          url: manifest.apk.url.replace("devices.example.com", "untrusted.example.com")
        }
      })
    );
    await expect(readAndroidRelease(distribution)).rejects.toThrow(
      "configured public download origin"
    );

    await writeFile(
      resolve(directory, "manifest.json"),
      JSON.stringify({
        ...manifest,
        apk: { ...manifest.apk, bytes: manifest.apk.bytes + 1 }
      })
    );
    await expect(readAndroidRelease(distribution)).rejects.toThrow("missing or does not match");
  });
});
