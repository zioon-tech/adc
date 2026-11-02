import { createHash, randomBytes } from "node:crypto";
import {
  CapabilitySchema,
  ErrorSchema,
  ResultSchema,
  type CapabilityAdvertisement,
  type InvocationResult,
  type NodePlatform
} from "@adc/protocol";
import { AdcClientError, type NodePollResponse } from "./index.ts";

export { AdcClientError } from "./index.ts";
export type { NodeDispatch, NodePollResponse, NodeReleaseUpdate } from "./index.ts";
import { signNodeRequest } from "./node-auth.ts";

export * from "./node-auth.ts";

type Fetch = typeof globalThis.fetch;

export interface PairedNode {
  nodeId: string;
  accountId: string;
}

export class NodeApiClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    readonly nodeId: string | undefined,
    private readonly privateKey: string,
    private readonly fetcher: Fetch = fetch
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async pair(input: {
    code: string;
    label: string;
    platform: NodePlatform;
    publicKey: string;
  }): Promise<PairedNode> {
    const response = await this.fetcher(`${this.baseUrl}/api/v1/nodes/pair`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error((body as any)?.error?.message ?? "node pairing failed");
    }
    return body as PairedNode;
  }

  private async signedFetch(
    path: string,
    input: {
      method?: "GET" | "POST" | "PUT";
      body?: unknown;
      contentType?: string;
      timeoutMs?: number;
      headers?: Record<string, string>;
      signal?: AbortSignal | undefined;
    }
  ): Promise<Response> {
    if (!this.nodeId) {
      throw new Error("node is not paired");
    }
    const method = input.method ?? "POST";
    const timestamp = new Date().toISOString();
    const nonce = randomBytes(18).toString("base64url");
    const signature = signNodeRequest(this.privateKey, {
      method,
      path,
      timestamp,
      nonce,
      body: input.body
    });
    return this.fetcher(`${this.baseUrl}${path}`, {
      method,
      signal: transferSignal(input.signal, input.timeoutMs ?? 15_000),
      redirect: "error",
      headers: {
        ...(input.body === undefined
          ? {}
          : {
              "content-type":
                input.contentType ??
                (input.body instanceof Uint8Array ? "application/octet-stream" : "application/json")
            }),
        "x-adc-node-id": this.nodeId,
        "x-adc-timestamp": timestamp,
        "x-adc-nonce": nonce,
        "x-adc-signature": signature,
        ...input.headers
      },
      ...(input.body === undefined
        ? {}
        : {
            body:
              input.body instanceof Uint8Array
                ? (input.body as BodyInit)
                : JSON.stringify(input.body)
          })
    });
  }

  private async signedRequest(path: string, body: unknown, signal?: AbortSignal): Promise<any> {
    const response = await this.signedFetch(path, { body, signal });
    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      const parsed = ErrorSchema.safeParse((responseBody as any)?.error);
      throw new AdcClientError(
        response.status,
        parsed.success
          ? parsed.data
          : {
              code: "internal",
              message: `node API returned HTTP ${response.status}`,
              retryable: response.status >= 500
            }
      );
    }
    return responseBody;
  }

  private async parseSignedResponse(response: Response): Promise<any> {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const parsed = ErrorSchema.safeParse((body as any)?.error);
      throw new AdcClientError(
        response.status,
        parsed.success
          ? parsed.data
          : {
              code: "internal",
              message: `node API returned HTTP ${response.status}`,
              retryable: response.status >= 500
            }
      );
    }
    return body;
  }

  async poll(
    capability: CapabilityAdvertisement,
    state: { activeTaskCount?: number; claim?: boolean; waitMs?: number } = {}
  ): Promise<NodePollResponse> {
    return this.signedRequest(`/api/v1/nodes/${encodeURIComponent(this.nodeId!)}/poll`, {
      capability: CapabilitySchema.parse(capability),
      activeTaskCount: state.activeTaskCount ?? 0,
      claim: state.claim ?? true,
      ...(state.waitMs === undefined ? {} : { waitMs: state.waitMs })
    }) as Promise<NodePollResponse>;
  }

  async acknowledge(dispatchId: string, leaseToken: string): Promise<any> {
    return this.signedRequest(`/api/v1/nodes/${encodeURIComponent(this.nodeId!)}/ack`, {
      dispatchId,
      leaseToken
    });
  }

  async renewLease(dispatchId: string, leaseToken: string): Promise<any> {
    return this.signedRequest(`/api/v1/nodes/${encodeURIComponent(this.nodeId!)}/leases/renew`, {
      dispatchId,
      leaseToken
    });
  }

  async rotateKey(publicKey: string): Promise<any> {
    return this.signedRequest(`/api/v1/nodes/${encodeURIComponent(this.nodeId!)}/rotate-key`, {
      publicKey
    });
  }

  async uploadArtifact(input: {
    dispatchId: string;
    artifactId: string;
    contentType: string;
    sha256: string;
    data: Buffer;
  }): Promise<any> {
    return this.signedRequest(`/api/v1/nodes/${encodeURIComponent(this.nodeId!)}/artifacts`, {
      dispatchId: input.dispatchId,
      artifactId: input.artifactId,
      contentType: input.contentType,
      sha256: input.sha256,
      dataBase64: input.data.toString("base64")
    });
  }

  async prepareTransfer(
    transferId: string,
    input: { byteSize: number; chunkCount: number },
    signal?: AbortSignal
  ): Promise<any> {
    return this.signedRequest(
      `/api/v1/nodes/${encodeURIComponent(this.nodeId!)}/transfers/${encodeURIComponent(transferId)}/prepare`,
      input,
      signal
    );
  }

  async uploadTransferChunk(
    transferId: string,
    index: number,
    data: Buffer,
    sha256: string,
    signal?: AbortSignal
  ): Promise<any> {
    if (`sha256:${createHash("sha256").update(data).digest("hex")}` !== sha256) {
      throw new Error("transfer chunk digest mismatch");
    }
    const metadata = await this.transferMetadata(transferId, signal);
    if (metadata.dataPlane === "object") {
      const ticketPath = `/api/v1/nodes/${encodeURIComponent(this.nodeId!)}/transfers/${encodeURIComponent(transferId)}/chunks/${index}/ticket`;
      const ticketBody = {
        operation: "upload",
        sha256,
        contentMd5: createHash("md5").update(data).digest("base64")
      };
      const ticket = await this.signedRequest(ticketPath, ticketBody, signal);
      if (ticket.alreadyUploaded) return { accepted: true };
      validateTransferTicket(ticket);
      const uploaded = await this.fetcher(ticket.url, {
        method: "PUT",
        headers: ticket.headers,
        body: data as BodyInit,
        redirect: "error",
        signal: transferSignal(signal, 120_000)
      });
      // A concurrent retry may have committed the same immutable chunk.
      if (uploaded.status === 409) {
        const retry = await this.signedRequest(ticketPath, ticketBody, signal);
        if (retry.alreadyUploaded) return { accepted: true };
      }
      if (!uploaded.ok) {
        throw new AdcClientError(uploaded.status, {
          code: "execution_failed",
          message: `object upload returned HTTP ${uploaded.status}`,
          retryable: uploaded.status >= 500
        });
      }
      return { accepted: true };
    }
    const response = await this.signedFetch(
      `/api/v1/nodes/${encodeURIComponent(this.nodeId!)}/transfers/${encodeURIComponent(transferId)}/chunks/${index}`,
      {
        method: "PUT",
        body: data,
        signal,
        timeoutMs: 120_000,
        headers: { "x-adc-content-sha256": sha256 }
      }
    );
    return this.parseSignedResponse(response);
  }

  async transferMetadata(transferId: string, signal?: AbortSignal): Promise<any> {
    const response = await this.signedFetch(
      `/api/v1/nodes/${encodeURIComponent(this.nodeId!)}/transfers/${encodeURIComponent(transferId)}`,
      { method: "GET", signal }
    );
    return this.parseSignedResponse(response);
  }

  async downloadTransferChunk(
    transferId: string,
    index: number,
    signal?: AbortSignal
  ): Promise<{ data: Buffer; sha256: string }> {
    const metadata = await this.transferMetadata(transferId, signal);
    if (metadata.dataPlane === "object") {
      const ticket = await this.signedRequest(
        `/api/v1/nodes/${encodeURIComponent(this.nodeId!)}/transfers/${encodeURIComponent(transferId)}/chunks/${index}/ticket`,
        { operation: "download" },
        signal
      );
      validateTransferTicket(ticket);
      if (
        !Number.isSafeInteger(ticket.bytes) ||
        ticket.bytes < 1 ||
        ticket.bytes > 32 * 1024 * 1024
      ) {
        throw new Error("invalid object transfer size");
      }
      const downloaded = await this.fetcher(ticket.url, {
        method: "GET",
        headers: ticket.headers,
        redirect: "error",
        signal: transferSignal(signal, 120_000)
      });
      if (!downloaded.ok) {
        throw new AdcClientError(downloaded.status, {
          code: downloaded.status === 404 ? "not_found" : "execution_failed",
          message: `object download returned HTTP ${downloaded.status}`,
          retryable: downloaded.status >= 500 || downloaded.status === 404
        });
      }
      if (!downloaded.body) throw new Error("empty object response");
      const reader = downloaded.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > ticket.bytes) throw new Error("object response exceeds expected size");
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (bytes !== ticket.bytes) throw new Error("object response size mismatch");
      const data = Buffer.concat(chunks);
      if (`sha256:${createHash("sha256").update(data).digest("hex")}` !== ticket.sha256) {
        throw new Error("object transfer digest mismatch");
      }
      return { data, sha256: ticket.sha256 };
    }
    const response = await this.signedFetch(
      `/api/v1/nodes/${encodeURIComponent(this.nodeId!)}/transfers/${encodeURIComponent(transferId)}/chunks/${index}`,
      { method: "GET", timeoutMs: 120_000, signal }
    );
    if (!response.ok) {
      await this.parseSignedResponse(response);
    }
    return {
      data: Buffer.from(await response.arrayBuffer()),
      sha256: response.headers.get("x-adc-content-sha256") ?? ""
    };
  }

  async finalizeTransferSource(
    transferId: string,
    contentSha256: string,
    signal?: AbortSignal
  ): Promise<any> {
    return this.signedRequest(
      `/api/v1/nodes/${encodeURIComponent(this.nodeId!)}/transfers/${encodeURIComponent(transferId)}/finalize-source`,
      { contentSha256 },
      signal
    );
  }

  async updateTransferProgress(
    transferId: string,
    input: { bytesTransferred: number; status: "transferring" | "verifying" },
    signal?: AbortSignal
  ): Promise<any> {
    return this.signedRequest(
      `/api/v1/nodes/${encodeURIComponent(this.nodeId!)}/transfers/${encodeURIComponent(transferId)}/progress`,
      input,
      signal
    );
  }

  async complete(input: {
    dispatchId: string;
    leaseToken: string;
    result: InvocationResult;
  }): Promise<any> {
    return this.signedRequest(`/api/v1/nodes/${encodeURIComponent(this.nodeId!)}/receipts`, {
      dispatchId: input.dispatchId,
      leaseToken: input.leaseToken,
      result: ResultSchema.parse(input.result),
      ...(input.result.receipt ? { receipt: input.result.receipt } : {})
    });
  }
}

function validateTransferTicket(ticket: any): void {
  const url = new URL(ticket.url);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("object transfer ticket must use HTTPS");
  }
  if (!ticket.headers || typeof ticket.headers !== "object" || Array.isArray(ticket.headers)) {
    throw new Error("invalid object transfer headers");
  }
  if (
    !Number.isFinite(Date.parse(ticket.expiresAt)) ||
    Date.parse(ticket.expiresAt) <= Date.now()
  ) {
    throw new Error("object transfer ticket expired");
  }
  if (Object.keys(ticket.headers).some((name) => /^(authorization|cookie|x-adc-)/i.test(name))) {
    throw new Error("object transfer ticket contains control-plane credentials");
  }
}

function transferSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
