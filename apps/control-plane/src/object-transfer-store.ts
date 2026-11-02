import OSS from "ali-oss";
import { TransferIdSchema } from "@adc/protocol";

export interface TransferTicket {
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface DirectTransferStore {
  uploadTicket(
    transferId: string,
    index: number,
    bytes: number,
    sha256: string,
    contentMd5: string
  ): Promise<TransferTicket>;
  downloadTicket(
    transferId: string,
    index: number
  ): Promise<TransferTicket & { sha256: string; bytes: number }>;
  deleteTransfer(transferId: string): Promise<void>;
}

/** Only metadata and signatures pass through this adapter. File bytes never enter ADC. */
export class OssDirectTransferStore implements DirectTransferStore {
  constructor(
    private readonly client: OSS,
    private readonly prefix = "transfers/",
    private readonly expiresSeconds = 300
  ) {
    if (!/^[a-zA-Z0-9/_-]+\/$/.test(prefix) || prefix.startsWith("/")) {
      throw new Error("transfer object prefix must be a relative prefix ending in /");
    }
    if (!Number.isInteger(expiresSeconds) || expiresSeconds < 30 || expiresSeconds > 900) {
      throw new Error("transfer ticket lifetime must be between 30 and 900 seconds");
    }
  }

  private key(transferId: string, index: number): string {
    TransferIdSchema.parse(transferId);
    if (!Number.isSafeInteger(index) || index < 0 || index >= 1_000_000) {
      throw new Error("invalid transfer chunk index");
    }
    return `${this.prefix}${transferId}/${index.toString().padStart(6, "0")}`;
  }

  async uploadTicket(
    transferId: string,
    index: number,
    bytes: number,
    sha256: string,
    contentMd5: string
  ): Promise<TransferTicket> {
    if (!/^sha256:[a-f0-9]{64}$/.test(sha256) || !/^[A-Za-z0-9+/]{22}==$/.test(contentMd5)) {
      throw new Error("invalid transfer chunk digest");
    }
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 32 * 1024 * 1024) {
      throw new Error("invalid transfer chunk size");
    }
    const headers = {
      "content-type": "application/octet-stream",
      "content-length": String(bytes),
      "content-md5": contentMd5,
      "x-oss-forbid-overwrite": "true",
      "x-oss-meta-adc-sha256": sha256,
      "x-oss-meta-adc-bytes": String(bytes)
    };
    return {
      url: await this.client.signatureUrlV4(
        "PUT",
        this.expiresSeconds,
        { headers },
        this.key(transferId, index),
        ["content-length"]
      ),
      headers,
      expiresAt: new Date(Date.now() + this.expiresSeconds * 1000).toISOString()
    };
  }

  async downloadTicket(
    transferId: string,
    index: number
  ): Promise<TransferTicket & { sha256: string; bytes: number }> {
    const key = this.key(transferId, index);
    const result = await this.client.head(key);
    const headers = result.res.headers as Record<string, string>;
    const sha256 = String(headers["x-oss-meta-adc-sha256"] ?? "");
    const bytes = Number(headers["content-length"]);
    if (
      !/^sha256:[a-f0-9]{64}$/.test(sha256) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > 32 * 1024 * 1024 ||
      Number(headers["x-oss-meta-adc-bytes"]) !== bytes
    ) {
      throw new Error("invalid stored transfer chunk metadata");
    }
    return {
      url: await this.client.signatureUrlV4("GET", this.expiresSeconds, undefined, key),
      headers: {},
      expiresAt: new Date(Date.now() + this.expiresSeconds * 1000).toISOString(),
      sha256,
      bytes
    };
  }

  async deleteTransfer(transferId: string): Promise<void> {
    TransferIdSchema.parse(transferId);
    const prefix = `${this.prefix}${transferId}/`;
    // Each iteration starts at the prefix because the previous batch was deleted.
    // Bound API work even if an outstanding upload ticket recreates an object.
    for (let batch = 0; batch < 1001; batch++) {
      const result = await this.client.list({ prefix, "max-keys": 1000 }, {});
      const names = (result.objects ?? []).map((object) => object.name);
      if (!names.length) return;
      const deleted = await this.client.deleteMulti(names, { quiet: false });
      if (deleted.deleted?.length !== names.length) {
        throw new Error("transfer object cleanup was incomplete");
      }
    }
    throw new Error("transfer object cleanup exceeded its batch limit");
  }
}
