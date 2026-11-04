import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import Fastify from "fastify";
import { registerSdkDistributionRoutes } from "../../apps/control-plane/src/sdk-distribution.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const temporary = await mkdtemp(resolve(tmpdir(), "adc-client-consumer-"));
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const node = await json(resolve(root, "dist/node/manifest-v2.json"));
const sdk = await json(resolve(root, "dist/sdk/manifest.json"));
const context = {
  accountId: "acct_release",
  actorId: "actor_release",
  grantId: "grant_release",
  nodeIds: ["node_release"],
  rootIds: ["root_release"]
};
const session = `ctl_${"a".repeat(32)}`;
const received = [];
const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/v1/me") {
    response.end(
      JSON.stringify({
        kind: "agent",
        context,
        grant: { name: "release", allowedTools: ["file.read"] }
      })
    );
  } else if (request.method === "POST" && request.url === "/api/v1/invocations?waitMs=0") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const invocation = JSON.parse(body);
    received.push(invocation);
    response.end(
      JSON.stringify({
        schemaVersion: "0.1",
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        status: "succeeded",
        output: "release-smoke"
      })
    );
  } else {
    response.statusCode = 404;
    response.end("{}");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  assert.deepEqual(Object.keys(node.archives).sort(), [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-x64"
  ]);
  let cliHash;
  for (const [platform, archive] of Object.entries(node.archives)) {
    const path = resolve(root, "dist/node", archive.file);
    const bytes = await readFile(path);
    assert.equal(hash(bytes), archive.sha256);
    assert.equal(bytes.length, archive.bytes);
    let release, cli;
    if (platform.startsWith("win32")) {
      const files = unzipSync(bytes);
      release = files["release.json"];
      cli = files["lib/adc.mjs"];
      assert(files["runtime/bin/node.exe"]);
    } else {
      release = (await exec("tar", ["-xOf", path, "./release.json"])).stdout;
      cli = (await exec("tar", ["-xOf", path, "./lib/adc.mjs"], { maxBuffer: 32 * 1024 * 1024 }))
        .stdout;
    }
    assert.equal(JSON.parse(Buffer.from(release).toString()).buildId, node.buildId);
    const nextHash = hash(cli);
    cliHash ??= nextHash;
    assert.equal(nextHash, cliHash, "Every platform must contain the same CLI build");
  }
  const target = `${process.platform}-${process.arch}`;
  assert(node.archives[target], `No runnable CLI artifact for ${target}`);
  const cliDirectory = resolve(temporary, "cli");
  await mkdir(cliDirectory);
  await exec("tar", [
    "-xzf",
    resolve(root, "dist/node", node.archives[target].file),
    "-C",
    cliDirectory
  ]);
  const runtime = resolve(cliDirectory, "runtime/bin/node");
  const executable = resolve(cliDirectory, "lib/adc.mjs");
  const env = {
    ...process.env,
    ADC_URL: origin,
    ADC_TOKEN: "release-test-only",
    ADC_CONFIG: resolve(temporary, "config.json"),
    ADC_NO_UPDATE_NOTIFIER: "1"
  };
  assert.equal(
    (await exec(runtime, [executable, "--version"], { env })).stdout.trim(),
    node.version
  );
  const help = (await exec(runtime, [executable, "--help"], { env })).stdout;
  assert(help.includes("--intent PURPOSE") && help.includes("--control-session TOKEN"));
  const invoke = [
    "invoke",
    "file.read",
    "--args",
    JSON.stringify({ rootId: "root_release", path: "README.md" }),
    "--intent",
    "Verify released client metadata",
    "--control-session",
    session,
    "--json"
  ];
  await exec(runtime, [executable, ...invoke], { env });
  assert.deepEqual(received[0].metadata, {
    source: "cli",
    intent: "Verify released client metadata",
    controlSessionId: session
  });
  // The CLI-backed plugin path must preserve the same fields.
  await exec(runtime, [executable, ...invoke, "--source", "skill"], { env });
  assert.equal(received[1].metadata.source, "skill");
  assert.equal(received[1].metadata.controlSessionId, session);
  const sdkArchive = resolve(root, "dist/sdk", sdk.archive.file);
  assert.equal(hash(await readFile(sdkArchive)), sdk.archive.sha256);
  await writeFile(
    resolve(temporary, "package.json"),
    '{"name":"adc-release-consumer","private":true,"type":"module"}\n'
  );
  // Offline install proves there is no private workspace dependency or registry requirement.
  await exec(
    "npm",
    ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", sdkArchive],
    { cwd: temporary }
  );
  const consumer = `
import assert from "node:assert/strict";
import { AdcClient, buildInvocation, type InvocationContext } from "@adc/client";
import { generateNodeKeyPair, signNodeRequest, verifyNodeRequest } from "@adc/client/node";
const context: InvocationContext = ${JSON.stringify(context)};
const invocation = buildInvocation({
  context, tool: "file.read", args: { rootId: "root_release", path: "README.md" }, source: "sdk",
  intent: "Verify SDK metadata", controlSessionId: ${JSON.stringify(session)}
});
assert.equal(invocation.metadata?.controlSessionId, ${JSON.stringify(session)});
assert.throws(() => buildInvocation({ context, tool: "file.read", args: {}, source: "sdk", intent: "\\n" }));
const result = await new AdcClient(${JSON.stringify(origin)}, "release-test-only").invoke(invocation);
assert.equal(result.status, "succeeded");
const key = generateNodeKeyPair();
const payload = { method: "GET", path: "/api/v1/node/poll", timestamp: new Date().toISOString(), nonce: "release-test" };
assert(verifyNodeRequest(key.publicKey, signNodeRequest(key.privateKey, payload), payload));
`;
  await writeFile(resolve(temporary, "consumer.mts"), consumer);
  await exec(
    process.execPath,
    [
      resolve(root, "node_modules/typescript/bin/tsc"),
      "consumer.mts",
      "--module",
      "NodeNext",
      "--target",
      "ES2023",
      "--strict",
      "--types",
      "node",
      "--typeRoots",
      resolve(root, "node_modules/@types")
    ],
    { cwd: temporary }
  );
  await exec(process.execPath, ["consumer.mjs"], { cwd: temporary });
  assert.deepEqual(received[2].metadata, {
    source: "sdk",
    intent: "Verify SDK metadata",
    controlSessionId: session
  });
  const app = Fastify();
  registerSdkDistributionRoutes(app, { directory: resolve(root, "dist/sdk") });
  const manifest = await app.inject({ url: "/downloads/sdk/manifest.json" });
  assert.equal(manifest.statusCode, 200);
  assert.equal(manifest.headers["cache-control"], "no-cache");
  const download = await app.inject({ url: `/downloads/sdk/${sdk.archive.file}` });
  assert.equal(download.statusCode, 200);
  assert.equal(hash(download.rawPayload), sdk.archive.sha256);
  assert(download.headers["cache-control"].includes("immutable"));
  for (const file of [
    ".env",
    "package.json",
    "%2e%2e%2fmanifest.json",
    "adc-client-0.2.3-ffffffffffffffff.tgz"
  ]) {
    assert.equal((await app.inject({ url: `/downloads/sdk/${file}` })).statusCode, 404);
  }
  await app.close();
  const hostile = resolve(temporary, "hostile");
  await mkdir(hostile);
  await symlink(resolve(root, "dist/sdk/manifest.json"), resolve(hostile, "manifest.json"));
  const protectedApp = Fastify();
  registerSdkDistributionRoutes(protectedApp, { directory: hostile });
  assert.equal(
    (await protectedApp.inject({ url: "/downloads/sdk/manifest.json" })).statusCode,
    404
  );
  await protectedApp.close();
  console.log(
    JSON.stringify({
      status: "client_tools_verified",
      cliVersion: node.version,
      sdkVersion: sdk.version,
      platforms: Object.keys(node.archives),
      offlineSdkInstall: true,
      sdkTypes: true,
      cliAndSkillMetadata: true,
      sdkMetadata: true,
      nodeSigning: true,
      safeSdkDownload: true
    })
  );
} finally {
  await new Promise((done) => server.close(done));
  await rm(temporary, { recursive: true, force: true });
}
