import { describe, expect, it } from "vitest";
import { z } from "zod";
import { releaseManifests } from "../scripts/release-manifest.ts";

const LegacyArchiveSchema = z
  .object({
    file: z.string().regex(/^adc-[a-zA-Z0-9._-]+\.tar\.gz$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive()
  })
  .strict();
const LegacyManifestSchema = z
  .object({
    version: z.string(),
    runtimeVersion: z.string(),
    buildId: z.string(),
    archives: z.record(z.string(), LegacyArchiveSchema)
  })
  .strict();

describe("releaseManifests", () => {
  it("keeps the legacy manifest parseable while v2 retains Windows", () => {
    const manifests = releaseManifests({
      version: "0.1.1",
      runtimeVersion: "24.21.0",
      buildId: `sha256:${"a".repeat(64)}`,
      archives: {
        "darwin-arm64": {
          file: "adc-0.1.1-darwin-arm64-0123456789abcdef.tar.gz",
          sha256: "b".repeat(64),
          bytes: 1024
        },
        "win32-x64": {
          file: "adc-0.1.1-win32-x64-fedcba9876543210.zip",
          sha256: "c".repeat(64),
          bytes: 2048
        }
      }
    });

    expect(LegacyManifestSchema.parse(manifests.legacy).archives).toEqual({
      "darwin-arm64": manifests.current.archives["darwin-arm64"]
    });
    expect(manifests.current.archives["win32-x64"]?.file).toMatch(/\.zip$/);
  });
});
