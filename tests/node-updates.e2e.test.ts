import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../packages/db/src/index.ts";
import { AdcClient } from "../packages/client/src/index.ts";
import { NodeApiClient, generateNodeKeyPair } from "../packages/client/src/node.ts";
import { CapabilitySchema, type NodePlatform } from "../packages/protocol/src/index.ts";
import { createControlPlane } from "../apps/control-plane/src/app.ts";
import { accessFixture } from "./helpers/access-fixture.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });
const release = (version: string, digit: string) => ({ version, runtimeVersion: "24.21.0", buildId: `sha256:${digit.repeat(64)}` });

async function fixture(local?: ReturnType<typeof release>, remote?: ReturnType<typeof release>) {
  const directory = await mkdtemp(join(tmpdir(), "adc-update-e2e-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  if (local) {
    await writeFile(join(directory, "manifest-v2.json"), JSON.stringify(local));
    await writeFile(join(directory, "install.sh"), "# installer");
    await writeFile(join(directory, "install.ps1"), "# installer");
  }
  let mirrorRequests = 0;
  const server = createServer((request, response) => {
    mirrorRequests++;
    response.writeHead(remote ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify(remote ?? {}));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing mirror port");
  const mirror = `http://127.0.0.1:${address.port}/node`;
  const cookie = "adc.session_token=updates";
  const store = new MemoryStore();
  const app = await createControlPlane({ store, access: accessFixture({ cookie }),
    nodeDistribution: { directory, publicUrl: "https://adc.test", downloadUrl: mirror } });
  cleanup.push(() => app.close());
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const result = await app.inject({ method: (init?.method ?? "GET") as any,
      url: `${url.pathname}${url.search}`, headers: Object.fromEntries(new Headers(init?.headers)),
      ...(typeof init?.body === "string" ? { payload: init.body } : {}) });
    return new Response(result.body, { status: result.statusCode, headers: result.headers as Record<string, string> });
  };
  const client = new AdcClient("http://adc.test", { cookie }, fetcher);
  async function pair(platform: NodePlatform, version?: string, buildId?: string, offline = false) {
    const keys = generateNodeKeyPair();
    const code = await client.createPairingCode();
    const paired = await new NodeApiClient("http://adc.test", undefined, keys.privateKey, fetcher).pair({
      code: code.code, label: `${platform}-${version ?? "unreported"}`, platform, publicKey: keys.publicKey });
    if (version) {
      const capability = CapabilitySchema.parse({ schemaVersion: "0.1", nodeId: paired.nodeId, platform,
        nodeVersion: version, ...(buildId ? { buildId } : {}), tools: [], roots: [], advertisedAt: new Date().toISOString() });
      await store.updateNodePresence(paired.nodeId, capability, new Date(Date.now() - (offline ? 86_400_000 : 0)));
    }
    return paired.nodeId;
  }
  return { client, pair, mirror, getMirrorRequests: () => mirrorRequests };
}

describe("Connector release and console status over API", () => {
  it("uses a newer locally published release and its installer instead of a stale configured mirror", async () => {
    const local = release("0.1.6", "b"), remote = release("0.1.4", "a");
    const f = await fixture(local, remote);
    await f.pair("linux", "0.1.4", remote.buildId);
    await f.pair("darwin", "0.1.6", local.buildId);
    await f.pair("win32", "0.1.4", remote.buildId, true);
    await f.pair("linux");
    await f.pair("android", "0.1.4");
    await f.pair("linux", "0.1.6");
    const nodes = await f.client.listNodes();
    expect(nodes[0]!.update).toMatchObject({ state: "update_available", latest: local, currentVersion: "0.1.4" });
    expect(nodes[1]!.update).toMatchObject({ state: "current", latest: local });
    expect(nodes[2]!.online).toBe(false);
    expect(nodes[2]!.update?.state).toBe("update_available");
    expect(nodes[3]!.update).toMatchObject({ state: "unknown", reason: "version_unreported" });
    expect(nodes[4]!.update).toBeUndefined();
    expect(nodes[5]!.update).toMatchObject({ state: "unknown", reason: "build_unreported", latest: local });
    const installation = await f.client.nodeInstallation();
    expect(installation.downloadUrl).toBe("https://adc.test/downloads/node");
    expect(installation.latest?.version).toBe("0.1.6");
    await f.client.listNodes();
    expect(f.getMirrorRequests()).toBe(1);
  });
  it("keeps a local release visible when the mirror fails, and shows unknown when neither source is available", async () => {
    const local = release("0.1.6", "c");
    const working = await fixture(local);
    await working.pair("linux", "0.1.4");
    expect((await working.client.listNodes())[0]!.update?.state).toBe("update_available");
    const unavailable = await fixture();
    await unavailable.pair("linux", "0.1.4");
    expect((await unavailable.client.listNodes())[0]!.update).toMatchObject({ state: "unknown", reason: "release_unavailable" });
  });
  it("uses a newer external release with its matching installer and never recommends a downgrade", async () => {
    const f = await fixture(release("0.1.4", "a"), release("0.1.6", "b"));
    await f.pair("linux", "0.1.7", `sha256:${"d".repeat(64)}`);
    expect((await f.client.listNodes())[0]!.update?.state).toBe("ahead");
    expect((await f.client.nodeInstallation()).downloadUrl).toBe(f.mirror);
  });
  it("reconciles a successful mirror rollback rather than pairing cached metadata with an older installer", async () => {
    const local = release("0.1.6", "e");
    const directory = await mkdtemp(join(tmpdir(), "adc-mirror-rollback-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, "manifest-v2.json"), JSON.stringify(local));
    await writeFile(join(directory, "install.sh"), "# local0.1.6");
    await writeFile(join(directory, "install.ps1"), "# local0.1.6");
    let served = release("0.1.7", "f");
    const server = createServer((_request, response) => { response.end(JSON.stringify(served)); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing mirror port");
    const { currentNodeDistributionInfo } = await import("../apps/control-plane/src/distribution.ts");
    const distribution = { directory, publicUrl: "https://adc.test", downloadUrl: `http://127.0.0.1:${address.port}/node` };
    expect((await currentNodeDistributionInfo(distribution)).latest?.version).toBe("0.1.7");
    served = release("0.1.4", "a");
    const currentTime = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(currentTime + 61_000);
    try {
      const info = await currentNodeDistributionInfo(distribution);
      expect(info.latest?.version).toBe("0.1.6");
      expect(info.downloadUrl).toBe("https://adc.test/downloads/node");
      expect(info.available).toBe(true);
    } finally { clock.mockRestore(); }
  });
});
