import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { DockerIsolation } from "../../apps/node/src/isolation.ts";
import { NodeDaemon } from "../../apps/node/src/daemon.ts";
import { validateLocalDelegation } from "../../apps/node/src/delegation.ts";
import { buildInvocation } from "../../packages/client/src/index.ts";
import { sha256 } from "../../packages/policy/src/index.ts";
import type { Invocation, PolicyDecision, InvocationResult } from "../../packages/protocol/src/index.ts";

const exec = promisify(execFile);
const image = process.env.ADC_ISOLATION_IMAGE!;
const workerBundle = process.env.ADC_ISOLATION_WORKER!;
assert(image?.includes("@sha256:") && workerBundle, "Supply pinned image and bundled worker");
const directory = await mkdtemp("/tmp/adc-isolation-e2e-");
const root = { rootId: "root_shared", path: resolve(directory, "project"), writable: true };
const readonlyRoot = { rootId: "root_readonly", path: resolve(directory, "readonly"), writable: false };
const stateDirectory = resolve(directory, "state");
const sharing = { enabled: true, trustedHost: false, isolation: "docker" as const, image };
const nodeId = "node_isolation_e2e";
const resourceAccountId = "acct_resource_e2e";
const requesterAccountId = "acct_requester_e2e";
const unsigned = {
  outcome: "allow" as const, reasonCode: "test.allowed", explanation: "Allowed",
  evaluatedLayers: ["account", "agent", "node", "root", "capability"] as PolicyDecision["evaluatedLayers"],
  profile: "workspace-write" as const
};
const decision = { ...unsigned, decisionHash: sha256(unsigned) };
const make = (command: string): Invocation => ({
  ...buildInvocation({
    context: { accountId: requesterAccountId, grantId: "grant_isolation_e2e", actorId: "actor_isolation_e2e", rootIds: [root.rootId] },
    target: { nodeId }, source: "sdk", tool: "shell.exec",
    args: { rootId: root.rootId, cwd: "", command, timeoutMs: 20_000 },
    idempotencyKey: `isolation-e2e-${Math.random().toString(36).slice(2)}`
  }),
  delegation: {
    version: 1, requesterAccountId, requesterUserId: "user-requester", resourceAccountId,
    bindingId: "binding_isolation_e2e", bindingRevision: 1, grantRevision: 1,
    scope: { roots: [root, readonlyRoot], allowedTools: ["shell.exec", "file.read"], execution: "isolated", approvalPolicy: "never", templateIds: [] },
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  }
});
const list = async () => (await exec("docker", ["ps", "--all", "--filter", "name=adc-guest-", "--format", "{{.Names}}"])).stdout.trim().split("\n").filter(Boolean);
const before = new Set(await list());
const checks: string[] = [];
try {
  await mkdir(root.path);
  await mkdir(readonlyRoot.path);
  await writeFile(resolve(readonlyRoot.path, "README.md"), "readonly-input");
  await writeFile(resolve(root.path, "README.md"), "original");
  await writeFile(resolve(root.path, ".env"), "HOST_CREDENTIAL_SENTINEL");
  await writeFile(resolve(directory, "outside.txt"), "outside");
  await symlink(resolve(directory, "outside.txt"), resolve(root.path, "escape"));
  process.env.ADC_HOST_SECRET_SENTINEL = "must-not-enter-guest";
  const isolation = new DockerIsolation({ stateDirectory, workerBundle, image });
  await isolation.verify();
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const os = require("node:os");
    assert.notEqual(process.getuid(), 0);
    assert.throws(() => process.kill(1, "SIGSTOP"), error => error.code === "EPERM");
    assert.equal(BigInt("0x" + fs.readFileSync("/proc/self/status", "utf8").match(/^CapEff:\\s+([0-9a-f]+)/m)[1]), 0n);
    assert.equal(fs.existsSync(${JSON.stringify(resolve(directory, "outside.txt"))}), false);
    assert.equal(fs.existsSync("/var/run/docker.sock"), false);
    assert.equal(fs.existsSync("/workspace/root_shared/.env"), false);
    assert.equal(fs.existsSync("/workspace/root_shared/escape"), false);
    assert.equal(process.env.ADC_HOST_SECRET_SENTINEL, undefined);
    assert(Object.values(os.networkInterfaces()).flat().every(x => x.internal));
    assert.throws(() => fs.writeFileSync("/snapshot/root_shared/README.md", "host-write"));
    assert.throws(() => fs.writeFileSync("/adc/worker.mjs", "override"));
    assert.throws(() => fs.writeFileSync("/etc/adc-injected", "override"));
    assert.throws(() => fs.writeFileSync("/workspace/root_readonly/README.md", "modify-input"));
    assert.throws(() => fs.renameSync("/workspace/root_readonly", "/workspace/replaced-input"));
    fs.writeFileSync("README.md", "guest-only");
    console.log("isolation-boundaries-ok");
  `;
  const invocation = make(`node -e '${script.replaceAll("'", "'\\''")}'`);
  await validateLocalDelegation(invocation, resourceAccountId, nodeId, [root, readonlyRoot], sharing, true);
  const result = await isolation.execute(invocation, [root, readonlyRoot], [], decision).catch(error => {
    console.error(JSON.stringify(error.details)); throw error;
  });
  assert.equal(result.succeeded, true);
  assert.match(String(result.output.stdout), /isolation-boundaries-ok/);
  assert.equal(await readFile(resolve(root.path, "README.md"), "utf8"), "original");
  checks.push("non-root, private network/PID, read-only source and image, credential/symlink exclusion, host environment exclusion, guest writes discarded");
  await assert.rejects(validateLocalDelegation(invocation, "acct_wrong_owner", nodeId, [root, readonlyRoot], sharing, true));
  await assert.rejects(validateLocalDelegation(invocation, resourceAccountId, nodeId, [root, readonlyRoot], sharing, false));
  await assert.rejects(validateLocalDelegation({
    ...invocation, tool: "file.read", args: { rootId: root.rootId, path: ".env", maxBytes: 1024 }
  } as Invocation, resourceAccountId, nodeId, [root, readonlyRoot], { ...sharing, trustedHost: true }, true));
  checks.push("local owner, verified isolation and protected-path enforcement");
  const finalLeaseDeadline = Date.now() + 1000;
  await assert.rejects(isolation.execute(make("node -e 'process.kill(process.ppid, \"SIGSTOP\"); setInterval(() => {}, 1000)'"), [root, readonlyRoot], [], decision, undefined, () => finalLeaseDeadline));
  assert((await list()).every((name) => before.has(name)));
  checks.push("guest-side watchdog stops the whole environment when the final recorded lease expires");

  const long = make("sh -c 'while :; do sleep 1; done' & wait");
  let pending = true;
  let completed: InvocationResult | undefined;
  let acknowledgedAt = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const response = path.endsWith("/poll") ? { dispatch: pending ? {
      dispatchId: "dsp_isolation_e2e", invocation: long, policyDecision: decision,
      leaseToken: "lease-isolation-e2e", leaseExpiresAt: new Date(Date.now() + 30_000).toISOString()
    } : null } : path.endsWith("/ack") ? (() => {
      acknowledgedAt = Date.now(); return { leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(), cancelRequested: false };
    })() : path.endsWith("/leases/renew") ? {
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(), cancelRequested: Date.now() - acknowledgedAt > 1500
    } : path.endsWith("/receipts") ? (() => {
      completed = JSON.parse(String(init?.body)).result; return { accepted: true };
    })() : {};
    if (path.endsWith("/poll")) pending = false;
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  };
  // Signing still uses a real device key; the test transport returns authoritative lease cancellation.
  const { generateNodeKeyPair } = await import("../../packages/client/src/node.ts");
  const keys = generateNodeKeyPair();
  const actual = new NodeDaemon({
    controlPlaneUrl: "http://localhost", nodeId, accountId: resourceAccountId, privateKey: keys.privateKey,
    roots: [root, readonlyRoot], stateDirectory, sharing, workerBundle, fetcher, leaseRenewIntervalMs: 50
  });
  assert.equal(await actual.runOnce(), true);
  assert.equal(completed?.status, "cancelled");
  const after = await list();
  assert(after.every((name) => before.has(name)), `Guest container survived: ${after}`);
  checks.push("actual NodeDaemon lease cancellation tears down detached guest processes and the entire container");
  pending = true; completed = undefined; acknowledgedAt = 0;
  const localRevocationFetcher: typeof fetch = async (url, init) =>
    new URL(String(url)).pathname.endsWith("/leases/renew") ? new Response(JSON.stringify({
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(), cancelRequested: false
    }), { headers: { "content-type": "application/json" } }) : fetcher(url, init);
  const localRevocation = new NodeDaemon({
    controlPlaneUrl: "http://localhost", nodeId, accountId: resourceAccountId, privateKey: keys.privateKey,
    roots: [root, readonlyRoot], stateDirectory, sharing, workerBundle,
    fetcher: localRevocationFetcher, leaseRenewIntervalMs: 50, configReloadIntervalMs: 50,
    loadAccess: async () => ({
      roots: acknowledgedAt && Date.now() - acknowledgedAt > 1500 ? [root] : [root, readonlyRoot],
      accessMode: "selected", templates: [], mcpProviders: [], sharing
    })
  });
  assert.equal(await localRevocation.runOnce(), true);
  assert.equal((completed as InvocationResult | undefined)?.status, "cancelled");
  assert((await list()).every(name => before.has(name)));
  checks.push("removing a non-selected shared root locally cancels mounted guest work without a server cancellation");
  const retargeted = { rootId: "root_retargeted", path: resolve(directory, "retargeted"), writable: false };
  await mkdir(resolve(directory, ".ssh"));
  await writeFile(resolve(directory, ".ssh", "id_ed25519"), "private-key-sentinel");
  await symlink(resolve(directory, ".ssh"), retargeted.path);
  const retargetInvocation = make("echo test");
  retargetInvocation.delegation!.scope.roots = [retargeted];
  retargetInvocation.tool = "file.read";
  retargetInvocation.args = { rootId: retargeted.rootId, path: "id_ed25519" };
  await assert.rejects(validateLocalDelegation(retargetInvocation, resourceAccountId, nodeId, [retargeted], sharing, true));
  await assert.rejects(isolation.execute(retargetInvocation, [retargeted], [], decision));
  checks.push("read-only guest mount cannot be modified/replaced; paused guest cannot stop supervisor expiry; retargeted credential roots denied");
  console.log(JSON.stringify({ ok: true, image, checks }, null, 2));
} finally {
  delete process.env.ADC_HOST_SECRET_SENTINEL;
  await rm(directory, { recursive: true, force: true });
}
