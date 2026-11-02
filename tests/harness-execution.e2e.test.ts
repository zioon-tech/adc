import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AdcClient } from "../packages/client/src/index.ts";
import { NodeApiClient, generateNodeKeyPair } from "../packages/client/src/node.ts";
import { MemoryStore } from "../packages/db/src/index.ts";
import {
  createCliRunner,
  createCliTransport,
  createSdkTransport,
  executeNativeTool
} from "../packages/harness-core/src/index.ts";
import { createControlPlane } from "../apps/control-plane/src/app.ts";
import { NodeDaemon } from "../apps/node/src/daemon.ts";
import { accessFixture } from "./helpers/access-fixture.ts";

describe("harness adapters through the real ADC execution path", () => {
  it("shares CLI/SDK scope, executes once, preserves approval and cancels the existing task", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "adc-harness-execution-"));
    const cookie = "adc.session_token=harness-test";
    const token = "harness-test-token";
    const store = new MemoryStore();
    const access = accessFixture({
      cookie,
      agents: { [token]: { accountId: "acct_primary", grantId: "grant_harness" } }
    });
    const app = await createControlPlane({ store, access });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    access.origin = address;
    const sdk = createSdkTransport(address, token);
    // The native adapters spawn the actual public CLI without a shell for user arguments.
    const executable = resolve(directory, "adc");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(
      executable,
      `#!/bin/sh\nexport ADC_URL=${quote(address)} ADC_TOKEN=${quote(token)} ADC_CONFIG=${quote(resolve(directory, "config.json"))}\nexec ${quote(process.execPath)} --import tsx ${quote(resolve("apps/cli/src/main.ts"))} "$@"\n`,
      { mode: 0o700 }
    );
    const runner = createCliRunner(executable);
    const cli = createCliTransport(async (args, signal) => {
      try {
        return await runner.run(args, signal);
      } catch (error) {
        throw new Error(`${args.slice(0, 2).join(" ")}: ${(error as Error).message}`);
      }
    });
    try {
      const owner = new AdcClient(address, { cookie });
      const keys = generateNodeKeyPair();
      const paired = await new NodeApiClient(address, undefined, keys.privateKey).pair({
        code: (await owner.createPairingCode()).code,
        label: "Harness device",
        platform: "darwin",
        publicKey: keys.publicKey
      });
      const daemon = new NodeDaemon({
        controlPlaneUrl: address,
        nodeId: paired.nodeId,
        privateKey: keys.privateKey,
        roots: [{ rootId: "root_harness", path: directory, writable: true }],
        stateDirectory: resolve(directory, ".node-state")
      });
      await daemon.runOnce();
      const grant = async (approvalPolicy: string) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/grants",
          headers: { cookie, origin: address },
          payload: {
            grantId: "grant_harness",
            nodeIds: [paired.nodeId],
            rootAccess: "all",
            approvalPolicy,
            allowedTools: [
              "device.list",
              "file.read",
              "file.write",
              "shell.exec",
              "task.status",
              "task.wait",
              "task.cancel"
            ]
          }
        });
        expect(response.statusCode, response.body).toBe(200);
      };
      await grant("never");
      const sdkDiscovery = await sdk.discover();
      const cliDiscovery = await cli.discover();
      expect(cliDiscovery.devices.map((item) => item.nodeId)).toEqual([paired.nodeId]);
      expect(cliDiscovery.tools).toEqual(sdkDiscovery.tools);
      const input = {
        tool: "file.write",
        args: { rootId: "root_harness", path: "result.txt", content: "once" },
        nodeId: paired.nodeId,
        idempotencyKey: "harness-write-once",
        waitMs: 0
      };
      await expect(executeNativeTool(sdk, "adc_read", input)).rejects.toThrow("side effect");
      const first: any = await executeNativeTool(sdk, "adc_invoke", input);
      const duplicate: any = await executeNativeTool(cli, "adc_invoke", input);
      expect(first.status).toBe("queued");
      expect(duplicate.jobId).toBe(first.jobId);
      await expect(daemon.runOnce()).resolves.toBe(true);
      expect(await readFile(resolve(directory, "result.txt"), "utf8")).toBe("once");
      const result: any = await executeNativeTool(cli, "adc_task", {
        invocationId: duplicate.invocationId,
        waitMs: 0
      });
      expect(result).toMatchObject({ status: "succeeded", receipt: { sideEffect: true } });
      const read: any = await executeNativeTool(cli, "adc_read", {
        tool: "file.read",
        nodeId: paired.nodeId,
        args: { rootId: "root_harness", path: "result.txt" },
        waitMs: 0
      });
      await daemon.runOnce();
      const completed: any = await executeNativeTool(sdk, "adc_task", {
        jobId: read.jobId,
        waitMs: 0
      });
      expect(completed.status).toBe("succeeded");
      expect(completed.output.content).toBe("once");

      const cancelled: any = await executeNativeTool(sdk, "adc_invoke", {
        ...input,
        idempotencyKey: "harness-cancel-once",
        args: { ...input.args, path: "cancelled.txt" }
      });
      expect(await executeNativeTool(cli, "adc_cancel", { jobId: cancelled.jobId })).toMatchObject({
        status: "cancelled"
      });
      expect(
        await executeNativeTool(sdk, "adc_task", { jobId: cancelled.jobId, waitMs: 0 })
      ).toMatchObject({ status: "cancelled" });

      const previous = (await store.getGrant("grant_harness"))!;
      const updated = await app.inject({
        method: "PATCH",
        url: "/api/v1/grants/grant_harness",
        headers: { cookie, origin: address },
        payload: {
          name: previous.name ?? "Harness",
          profile: previous.profile,
          nodeIds: previous.nodeIds,
          rootAccess: previous.rootAccess ?? "selected",
          rootIds: previous.rootIds,
          allowedTools: previous.allowedTools,
          revision: previous.revision ?? 1,
          approvalPolicy: "writes"
        }
      });
      expect(updated.statusCode, updated.body).toBe(200);
      const approval: any = await executeNativeTool(cli, "adc_invoke", {
        ...input,
        idempotencyKey: "harness-review-once",
        args: { ...input.args, path: "review.txt" }
      });
      expect(approval).toMatchObject({
        status: "approval_required",
        reviewUrl: `${address}/approvals`
      });
      expect(
        await executeNativeTool(sdk, "adc_task", { invocationId: approval.invocationId, waitMs: 0 })
      ).toMatchObject({
        status: "approval_required",
        invocationId: approval.invocationId
      });
      await expect(readFile(resolve(directory, "review.txt"))).rejects.toThrow();
      expect(
        (await owner.audit()).filter((event: any) => event.type === "dispatch.queued")
      ).toHaveLength(3);
    } finally {
      sdk.dispose();
      runner.dispose();
      cli.dispose();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
