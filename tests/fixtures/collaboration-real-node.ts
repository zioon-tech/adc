import { createInterface } from "node:readline";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { NodeDaemon } from "../../apps/node/src/daemon.ts";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let directory: string | undefined;
try {
  let daemon: NodeDaemon | undefined;
  for await (const line of lines) {
    const input = JSON.parse(line);
    if (input.action === "init") {
      directory = input.directory;
      await mkdir(`${directory}/project`, { recursive: true, mode: 0o700 });
      await writeFile(`${directory}/project/README.md`, "original");
      await writeFile(`${directory}/project/.env`, "HOST_SECRET_MUST_NOT_LEAVE");
      daemon = new NodeDaemon({
        controlPlaneUrl: input.origin, nodeId: input.nodeId, accountId: input.accountId, privateKey: input.privateKey,
        roots: [{ rootId: "root_shared", path: `${directory}/project`, writable: true }],
        sharing: { enabled: true, trustedHost: false, isolation: "docker", image: input.image },
        stateDirectory: `${directory}/state`, workerBundle: input.workerBundle, leaseRenewIntervalMs: 100
      });
      await daemon.runOnce();
      console.log(JSON.stringify({ event: "ready", capability: daemon.capability() }));
    } else if (input.action === "run") {
      const executed = await daemon!.runOnce();
      console.log(JSON.stringify({ event: "finished", executed, hostReadme: await readFile(`${directory}/project/README.md`, "utf8") }));
    } else if (input.action === "quit") break;
  }
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
