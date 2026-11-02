import { describe, expect, it, vi } from "vitest";
import { projectToolDefinitions } from "../packages/mcp-adapter/src/index.ts";
import { createClinePlugin } from "../plugins/cline/index.ts";
import type { HarnessTransport } from "../packages/harness-core/src/index.ts";

function session(plugin: ReturnType<typeof createClinePlugin>) {
  const tools = new Map<string, any>(),
    rules: any[] = [],
    dispose: any[] = [];
  let command: any;
  plugin.setup(
    {
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerRule: (rule: any) => rules.push(rule),
      registerCommand: (value: any) => {
        command = value;
      }
    },
    { onDispose: (value: any) => dispose.push(value) }
  );
  return { tools, rules, command, dispose };
}

function transport() {
  return {
    origin: "https://devices.example.com",
    status: vi.fn(async () => ({ connected: true })),
    discover: vi.fn(async () => ({
      devices: [{ nodeId: "node_example", label: "Computer", platform: "linux", online: true }],
      tools: projectToolDefinitions({
        context: {
          accountId: "acct_example",
          actorId: "actor_example",
          grantId: "grant_example",
          nodeIds: ["node_example"],
          rootIds: ["root_example"],
          allowedTools: ["file.write"],
          toolNodeIds: { "file.write": ["node_example"] }
        }
      })
    })),
    invoke: vi.fn(async () => ({
      schemaVersion: "0.1" as const,
      invocationId: "inv_example",
      attemptId: "att_example",
      status: "queued" as const
    })),
    task: vi.fn(),
    dispose: vi.fn()
  } satisfies HarnessTransport;
}

describe("Cline first-use and session boundaries", () => {
  it("supplies self-contained onboarding and the current service's approval link", async () => {
    const current = transport();
    const guide = "Install ADC with curl, then adc login and adc connect ACCESS.";
    const s = session(
      createClinePlugin((tool: any) => tool, {
        setupGuidance: guide,
        transportFactory: () => current
      })
    );
    const setup = await s.command.handler("setup");
    expect(setup.submitPrompt).toContain(guide);
    expect(setup.submitPrompt).toContain("user completes login and approval");
    expect(setup.submitPrompt).not.toContain("with the agent-device-cloud Skill");
    expect(s.rules[0].content).not.toContain(guide);
    expect(await s.command.handler("approval")).toEqual({
      reply: "https://devices.example.com/approvals"
    });
    expect(current.status).toHaveBeenCalledTimes(1);
    for (const dispose of s.dispose) dispose();
    expect(current.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps execution opt-in per session even when the host shares the module", async () => {
    const instances: ReturnType<typeof transport>[] = [];
    const plugin = createClinePlugin((tool: any) => tool, {
      transportFactory: () => {
        const value = transport();
        instances.push(value);
        return value;
      }
    });
    const a = session(plugin),
      b = session(plugin);
    const input = {
      tool: "file.write",
      args: { path: "/workspace/file.txt", content: "test" },
      idempotencyKey: "cline-write-once"
    };
    const call = (s: typeof a) =>
      s.tools.get("adc_invoke").execute(input, { signal: new AbortController().signal });
    await expect(call(a)).rejects.toThrow("Enable ADC execution");
    await a.command.handler("mode execute");
    expect(await call(a)).toMatchObject({ status: "queued" });
    await expect(call(b)).rejects.toThrow("Enable ADC execution");
    await a.command.handler("mode read");
    await expect(call(a)).rejects.toThrow("Enable ADC execution");
    expect(instances[0]!.invoke).toHaveBeenCalledTimes(1);
    expect(instances[1]!.invoke).not.toHaveBeenCalled();
    for (const s of [a, b]) for (const dispose of s.dispose) dispose();
  });
});
