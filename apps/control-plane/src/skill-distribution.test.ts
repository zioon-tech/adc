import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Fastify from "fastify";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildSkill } from "../../../scripts/build-skill.ts";
import { registerSkillDistributionRoutes } from "./skill-distribution.ts";

describe("official Skill distribution", () => {
  it("publishes complete, deterministic archives and both discovery formats without exposing other files", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "adc-skill-"));
    const app = Fastify();
    try {
      const manifest = await buildSkill(directory);
      expect(await buildSkill(directory)).toEqual(manifest);
      registerSkillDistributionRoutes(app, { directory });
      const index = await app.inject("/.well-known/agent-skills/index.json");
      expect(index.statusCode).toBe(200);
      const entry = index.json().skills[0];
      expect(index.json().$schema).toBe(
        "https://schemas.agentskills.io/discovery/0.2.0/schema.json"
      );
      const archive = await app.inject(entry.url as string);
      expect(archive.statusCode).toBe(200);
      expect(archive.headers["content-type"]).toContain("application/zip");
      expect(archive.headers["cache-control"]).toContain("immutable");
      expect(entry.digest).toBe(
        `sha256:${createHash("sha256").update(archive.rawPayload).digest("hex")}`
      );
      const files = unzipSync(archive.rawPayload);
      expect(Object.keys(files).sort()).toEqual([...manifest.files].sort());
      expect(manifest.files).toContain("references/getting-started.md");
      for (const file of manifest.files) {
        const source = await readFile(
          resolve(import.meta.dirname, "../../../skills/agent-device-cloud", file)
        );
        expect(Buffer.from(files[file]!)).toEqual(source);
        for (const prefix of ["/.well-known/skills", "/.well-known/agent-skills"]) {
          const raw = await app.inject(`${prefix}/agent-device-cloud/${file}`);
          expect(raw.statusCode).toBe(200);
          expect(raw.rawPayload).toEqual(source);
          expect(raw.headers["cache-control"]).toBe("no-cache");
        }
      }
      const legacy = await app.inject("/.well-known/skills/index.json");
      expect(legacy.json().skills[0].files).toEqual(manifest.files);
      const current = await app.inject("/downloads/skills/agent-device-cloud.zip");
      expect(current.rawPayload).toEqual(archive.rawPayload);
      expect(current.headers["cache-control"]).toBe("no-cache");
      await writeFile(resolve(directory, ".env"), "not public");
      await writeFile(resolve(directory, "agent-device-cloud/references/private.md"), "not public");
      for (const path of [
        "/downloads/skills/.env",
        "/downloads/skills/unknown.zip",
        "/downloads/skills/%2Fetc%2Fpasswd",
        "/.well-known/skills/agent-device-cloud/references/private.md",
        "/.well-known/skills/agent-device-cloud/references/%2E%2E%2F%2Eenv"
      ]) {
        expect((await app.inject(path)).statusCode).toBe(404);
      }
      await rm(resolve(directory, "agent-device-cloud.zip"));
      await symlink(resolve(directory, ".env"), resolve(directory, "agent-device-cloud.zip"));
      expect((await app.inject("/downloads/skills/agent-device-cloud.zip")).statusCode).toBe(404);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns 404 when the distribution is absent or unbuilt", async () => {
    for (const distribution of [undefined, { directory: "/nonexistent-adc-skills" }]) {
      const app = Fastify();
      try {
        registerSkillDistributionRoutes(app, distribution);
        expect((await app.inject("/.well-known/agent-skills/index.json")).statusCode).toBe(404);
        expect((await app.inject("/downloads/skills/agent-device-cloud.zip")).statusCode).toBe(404);
      } finally {
        await app.close();
      }
    }
  });
});
