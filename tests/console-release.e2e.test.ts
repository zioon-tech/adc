import { mkdtemp, mkdir, writeFile, symlink, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MemoryStore } from "../packages/db/src/index.ts";
import { createControlPlane } from "../apps/control-plane/src/app.ts";
import { accessFixture } from "./helpers/access-fixture.ts";

it("serves new HTML and asset hashes after an atomic console release without restarting the control plane", async () => {
  const root = await mkdtemp(join(tmpdir(), "adc-console-release-"));
  const current = join(root, "current");
  let app: Awaited<ReturnType<typeof createControlPlane>> | undefined;
  try {
    for (const version of ["before", "after"]) {
      await mkdir(join(root, version, "assets"), { recursive: true });
      await writeFile(join(root, version, "index.html"), `<html><head><title>${version}</title></head><body>${version}</body></html>`);
      await writeFile(join(root, version, "assets", version + ".js"), `console.log("${version}");`);
    }
    await symlink(join(root, "before"), current);
    app = await createControlPlane({
      store: new MemoryStore(), access: accessFixture({ cookie: "fixture" }),
      assetStore: { async put() {}, async get() { return Buffer.alloc(0); } },
      consoleDirectory: current
    });
    expect((await app.inject("/")).body).toContain("before");
    await symlink(join(root, "after"), join(root, "next"));
    await rename(join(root, "next"), current);
    expect((await app.inject("/")).body).toContain("after");
    const asset = await app.inject("/assets/after.js");
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("after");
    expect((await app.inject("/health")).statusCode).toBe(200);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
