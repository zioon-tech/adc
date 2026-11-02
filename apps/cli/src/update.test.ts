import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cachedUpdateNotice, parseManifestForTarget, updateControlPlane } from "./update.ts";

const archive = {
  file: "adc-0.1.1-darwin-arm64-0123456789abcdef.tar.gz",
  sha256: "a".repeat(64),
  bytes: 1024
};
const directories: string[] = [];
const originalCache = process.env.ADC_UPDATE_NOTICE_CACHE;

afterEach(async () => {
  if (originalCache === undefined) delete process.env.ADC_UPDATE_NOTICE_CACHE;
  else process.env.ADC_UPDATE_NOTICE_CACHE = originalCache;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("parseManifestForTarget", () => {
  it("validates only the current platform archive", () => {
    const result = parseManifestForTarget(
      {
        version: "0.1.1",
        runtimeVersion: "24.21.0",
        buildId: `sha256:${"b".repeat(64)}`,
        archives: {
          "darwin-arm64": archive,
          "future-platform": {
            file: "adc-0.1.1-future-platform.pkg",
            metadata: { format: "unknown-to-this-client" }
          }
        }
      },
      "darwin-arm64"
    );
    expect(result.archive).toEqual(archive);
  });

  it("rejects a malformed current platform archive", () => {
    expect(() =>
      parseManifestForTarget(
        {
          version: "0.1.1",
          runtimeVersion: "24.21.0",
          archives: { "darwin-arm64": { ...archive, sha256: "invalid" } }
        },
        "darwin-arm64"
      )
    ).toThrow();
  });

  it("reports a missing current platform explicitly", () => {
    expect(() =>
      parseManifestForTarget(
        {
          version: "0.1.1",
          runtimeVersion: "24.21.0",
          archives: {}
        },
        "linux-x64"
      )
    ).toThrow("The update does not contain linux-x64.");
  });
});

describe("cachedUpdateNotice", () => {
  it("returns a fresh update only for the active installed release", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "adc-update-notice-"));
    directories.push(directory);
    const path = resolve(directory, "update.json");
    process.env.ADC_UPDATE_NOTICE_CACHE = path;
    const checkedAt = new Date("2026-10-11T00:00:00.000Z");
    await writeFile(
      path,
      JSON.stringify({
        checkedAt: checkedAt.toISOString(),
        currentRelease: "adc-0.1.0-darwin-arm64-old",
        available: {
          version: "0.1.1",
          release: "adc-0.1.1-darwin-arm64-new"
        },
        updateAvailable: true
      })
    );

    await expect(
      cachedUpdateNotice("adc-0.1.0-darwin-arm64-old", checkedAt.getTime() + 60 * 60 * 1000)
    ).resolves.toEqual({
      stale: false,
      update: {
        version: "0.1.1",
        release: "adc-0.1.1-darwin-arm64-new"
      }
    });
    await expect(
      cachedUpdateNotice("adc-0.1.1-darwin-arm64-new", checkedAt.getTime() + 25 * 60 * 60 * 1000)
    ).resolves.toEqual({ stale: true });
  });
});

describe("updateControlPlane", () => {
  it("prefers the durable paired-node URL over a stale launcher environment", () => {
    expect(updateControlPlane("https://devices.example.com", "http://localhost:8787")).toBe(
      "https://devices.example.com"
    );
  });
});
