import { describe, expect, it, vi } from "vitest";
import { activateRuntimePlugin } from "../plugins/zion/runtime.ts";
import { principalKey } from "../packages/harness-core/src/oauth.ts";

async function fixture() {
  const state = new Map<string, any>(),
    tools = new Map<string, any>();
  let handler: any;
  const fetcher = vi.fn(async (url: any, init?: any) => {
    if (String(url).endsWith("/register")) return Response.json({ client_id: "client_zion" });
    if (String(url).endsWith("/token"))
      return Response.json({
        access_token: "scoped-user-a",
        token_type: "Bearer",
        expires_in: 3600
      });
    const user = init?.headers?.authorization === "Bearer scoped-user-b" ? "b" : "a";
    if (String(url).endsWith("/api/v1/me"))
      return Response.json({
        kind: "agent",
        context: {
          accountId: `acct_${user}_example`,
          actorId: `actor_${user}_example`,
          grantId: `grant_${user}_example`,
          nodeIds: [`node_${user}_example`],
          rootIds: [`root_${user}_example`],
          allowedTools: ["device.list", "file.read", "file.write"],
          toolNodeIds: {
            "file.read": [`node_${user}_example`],
            "file.write": [`node_${user}_example`]
          },
          resourcesByNode: {
            [`node_${user}_example`]: [{ rootId: `root_${user}_example`, path: "/workspace" }]
          }
        },
        grant: { name: `User ${user}`, allowedTools: ["device.list", "file.read", "file.write"] }
      });
    if (String(url).includes("/api/v1/invocations")) {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      return Response.json({
        schemaVersion: "0.1",
        invocationId: body?.invocationId ?? "inv_existing",
        attemptId: body?.attemptId ?? "att_existing",
        status: body?.tool === "file.write" ? "queued" : "succeeded",
        ...(body?.tool === "file.write"
          ? { jobId: "job_existing" }
          : {
              output:
                body?.tool === "device.list"
                  ? {
                      nodes: [
                        {
                          nodeId: `node_${user}_example`,
                          label: `Device ${user}`,
                          platform: "linux",
                          online: true
                        }
                      ]
                    }
                  : { text: `User ${user} result` }
            })
      });
    }
    return Response.json({});
  });
  const disposable = () => ({ dispose: vi.fn() });
  const plugin = await activateRuntimePlugin(
    {
      config: {},
      state: {
        namespace: (name: string) => ({
          read: async (key: string) => structuredClone(state.get(`${name}.${key}`)),
          put: async (key: string, value: any) => {
            state.set(`${name}.${key}`, structuredClone(value));
          }
        })
      },
      runs: {
        registerCommands(fn: any) {
          handler = fn;
          return disposable();
        }
      },
      tools: {
        registerTool(tool: any) {
          tools.set(tool.name, tool);
          return disposable();
        }
      }
    },
    { fetcher }
  );
  const principal = (user: string) => ({
    kind: "account",
    user: { id: user },
    space: { id: "space" }
  });
  const key = (user: string) => `private.user-${principalKey(principal(user))}.connection`;
  const connect = (user: string) =>
    state.set(key(user), {
      connection: {
        accessToken: `scoped-user-${user}`,
        expiresAt: Date.now() + 3_600_000,
        clientId: `client-${user}`
      }
    });
  return { state, tools, handler, fetcher, principal, connect, plugin, key };
}

describe("Zion ADC Runtime adapter", () => {
  it("isolates sidebar and model credentials by authenticated user, never argument identity", async () => {
    const f = await fixture();
    f.connect("a");
    f.connect("b");
    try {
      const a = await f.handler(
        { action: "status", accountId: "b" },
        { principal: f.principal("a") }
      );
      const b = await f.handler({ action: "status" }, { principal: f.principal("b") });
      expect(a.devices[0].nodeId).toBe("node_a_example");
      expect(b.devices[0].nodeId).toBe("node_b_example");
      expect(JSON.stringify([a, b])).not.toContain("scoped-user-");
      await expect(
        f.handler(
          { action: "select", nodeId: "node_b_example" },
          {
            principal: f.principal("a")
          }
        )
      ).rejects.toThrow("current ADC connection");
      await expect(
        f.handler(
          { action: "status", userId: "a" },
          {
            principal: undefined
          }
        )
      ).rejects.toThrow("Sign in");
      const call = await f.tools.get("adc_read").invoke(
        {
          tool: "file.read",
          args: { path: "/workspace/a.txt" },
          nodeId: "node_a_example"
        },
        {
          principal: {
            version: 1,
            kind: "user",
            userId: "a",
            spaceId: "space",
            grantId: "run_grant"
          }
        }
      );
      expect(call.content).toContain("User a result");
      expect(call.content).not.toContain("scoped-user-");
    } finally {
      f.plugin.dispose();
    }
  });

  it("binds OAuth state to its initiating principal and consumes duplicate callbacks once", async () => {
    const f = await fixture();
    try {
      const begin = await f.handler(
        { action: "connect", redirectUri: "https://zion.example/" },
        {
          principal: f.principal("a"),
          origin: "https://zion.example"
        }
      );
      const state = new URL(begin.authorizeUrl).searchParams.get("state");
      await expect(
        f.handler(
          { action: "finish", code: "code", state },
          {
            principal: f.principal("b")
          }
        )
      ).rejects.toThrow("different Zion user");
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          f.handler(
            {
              action: "finish",
              code: "code",
              state
            },
            { principal: f.principal("a") }
          )
        )
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(
        1
      );
    } finally {
      f.plugin.dispose();
    }
  });

  it("tracks an existing task through sidebar refresh and retains host effect metadata", async () => {
    const f = await fixture();
    f.connect("a");
    try {
      const invocation = await f.tools.get("adc_invoke").invoke(
        {
          tool: "file.write",
          args: { path: "/workspace/file.txt", content: "test" },
          idempotencyKey: "stable-operation-key"
        },
        { principal: f.principal("a") }
      );
      expect(JSON.parse(invocation.content).status).toBe("queued");
      const refreshed = await f.handler({ action: "status" }, { principal: f.principal("a") });
      expect(refreshed.tasks[0].status).toBe("succeeded");
      expect(
        f.fetcher.mock.calls.filter(([, init]) => {
          try {
            return JSON.parse(init?.body ?? "{}").tool === "file.write";
          } catch {
            return false;
          }
        })
      ).toHaveLength(1);
      expect(f.tools.get("adc_invoke").policy.minimumPreset).toBe("trusted-automation");
      expect(f.tools.get("adc_read").execution.effect).toBe("read");
      expect(f.state.get(f.key("b"))).toBeUndefined();
    } finally {
      f.plugin.dispose();
    }
  });

  it("stops pending HTTP work when the Runtime plugin is disposed", async () => {
    const f = await fixture();
    f.connect("a");
    f.fetcher.mockImplementationOnce(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true
          });
        })
    );
    const pending = f.tools.get("adc_status").invoke({}, { principal: f.principal("a") });
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled(), { timeout: 1000 });
    f.plugin.dispose();
    await expect(pending).rejects.toThrow("cancelled");
  });
});
