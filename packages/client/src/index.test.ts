import { describe, expect, it } from "vitest";
import { AdcClient, buildInvocation, defaultTarget, type InvocationContext } from "./index.ts";

const context: InvocationContext = {
  accountId: "acct_example",
  actorId: "actor_example",
  grantId: "grant_example",
  nodeIds: ["node_example"],
  resourcesByNode: {
    node_example: [{ rootId: "root_workspace", path: "/Users/example/workspace" }]
  },
  rootIds: ["root_workspace"]
};

describe("device invocation context", () => {
  it("validates execution budgets and derives submission expiry", () => {
    const invocation = buildInvocation({
      context,
      tool: "file.read",
      args: { rootId: "root_workspace", path: "a.txt" },
      source: "sdk",
      executionTimeoutMs: 10_000
    });
    expect(Date.parse(invocation.expiresAt) - Date.parse(invocation.issuedAt)).toBe(10_000);
    expect(invocation.executionTimeoutMs).toBe(10_000);
    expect(() =>
      buildInvocation({
        context,
        tool: "file.read",
        args: { rootId: "root_workspace", path: "a.txt" },
        source: "sdk",
        executionTimeoutMs: 99
      })
    ).toThrow();
  });

  it("sends bounded server waits and cancellation signals without changing the invocation", async () => {
    const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const invocation = buildInvocation({
      context,
      tool: "file.read",
      args: { rootId: "root_workspace", path: "a.txt" },
      source: "sdk"
    });
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: new URL(input.toString()), init });
      return Response.json({
        schemaVersion: "0.1",
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        status: "queued",
        jobId: "job_example"
      });
    }) as typeof fetch;
    const client = new AdcClient("https://adc.example", "test", fetcher);
    const signal = new AbortController().signal;
    await client.invoke(invocation);
    await client.invoke(invocation, { waitMs: 4000, signal });
    await client.taskWait("job_example", 30000, signal);
    await client.invocationStatus(invocation.invocationId, { waitMs: 1000, signal });
    expect(calls.map(({ url }) => url.searchParams.get("waitMs"))).toEqual([
      "0",
      "4000",
      "30000",
      "1000"
    ]);
    expect(calls[1]!.init?.signal).toBe(signal);
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual(invocation);
    expect(calls[2]!.init?.signal).toBe(signal);
    await expect(client.invoke(invocation, { waitMs: -1 })).rejects.toThrow();
    expect(calls).toHaveLength(4);
  });

  it("uses a single device without a project", () => {
    expect(
      buildInvocation({
        context,
        tool: "file.read",
        args: { rootId: "root_workspace", path: "hello.txt" },
        source: "sdk"
      })
    ).toMatchObject({ target: { nodeId: "node_example" } });
  });

  it("requires explicit placement for multiple devices but allows discovery", () => {
    const multiple = { ...context, nodeIds: ["node_first", "node_second"] };
    expect(() => defaultTarget(multiple, "file.read")).toThrow("Multiple devices");
    expect(defaultTarget(multiple, "device.list")).toEqual({ nodeId: "node_first" });
    expect(() => defaultTarget({ ...context, nodeIds: [] })).toThrow("No device");
  });

  it("retains project placement for existing grants", () => {
    expect(defaultTarget({ ...context, projectId: "proj_example" })).toEqual({
      projectId: "proj_example"
    });
  });

  it("maps an absolute path to its device root without exposing the root ID in args", () => {
    const built = buildInvocation({
      context: { ...context, projectId: "proj_example" },
      tool: "file.read",
      args: { path: "/Users/example/workspace/hello.txt" },
      source: "sdk"
    });
    expect(built).toMatchObject({
      target: { nodeId: "node_example" },
      args: { path: "/Users/example/workspace/hello.txt" },
      authorization: { rootIds: ["root_workspace"] }
    });
    expect(built.args).not.toHaveProperty("rootId");
  });

  it("requires a node and an authorized mapping for absolute paths", () => {
    expect(() =>
      buildInvocation({
        context: { ...context, nodeIds: ["node_example", "node_other"] },
        tool: "file.read",
        args: { path: "/Users/example/workspace/hello.txt" },
        source: "sdk"
      })
    ).toThrow("target.nodeId");
    expect(() =>
      buildInvocation({
        context,
        tool: "file.read",
        args: { path: "/private/secret.txt" },
        source: "sdk"
      })
    ).toThrow("outside");
  });

  it("includes new roots only for an explicitly all-roots context", () => {
    const input = {
      tool: "file.read",
      args: { rootId: "root_added", path: "hello.txt" },
      source: "sdk" as const
    };
    expect(buildInvocation({ ...input, context }).authorization.rootIds).toEqual([
      "root_workspace"
    ]);
    expect(
      buildInvocation({ ...input, context: { ...context, rootAccess: "all" } }).authorization
        .rootIds
    ).toEqual(["root_added"]);
  });

  it("limits discovery authorization to the selected device in large device networks", () => {
    const roots = Array.from({ length: 64 }, (_, index) => `root_folder${index}`);
    expect(
      buildInvocation({
        context: {
          ...context,
          rootAccess: "all",
          rootIds: [...roots, "root_other"],
          rootsByNode: { node_example: roots }
        },
        tool: "command.template.list",
        args: {},
        source: "sdk"
      }).authorization.rootIds
    ).toHaveLength(64);
  });

  it("requires idempotency for device writes", () => {
    expect(() =>
      buildInvocation({
        context,
        tool: "file.write",
        args: { rootId: "root_workspace", path: "hello.txt", content: "once" },
        source: "cli"
      })
    ).toThrow("idempotencyKey");
  });

  it("binds native transfers to the source node and both authorized roots", () => {
    const built = buildInvocation({
      context: {
        ...context,
        nodeIds: ["node_source", "node_destination"],
        rootIds: ["root_source", "root_destination"]
      },
      tool: "file.transfer",
      args: {
        source: {
          nodeId: "node_source",
          rootId: "root_source",
          path: "models/model.bin"
        },
        destination: {
          nodeId: "node_destination",
          rootId: "root_destination",
          path: "cache/model.bin"
        }
      },
      idempotencyKey: "native-transfer-example",
      source: "sdk"
    });

    expect(built).toMatchObject({
      target: { nodeId: "node_source" },
      authorization: { rootIds: ["root_source", "root_destination"] },
      args: { overwrite: "never", chunkSizeBytes: 8 * 1024 * 1024 }
    });

    expect(() =>
      buildInvocation({
        context,
        tool: "file.transfer",
        args: {
          source: {
            nodeId: "node_macbook",
            rootId: "root_workspace",
            path: "source.bin"
          },
          destination: {
            nodeId: "node_macbook",
            rootId: "root_workspace",
            path: "destination.bin"
          }
        },
        idempotencyKey: "same-node-transfer",
        source: "sdk"
      })
    ).toThrow(/source and destination nodes/);
  });

  it("exposes bounded audit and approval page contracts", async () => {
    const requests: URL[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      requests.push(url);
      if (url.pathname.endsWith("/approvals")) {
        return Response.json({
          approvals: [],
          nextCursor: "approval-next",
          hasMore: true,
          pendingCount: 4
        });
      }
      return Response.json({
        events: [{ id: "newest" }, { id: "oldest" }],
        nextCursor: "audit-next",
        hasMore: true
      });
    }) as typeof fetch;
    const client = new AdcClient("https://adc.example", { cookie: "session=example" }, fetcher);

    await expect(
      client.auditPage({
        invocationId: "inv_example",
        limit: 25,
        cursor: "audit-cursor",
        category: "dispatch"
      })
    ).resolves.toMatchObject({ nextCursor: "audit-next", hasMore: true });
    expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({
      invocationId: "inv_example",
      limit: "25",
      cursor: "audit-cursor",
      category: "dispatch"
    });
    await expect(client.audit()).resolves.toEqual([{ id: "oldest" }, { id: "newest" }]);
    expect(requests[1]!.searchParams.get("limit")).toBe("100");
    await expect(
      client.listApprovalsPage({ limit: 20, cursor: "approval-cursor", status: "resolved" })
    ).resolves.toMatchObject({ pendingCount: 4, nextCursor: "approval-next" });
    expect(Object.fromEntries(requests[2]!.searchParams)).toEqual({
      limit: "20",
      cursor: "approval-cursor",
      status: "resolved"
    });
  });
});
