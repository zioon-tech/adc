import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AdcClient, buildInvocation } from "@adc/client";
import { NodeApiClient, generateNodeKeyPair } from "@adc/client/node";
import { MemoryStore } from "@adc/db";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { accessFixture } from "../../../tests/helpers/access-fixture.ts";
import { createControlPlane } from "./app.ts";
import { LocalTransferBlobStore } from "./transfer-store.ts";

const directories: string[] = [];
const apps: Awaited<ReturnType<typeof createControlPlane>>[] = [];
const cookie = "adc.session_token=native-transfer-test";

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function fetchFor(app: Awaited<ReturnType<typeof createControlPlane>>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const body = init?.body;
    const payload =
      typeof body === "string"
        ? body
        : body instanceof Uint8Array
          ? Buffer.from(body)
          : body instanceof ArrayBuffer
            ? Buffer.from(body)
            : undefined;
    const injection: InjectOptions = {
      method: (init?.method ?? "GET") as any,
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(payload === undefined ? {} : { payload })
    };
    const response = await app.inject(injection);
    return new Response(Uint8Array.from(response.rawPayload).buffer, {
      status: response.statusCode,
      headers: Object.fromEntries(
        Object.entries(response.headers).flatMap(([key, value]) =>
          value === undefined
            ? []
            : [[key, Array.isArray(value) ? value.join(", ") : String(value)]]
        )
      )
    });
  }) as typeof fetch;
}

async function directory(prefix: string): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), prefix));
  directories.push(created);
  return created;
}

