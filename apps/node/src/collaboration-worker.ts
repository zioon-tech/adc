import { ToolRuntime } from "@adc/tool-runtime";
import { InvocationSchema, ResultSchema, type PolicyDecision } from "@adc/protocol";
import { chmod, cp, lstat, readFile, readdir } from "node:fs/promises";
async function writableCopy(path: string) {
  const metadata = await lstat(path);
  await chmod(path, metadata.isDirectory() || metadata.mode & 0o111 ? 0o777 : 0o666);
  if (metadata.isDirectory()) for (const child of await readdir(path)) await writableCopy(`${path}/${child}`);
}
import { spawn } from "node:child_process";
// PID 1 supervises the unprivileged worker. Guest code cannot signal this
// root-owned watchdog, even if it discovers PID 1 or stops its own parent.
if (process.argv.includes("--guest")) {
  await runGuest();
} else {
  if (process.getuid?.() !== 0) throw new Error("Isolation supervisor must own PID 1.");
  let checkingLease = false;
  const leaseTimer = setInterval(() => {
    if (checkingLease) return;
    checkingLease = true;
    void readFile("/adc/lifecycle/lease.json", "utf8").then(value => {
      const lease = JSON.parse(value);
      if (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= Date.now()) process.exit(75);
    }).catch(() => process.exit(75)).finally(() => { checkingLease = false; });
  }, 100);
  const inputParts: Buffer[] = [];
  let inputBytes = 0;
  for await (const part of process.stdin) {
    inputBytes += part.length;
    if (inputBytes > 4 * 1024 * 1024) throw new Error("Request too large");
    inputParts.push(Buffer.from(part));
  }
  const input = JSON.parse(Buffer.concat(inputParts).toString("utf8"));
  for (const root of input.roots) {
    if (!/^root_[A-Za-z0-9_-]+$/.test(root.rootId) || root.path !== `/workspace/${root.rootId}`)
      throw new Error("Invalid guest root");
    if (root.writable) {
      await cp(`/snapshot/${root.rootId}`, root.path, { recursive: true });
      await writableCopy(root.path);
    }
  }
  const guest = spawn(process.execPath, ["/adc/worker.mjs", "--guest"], {
    uid: 65534, gid: 65534, stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" }
  });
  guest.stdin.end(JSON.stringify(input));
  guest.stdin.on("error", () => {});
  guest.stdout.pipe(process.stdout);
  guest.stderr.pipe(process.stderr);
  guest.once("error", () => process.exit(74));
  const code = await new Promise<number | null>(resolve => guest.once("close", resolve));
  clearInterval(leaseTimer);
  // Explicit PID 1 exit reaps every guest descendant, including detached work.
  process.exit(code ?? 74);
}

async function runGuest() {
if (process.getuid?.() !== 65534) throw new Error("Guest must be unprivileged.");
let checkingLease = false;
const leaseTimer = setInterval(() => {
  if (checkingLease) return;
  checkingLease = true;
  void readFile("/adc/lifecycle/lease.json", "utf8").then((value) => {
    const lease = JSON.parse(value);
    if (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= Date.now()) process.exit(75);
  }).catch(() => process.exit(75)).finally(() => { checkingLease = false; });
}, 100);
let bytes = 0;
const parts: Buffer[] = [];
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 4 * 1024 * 1024) throw new Error("Request too large");
  parts.push(Buffer.from(chunk));
}
const input = JSON.parse(Buffer.concat(parts).toString("utf8"));
const invocation = InvocationSchema.parse(input.invocation);
const runtime = new ToolRuntime({
  nodeId: input.nodeId, roots: input.roots, templates: input.templates,
  stateDirectory: "/workspace/.state", fullTrust: true, protectSensitivePaths: true
});
const result = await runtime.execute(invocation, input.policyDecision as PolicyDecision);
const artifacts: Record<string, string> = {};
let artifactBytes = 0;
for (const id of result.receipt?.artifactRefs ?? []) {
  const data = await runtime.readArtifact(id);
  artifactBytes += data.length;
  if (artifactBytes > 2 * 1024 * 1024) throw new Error("Artifact export limit exceeded");
  artifacts[id] = data.toString("base64");
}
process.stdout.write(JSON.stringify({ result: ResultSchema.parse(result), artifacts }));
clearInterval(leaseTimer);
}
