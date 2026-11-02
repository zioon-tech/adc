import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Fastify from "fastify";
import { unzipSync } from "fflate";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import { describe, expect, it } from "vitest";
import { buildPlugins, pluginHosts } from "../../../scripts/build-plugins.ts";
import { registerPluginDistributionRoutes } from "./plugin-distribution.ts";

describe("complete harness plugin distribution", () => {
  it("publishes deterministic, source-complete packages with valid portable schemas and no escaped resources", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "adc-plugins-"));
    const app = Fastify();
    try {
      const index = await buildPlugins(directory);
      expect(await buildPlugins(directory)).toEqual(index);
      expect(index.map((entry) => entry.host)).toEqual([...pluginHosts, "marketplace"]);
      registerPluginDistributionRoutes(app, { directory });
      const validator = new AjvJsonSchemaValidator();
      const schemas = Object.fromEntries(
        await Promise.all(
          ["plugin", "mcp"].map(async (kind) => [
            kind,
            JSON.parse(
              await readFile(
                resolve(import.meta.dirname, `../../../plugins/contracts/${kind}.schema.json`),
                "utf8"
              )
            )
          ])
        )
      );
      for (const entry of index) {
        const response = await app.inject(`/downloads/plugins/${entry.file}`);
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toContain("immutable");
        expect(createHash("sha256").update(response.rawPayload).digest("hex")).toBe(entry.sha256);
        const files = unzipSync(response.rawPayload);
        expect(Object.keys(files).some((file) => file.startsWith("/") || file.includes(".."))).toBe(
          false
        );
        const alias = await app.inject(`/downloads/plugins/agent-device-cloud-${entry.host}.zip`);
        expect(alias.rawPayload).toEqual(response.rawPayload);
        expect(alias.headers["cache-control"]).toBe("no-cache");
        if (entry.host === "marketplace") {
          for (const host of ["claude", "cursor", "droid", "codex", "zion"]) {
            expect(Object.keys(files).some((path) => path.startsWith(`packages/${host}/`))).toBe(
              true
            );
          }
          const catalog = JSON.parse(
            Buffer.from(files[".agents/plugins/marketplace.json"]!).toString()
          );
          expect(catalog.plugins[0].source.path).toBe("./packages/codex");
          continue;
        }
        for (const kind of ["plugin", "mcp"]) {
          if (!files[`${kind}.json`]) continue;
          const manifest = JSON.parse(Buffer.from(files[`${kind}.json`]!).toString());
          if (manifest.$schema) {
            expect(validator.getValidator(schemas[kind] as JsonSchemaType)(manifest).valid).toBe(
              true
            );
            expect(
              validator.getValidator(schemas[kind] as JsonSchemaType)({
                ...manifest,
                unsupportedField: true
              }).valid
            ).toBe(false);
          }
        }
        for (const workflow of ["adc", "adc-setup"]) {
          const source = await readFile(
            resolve(import.meta.dirname, `../../../plugins/workflows/${workflow}/SKILL.md`)
          );
          expect(Buffer.from(files[`skills/${workflow}/SKILL.md`]!)).toEqual(source);
        }
        expect(files["skills/agent-device-cloud/references/getting-started.md"]).toBeDefined();
        const main = files["index.mjs"] ?? files["runtime.mjs"];
        if (main) expect(Buffer.from(main).toString()).not.toContain("../../packages/");
        if (entry.host === "zion") {
          const manifest = JSON.parse(Buffer.from(files["manifest.json"]!).toString());
          for (const path of Object.values(manifest.zion.entries) as string[])
            expect(
              path.includes("skills/") ? files[`${path.slice(2)}/SKILL.md`] : files[path.slice(2)]
            ).toBeDefined();
          expect(files["styles.css"]).toBeDefined();
          expect(files["host-compat.patch"]).toBeDefined();
        }
      }
      expect((await app.inject("/downloads/plugins/index.json")).json().plugins).toEqual(index);
      expect((await app.inject("/downloads/plugins/checksums.txt")).body).toContain(
        index[0]!.sha256
      );
      expect(
        (await app.inject("/downloads/plugins/agent-device-cloud-cline.mjs")).headers[
          "content-type"
        ]
      ).toContain("javascript");
      await writeFile(resolve(directory, ".env"), "private");
      for (const file of [
        ".env",
        "unknown.zip",
        "%2Fetc%2Fpasswd",
        "packages%2Fzion%2Fruntime.mjs"
      ])
        expect((await app.inject(`/downloads/plugins/${file}`)).statusCode).toBe(404);
      const name = "agent-device-cloud-zion.zip";
      await rm(resolve(directory, name));
      await symlink(resolve(directory, ".env"), resolve(directory, name));
      expect((await app.inject(`/downloads/plugins/${name}`)).statusCode).toBe(404);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("returns 404 for absent distributions", async () => {
    const app = Fastify();
    try {
      registerPluginDistributionRoutes(app);
      expect((await app.inject("/downloads/plugins/index.json")).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