describe("native node transfer", () => {
  it("streams a verified file between two nodes without external object storage", async () => {
    const sourceRoot = await directory("adc-transfer-source-");
    const destinationRoot = await directory("adc-transfer-destination-");
    const sourceState = await directory("adc-transfer-source-state-");
    const destinationState = await directory("adc-transfer-destination-state-");
    const relay = await directory("adc-transfer-relay-");
    const payload = Buffer.concat([
      Buffer.from("native transfer\0"),
      Buffer.from(Array.from({ length: 32_000 }, (_, index) => index % 251))
    ]);
    await writeFile(join(sourceRoot, "model.bin"), payload);

    const store = new MemoryStore();
    const app = await createControlPlane({
      store,
      access: accessFixture({
        cookie,
        agents: {
          "transfer-agent-token": {
            accountId: "acct_primary",
            grantId: "grant_transfer"
          }
        }
      }),
      transferStore: new LocalTransferBlobStore(relay)
    });
    apps.push(app);
    const fetcher = fetchFor(app);
    const owner = new AdcClient("http://adc.test", { cookie }, fetcher);

    const pairNode = async (label: string) => {
      const pairing = await owner.createPairingCode();
      const keys = generateNodeKeyPair();
      const paired = await new NodeApiClient(
        "http://adc.test",
        undefined,
        keys.privateKey,
        fetcher
      ).pair({
        code: pairing.code,
        label,
        platform: "linux",
        publicKey: keys.publicKey
      });
      return { ...paired, privateKey: keys.privateKey };
    };
    const source = await pairNode("transfer-source");
    const destination = await pairNode("transfer-destination");
    const sourceDaemon = new NodeDaemon({
      controlPlaneUrl: "http://adc.test",
      nodeId: source.nodeId,
      privateKey: source.privateKey,
      roots: [
        {
          rootId: "root_source",
          path: sourceRoot,
          writable: false,
          label: "Source"
        }
      ],
      stateDirectory: sourceState,
      fetcher
    });
    const destinationDaemon = new NodeDaemon({
      controlPlaneUrl: "http://adc.test",
      nodeId: destination.nodeId,
      privateKey: destination.privateKey,
      roots: [
        {
          rootId: "root_destination",
          path: destinationRoot,
          writable: true,
          label: "Destination"
        }
      ],
      stateDirectory: destinationState,
      fetcher
    });
    expect(await sourceDaemon.runOnce()).toBe(false);
    expect(await destinationDaemon.runOnce()).toBe(false);

    await owner.createAccess({
      grantId: "grant_transfer",
      actorId: "actor_transfer",
      name: "Native transfer",
      profile: "approve-required",
      nodeIds: [source.nodeId, destination.nodeId],
      rootAccess: "selected",
      rootIds: ["root_source", "root_destination"],
      approvalPolicy: "writes",
      allowedTools: ["file.transfer", "task.wait", "task.cancel"]
    });
    const agent = new AdcClient("http://adc.test", "transfer-agent-token", fetcher);
    const invocation = buildInvocation({
      context: {
        accountId: "acct_primary",
        actorId: "actor_transfer",
        grantId: "grant_transfer",
        nodeIds: [source.nodeId, destination.nodeId],
        rootIds: ["root_source", "root_destination"]
      },
      tool: "file.transfer",
      args: {
        source: {
          nodeId: source.nodeId,
          rootId: "root_source",
          path: "model.bin"
        },
        destination: {
          nodeId: destination.nodeId,
          rootId: "root_destination",
          path: "cache.bin"
        },
        chunkSizeBytes: 1024 * 1024
      },
      idempotencyKey: "native-transfer-e2e",
      source: "sdk",
      executionTimeoutMs: 30_000
    });
    const pending = await agent.invoke(invocation);
    expect(pending).toMatchObject({
      status: "approval_required",
      error: {
        details: {
          approvalId: expect.stringMatching(/^apr_/),
          transferId: expect.stringMatching(/^xfr_/)
        }
      }
    });
    await expect(owner.listApprovals()).resolves.toContainEqual(
      expect.objectContaining({
        approvalId: pending.error?.details?.approvalId,
        path: `${join(sourceRoot, "model.bin")} -> ${join(destinationRoot, "cache.bin")}`
      })
    );
    expect(await sourceDaemon.runOnce()).toBe(false);
    expect(await destinationDaemon.runOnce()).toBe(false);
    const submitted = (await owner.resolveApproval(
      String(pending.error?.details?.approvalId),
      "approved"
    )) as any;
    expect(submitted).toMatchObject({
      status: "queued",
      jobId: expect.stringMatching(/^job_xfr_/)
    });

    await Promise.all([sourceDaemon.runOnce(), destinationDaemon.runOnce()]);

    await expect(agent.taskWait(submitted.jobId!, 4000)).resolves.toMatchObject({
      status: "succeeded",
      output: {
        status: "succeeded",
        byteSize: payload.byteLength,
        bytesTransferred: payload.byteLength
      }
    });
    await expect(readFile(join(destinationRoot, "cache.bin"))).resolves.toEqual(payload);
    await expect(
      readFile(join(relay, String((submitted.output as any).transferId), "000000000.chunk"))
    ).rejects.toMatchObject({ code: "ENOENT" });

    const cancelledInvocation = buildInvocation({
      context: {
        accountId: "acct_primary",
        actorId: "actor_transfer",
        grantId: "grant_transfer",
        nodeIds: [source.nodeId, destination.nodeId],
        rootIds: ["root_source", "root_destination"]
      },
      tool: "file.transfer",
      args: {
        source: {
          nodeId: source.nodeId,
          rootId: "root_source",
          path: "model.bin"
        },
        destination: {
          nodeId: destination.nodeId,
          rootId: "root_destination",
          path: "cancelled.bin"
        },
        chunkSizeBytes: 1024 * 1024
      },
      idempotencyKey: "native-transfer-cancelled",
      source: "sdk",
      executionTimeoutMs: 30_000
    });
    const awaitingApproval = await agent.invoke(cancelledInvocation);
    const cancelledTransferId = String(awaitingApproval.error?.details?.transferId);
    await expect(agent.cancelTask(`job_${cancelledTransferId}`)).resolves.toMatchObject({
      status: "cancelled",
      error: { code: "cancelled" }
    });
    await expect(agent.taskStatus(`job_${cancelledTransferId}`)).resolves.toMatchObject({
      status: "cancelled"
    });
    await expect(
      store.getApproval(String(awaitingApproval.error?.details?.approvalId))
    ).resolves.toMatchObject({ status: "denied" });
    await expect(
      owner.resolveApproval(String(awaitingApproval.error?.details?.approvalId), "approved")
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(readFile(join(destinationRoot, "cancelled.bin"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});
