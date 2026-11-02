import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdcClient, buildInvocation } from "@adc/client";
import { NodeApiClient, generateNodeKeyPair } from "@adc/client/node";
import { MemoryStore } from "@adc/db";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { accessFixture } from "../../../tests/helpers/access-fixture.ts";
import { createControlPlane } from "./app.ts";
import type { DirectTransferStore, TransferTicket } from "./object-transfer-store.ts";

const digest = (data: Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

describe("object transfer API", () => {
  it("uploads from an Agent with one approved destination, isolated bytes and verified receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adc-direct-api-"));
    const objects = new Map<string, { data: Buffer; sha256: string; bytes: number }>();
    const tickets = new Map<string, { key: string; bytes: number; sha256: string; md5?: string }>();
    let objectRequests = 0;
    const ticket = (key: string, bytes: number, sha256: string, md5?: string): TransferTicket => {
      const url = `https://objects.test/${tickets.size}`;
      tickets.set(url, { key, bytes, sha256, ...(md5 ? { md5 } : {}) });
      return { url, headers: {}, expiresAt: new Date(Date.now() + 300_000).toISOString() };
    };
    const direct: DirectTransferStore = {
      async uploadTicket(id, index, bytes, sha256, md5) {
        return ticket(`${id}/${index}`, bytes, sha256, md5);
      },
      async downloadTicket(id, index) {
        const object = objects.get(`${id}/${index}`);
        if (!object) throw Object.assign(new Error("not found"), { status: 404 });
        return {
          ...ticket(`${id}/${index}`, object.bytes, object.sha256),
          sha256: object.sha256,
          bytes: object.bytes
        };
      },
      async deleteTransfer(id) {
        for (const key of objects.keys()) if (key.startsWith(`${id}/`)) objects.delete(key);
      }
    };
    const store = new MemoryStore();
    const cookie = "adc.session_token=direct-api-test";
    const app = await createControlPlane({
      store,
      directTransferStore: direct,
      access: accessFixture({
        cookie,
        agents: {
          agent: { accountId: "acct_primary", grantId: "grant_upload" },
          other: { accountId: "acct_primary", grantId: "grant_other" }
        }
      })
    });
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.hostname === "objects.test") {
        objectRequests++;
        const headers = new Headers(init?.headers);
        expect(headers.has("authorization")).toBe(false);
        expect(headers.has("cookie")).toBe(false);
        expect([...headers.keys()].some((name) => name.startsWith("x-adc-"))).toBe(false);
        const authorization = tickets.get(url.href)!;
        if (init?.method === "PUT") {
          const data = Buffer.from(init.body as Uint8Array);
          expect(data.length).toBe(authorization.bytes);
          expect(digest(data)).toBe(authorization.sha256);
          expect(createHash("md5").update(data).digest("base64")).toBe(authorization.md5);
          if (objects.has(authorization.key)) return new Response(null, { status: 409 });
          objects.set(authorization.key, {
            data,
            sha256: authorization.sha256,
            bytes: data.length
          });
          return new Response(null);
        }
        const object = objects.get(authorization.key)!;
        return new Response(Uint8Array.from(object.data));
      }
      expect(init?.body instanceof Uint8Array).toBe(false);
      const response = await app.inject({
        method: (init?.method ?? "GET") as any,
        url: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(new Headers(init?.headers)),
        ...(typeof init?.body === "string" ? { payload: init.body } : {})
      });
      return new Response(Uint8Array.from(response.rawPayload), {
        status: response.statusCode,
        headers: Object.fromEntries(
          Object.entries(response.headers).map(([key, value]) => [key, String(value)])
        )
      });
    }) as typeof fetch;
    try {
      const owner = new AdcClient("http://adc.test", { cookie }, fetcher);
      const agent = new AdcClient("http://adc.test", "agent", fetcher);
      const pairing = await owner.createPairingCode();
      const keys = generateNodeKeyPair();
      const node = await new NodeApiClient(
        "http://adc.test",
        undefined,
        keys.privateKey,
        fetcher
      ).pair({
        code: pairing.code,
        label: "Destination",
        platform: "linux",
        publicKey: keys.publicKey
      });
      const daemon = new NodeDaemon({
        controlPlaneUrl: "http://adc.test",
        nodeId: node.nodeId,
        privateKey: keys.privateKey,
        roots: [{ rootId: "root_upload", path: directory, writable: true, label: "Upload" }],
        stateDirectory: join(directory, "state"),
        fetcher
      });
      await daemon.runOnce();
      await owner.createAccess({
        grantId: "grant_upload",
        actorId: "actor_upload",
        name: "Upload",
        profile: "approve-required",
        nodeIds: [node.nodeId],
        rootAccess: "selected",
        rootIds: ["root_upload"],
        approvalPolicy: "writes",
        allowedTools: ["file.transfer", "task.wait", "task.cancel"]
      });
      const payload = Buffer.alloc(1024 * 1024 + 23, 37);
      const invocation = buildInvocation({
        context: {
          accountId: "acct_primary",
          actorId: "actor_upload",
          grantId: "grant_upload",
          nodeIds: [node.nodeId],
          rootIds: ["root_upload"]
        },
        tool: "file.transfer",
        args: {
          source: {
            kind: "agent",
            path: "model.bin",
            byteSize: payload.length,
            contentSha256: digest(payload)
          },
          destination: { nodeId: node.nodeId, rootId: "root_upload", path: "model.bin" },
          chunkSizeBytes: 1024 * 1024
        },
        idempotencyKey: "agent-upload-api",
        source: "sdk",
        executionTimeoutMs: 30_000
      });
      const [pending, concurrent] = await Promise.all([
        agent.invoke(invocation),
        agent.invoke({
          ...invocation,
          invocationId: "inv_upload_concurrent",
          attemptId: "att_upload_concurrent"
        })
      ]);
      expect(pending.status).toBe("approval_required");
      expect(concurrent).toMatchObject({
        status: "approval_required",
        error: { details: { approvalId: pending.error?.details?.approvalId } }
      });
      const replay = {
        ...invocation,
        invocationId: "inv_upload_replay",
        attemptId: "att_upload_replay"
      };
      expect(await agent.invoke(replay)).toMatchObject({
        status: "approval_required",
        error: { details: { approvalId: pending.error?.details?.approvalId } }
      });
      expect(await owner.listApprovals()).toHaveLength(1);
      const transferId = String(pending.error?.details?.transferId);
      await expect(
        agent.uploadTransferChunk(transferId, 0, payload.subarray(0, 1024 * 1024))
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(objectRequests).toBe(0);
      const submitted = (await owner.resolveApproval(
        String(pending.error?.details?.approvalId),
        "approved"
      )) as any;
      expect(submitted.output.expiresAt).toBe(invocation.expiresAt);
      expect((await store.getTransferById(transferId))?.sourceDispatchId).toBeUndefined();
      await expect(
        new AdcClient("http://adc.test", "other", fetcher).uploadTransferChunk(
          transferId,
          0,
          payload.subarray(0, 1024 * 1024)
        )
      ).rejects.toMatchObject({ statusCode: 403 });
      await agent.uploadTransferChunk(transferId, 0, payload.subarray(0, 1024 * 1024));
      const requestsBeforeRetry = objectRequests;
      await agent.uploadTransferChunk(transferId, 0, payload.subarray(0, 1024 * 1024));
      expect(objectRequests).toBe(requestsBeforeRetry);
      await expect(
        agent.uploadTransferChunk(transferId, 0, Buffer.alloc(1024 * 1024, 1))
      ).rejects.toMatchObject({ statusCode: 409 });
      await agent.uploadTransferChunk(transferId, 1, payload.subarray(1024 * 1024));
      await daemon.runOnce();
      expect(await agent.taskWait(submitted.jobId, 4000)).toMatchObject({ status: "succeeded" });
      expect(await readFile(join(directory, "model.bin"))).toEqual(payload);
      expect(objects.size).toBe(0);
      await expect(
        agent.uploadTransferChunk(transferId, 0, payload.subarray(0, 1024 * 1024))
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await agent.invoke(invocation)).toMatchObject({ status: "succeeded" });
      expect(await agent.invoke(replay)).toMatchObject({ status: "succeeded" });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
