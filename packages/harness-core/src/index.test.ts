import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { projectToolDefinitions } from "@adc/mcp-adapter";
import type { InvocationContext } from "@adc/client";
import {
  createCliRunner,
  createCliTransport,
  executeNativeTool,
  projectResult,
  validateInvocation,
  type Discovery
} from "./index.ts";

const context: InvocationContext = {
  accountId: "acct_example",
  actorId: "actor_example",
  grantId: "grant_example",
  nodeIds: ["node_example"],
  rootIds: ["root_example"],
  allowedTools: ["file.read", "file.write", "task.status"],
  rootsByNode: { node_example: ["root_example"] },
  toolNodeIds: { "file.read": ["node_example"], "file.write": ["node_example"] }
};
const discovery: Discovery = {
  devices: [{ nodeId: "node_example", label: "Computer", platform: "linux", online: true }],
  tools: projectToolDefinitions({ context })
};
const read = { tool: "file.read", args: { path: "/workspace/test.txt" } };
const write = {
  tool: "file.write",
  args: { path: "/workspace/test.txt", content: "hello" },
  idempotencyKey: "write-once-example"
};

describe("harness execution boundaries", () => {
  it("validates live schemas, explicit target/platform and host read-only boundaries", () => {
    expect(validateInvocation(discovery, read, true).nodeId).toBe("node_example");
    expect(() => validateInvocation(discovery, write, true)).toThrow("side effect");
    expect(() => validateInvocation(discovery, { ...write, idempotencyKey: "" }, false)).toThrow(
      "idempotencyKey"
    );
    expect(() => validateInvocation(discovery, { ...read, args: {} }, true)).toThrow();
    expect(() => validateInvocation(discovery, { ...read, nodeId: "node_other" }, true)).toThrow(
      "outside"
    );
    expect(() =>
      validateInvocation(
        { ...discovery, devices: [{ ...discovery.devices[0]!, online: false }] },
        read,
        true
      )
    ).toThrow("offline");
    expect(() =>
      validateInvocation(
        {
          ...discovery,
          devices: [...discovery.devices, { ...discovery.devices[0]!, nodeId: "node_second" }]
        },
        read,
        true
      )
    ).toThrow("explicitly");
    expect(() => validateInvocation(discovery, { ...read, tool: "not.available" }, true)).toThrow(
      "unavailable"
    );
  });

  it("preserves side-effect keys, rejected status and existing task identities without resubmitting", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === "node") return { nodes: discovery.devices };
      if (args[0] === "tool") return { tools: discovery.tools };
      return {
        schemaVersion: "0.1",
        invocationId: "inv_example",
        attemptId: "att_example",
        status: args[0] === "invoke" ? "approval_required" : "succeeded",
        ...(args[0] === "invoke"
          ? {
              error: { code: "approval_required", message: "Review required", retryable: false }
            }
          : { output: { complete: true } })
      };
    });
    const transport = createCliTransport(run);
    const result = await executeNativeTool(transport, "adc_invoke", write);
    expect(result).toMatchObject({
      status: "approval_required",
      reviewUrl: "https://adc.zioon.tech/approvals"
    });
    const invokeArgs = run.mock.calls.find(([args]) => args[0] === "invoke")![0];
    expect(invokeArgs).toContain("write-once-example");
    expect(invokeArgs).toContain("node_example");
    await executeNativeTool(transport, "adc_task", { invocationId: "inv_example" });
    expect(run.mock.calls.filter(([args]) => args[0] === "invoke")).toHaveLength(1);
    expect(run.mock.calls.at(-1)![0]).toEqual(["invocation", "status", "inv_example"]);
    await expect(
      executeNativeTool(transport, "adc_read", { ...read, accountId: "fake" })
    ).rejects.toThrow();
    expect(run.mock.calls.filter(([args]) => args[0] === "invoke")).toHaveLength(1);
  });

  it("keeps terminal receipts and uncertainty when bounding large output", () => {
    const projected = projectResult({
      schemaVersion: "0.1",
      invocationId: "inv_example",
      attemptId: "att_example",
      status: "unknown_outcome",
      output: "a".repeat(100_000)
    });
    expect(projected.invocationId).toBe("inv_example");
    expect(projected.output).toMatchObject({ truncated: true });
    expect(projected).toMatchObject({ nextAction: expect.stringContaining("do not submit") });
  });

  it("uses argument arrays without a shell and cancels a pending process on disposal", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "adc-cli-plugin-"));
    const file = resolve(directory, "adc");
    try {
      await writeFile(
        file,
        `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2)}));\n`
      );
      await chmod(file, 0o700);
      const runner = createCliRunner(file);
      const payload = "$(touch never-created); `touch also-never-created`";
      const value = await runner.run(["test", payload]);
      expect(value.args).toEqual(["test", payload, "--json"]);
      runner.dispose();
      await writeFile(file, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`);
      const waiting = createCliRunner(file);
      const pending = waiting.run(["status"]);
      waiting.dispose();
      await expect(pending).rejects.toThrow("cancelled");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
