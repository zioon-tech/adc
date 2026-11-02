import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { latestNodeRelease } from "./distribution.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("latestNodeRelease", () => {
  it("prefers the complete v2 manifest", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "adc-release-"));
    directories.push(directory);
    await writeFile(
      resolve(directory, "manifest.json"),
      JSON.stringify({
        version: "0.1.0",
        runtimeVersion: "24.21.0",
        buildId: `sha256:${"a".repeat(64)}`
      })
    );
    await writeFile(
      resolve(directory, "manifest-v2.json"),
      JSON.stringify({
        version: "0.1.1",
        runtimeVersion: "24.21.0",
        buildId: `sha256:${"b".repeat(64)}`
      })
    );

    await expect(
      latestNodeRelease({
        directory,
        publicUrl: "https://devices.example.com"
      })
    ).resolves.toMatchObject({ version: "0.1.1", buildId: `sha256:${"b".repeat(64)}` });
  });

  it("falls back to the legacy manifest", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "adc-release-"));
    directories.push(directory);
    await writeFile(
      resolve(directory, "manifest.json"),
      JSON.stringify({
        version: "0.1.0",
        runtimeVersion: "24.21.0",
        buildId: `sha256:${"a".repeat(64)}`
      })
    );

    await expect(
      latestNodeRelease({
        directory,
        publicUrl: "https://devices.example.com"
      })
    ).resolves.toMatchObject({ version: "0.1.0" });
  });
});
