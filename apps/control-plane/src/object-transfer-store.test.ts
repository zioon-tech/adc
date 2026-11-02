import OSS from "ali-oss";
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OssDirectTransferStore } from "./object-transfer-store.ts";

const sha256 = `sha256:${"a".repeat(64)}`;
const md5 = "CY9rzUYh03PK3k6DJie09g==";

function fixture() {
  const client = new OSS({
    region: "oss-cn-shanghai",
    bucket: "adc-test-private",
    accessKeyId: "test-id",
    accessKeySecret: "test-secret",
    secure: true
  });
  return { client, store: new OssDirectTransferStore(client) };
}

describe("OssDirectTransferStore", () => {
  it("signs length, MD5 and immutable metadata with the real OSS SDK", async () => {
    const { store } = fixture();
    const ticket = await store.uploadTicket("xfr_example", 0, 4, sha256, md5);
    const url = new URL(ticket.url);
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/transfers/xfr_example/000000");
    expect(url.searchParams.get("x-oss-additional-headers")).toBe("content-length");
    const encode = (value: string) =>
      encodeURIComponent(value).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      );
    const queries = [...url.searchParams.entries()]
      .filter(([key]) => key !== "x-oss-signature")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${encode(key)}=${encode(value)}`)
      .join("&");
    const canonical = [
      "PUT",
      "/adc-test-private/transfers/xfr_example/000000",
      queries,
      `content-length:4\ncontent-md5:${md5}\ncontent-type:application/octet-stream\nx-oss-forbid-overwrite:true\nx-oss-meta-adc-bytes:4\nx-oss-meta-adc-sha256:${sha256}\n`,
      "content-length",
      "UNSIGNED-PAYLOAD"
    ].join("\n");
    const date = url.searchParams.get("x-oss-date")!;
    const day = date.slice(0, 8);
    const hmac = (key: string | Buffer, value: string) =>
      createHmac("sha256", key).update(value).digest();
    const signingKey = hmac(
      hmac(hmac(hmac(`aliyun_v4test-secret`, day), "cn-shanghai"), "oss"),
      "aliyun_v4_request"
    );
    const toSign = [
      "OSS4-HMAC-SHA256",
      date,
      `${day}/cn-shanghai/oss/aliyun_v4_request`,
      createHash("sha256").update(canonical).digest("hex")
    ].join("\n");
    expect(url.searchParams.get("x-oss-signature")).toBe(hmac(signingKey, toSign).toString("hex"));
    expect(ticket.headers).toMatchObject({
      "content-md5": md5,
      "content-length": "4",
      "x-oss-forbid-overwrite": "true",
      "x-oss-meta-adc-sha256": sha256,
      "x-oss-meta-adc-bytes": "4"
    });
    expect(Date.parse(ticket.expiresAt)).toBeGreaterThan(Date.now());
  });

  it.each([
    ["../unsafe/", 300],
    ["/transfers/", 300],
    ["transfers/", 29],
    ["transfers/", 901]
  ])("rejects invalid store configuration %s %s", (prefix, expires) => {
    const { client } = fixture();
    expect(() => new OssDirectTransferStore(client, String(prefix), Number(expires))).toThrow();
  });

  it.each([
    ["../escape", 0, 4, sha256, md5],
    ["xfr_example", -1, 4, sha256, md5],
    ["xfr_example", 1_000_000, 4, sha256, md5],
    ["xfr_example", 0, 0, sha256, md5],
    ["xfr_example", 0, 32 * 1024 * 1024 + 1, sha256, md5],
    ["xfr_example", 0, 4, "invalid", md5],
    ["xfr_example", 0, 4, sha256, "invalid"]
  ])("rejects invalid upload parameters %s %s %s", async (id, index, bytes, hash, contentMd5) => {
    const { client, store } = fixture();
    const signer = vi.spyOn(client, "signatureUrlV4");
    await expect(
      store.uploadTicket(String(id), Number(index), Number(bytes), String(hash), String(contentMd5))
    ).rejects.toThrow();
    expect(signer).not.toHaveBeenCalled();
  });

  it("validates HEAD metadata before issuing a download ticket and preserves missing-object errors", async () => {
    const { client, store } = fixture();
    const head = vi.spyOn(client, "head");
    head.mockResolvedValue({
      res: {
        headers: {
          "content-length": "4",
          "x-oss-meta-adc-bytes": "4",
          "x-oss-meta-adc-sha256": sha256
        }
      }
    } as any);
    expect(await store.downloadTicket("xfr_example", 7)).toMatchObject({
      bytes: 4,
      sha256,
      headers: {}
    });
    expect(head).toHaveBeenCalledWith("transfers/xfr_example/000007");
    for (const headers of [
      { "content-length": "4", "x-oss-meta-adc-bytes": "3", "x-oss-meta-adc-sha256": sha256 },
      { "content-length": "4", "x-oss-meta-adc-bytes": "4" },
      { "content-length": "0", "x-oss-meta-adc-bytes": "0", "x-oss-meta-adc-sha256": sha256 }
    ]) {
      head.mockResolvedValue({ res: { headers } } as any);
      await expect(store.downloadTicket("xfr_example", 0)).rejects.toThrow("invalid stored");
    }
    head.mockRejectedValue(Object.assign(new Error("missing"), { status: 404 }));
    await expect(store.downloadTicket("xfr_example", 0)).rejects.toMatchObject({ status: 404 });
  });

  it("deletes only its transfer prefix in batches and rejects incomplete cleanup", async () => {
    const { client, store } = fixture();
    const list = vi
      .spyOn(client, "list")
      .mockResolvedValueOnce({ objects: [{ name: "transfers/xfr_example/000000" }] } as any)
      .mockResolvedValueOnce({ objects: [{ name: "transfers/xfr_example/000001" }] } as any)
      .mockResolvedValueOnce({ objects: [] } as any);
    const remove = vi
      .spyOn(client, "deleteMulti")
      .mockImplementation(async (names) => ({ deleted: names, res: {} }) as any);
    await store.deleteTransfer("xfr_example");
    expect(list).toHaveBeenCalledTimes(3);
    expect(list).toHaveBeenCalledWith({ prefix: "transfers/xfr_example/", "max-keys": 1000 }, {});
    expect(remove).toHaveBeenCalledTimes(2);
    list.mockResolvedValue({ objects: [{ name: "transfers/xfr_example/000000" }] } as any);
    remove.mockResolvedValue({ deleted: [], res: {} } as any);
    await expect(store.deleteTransfer("xfr_example")).rejects.toThrow("incomplete");
  });

  it("bounds cleanup work when uploads keep recreating objects", async () => {
    const { client, store } = fixture();
    const list = vi.spyOn(client, "list").mockResolvedValue({
      objects: [{ name: "transfers/xfr_example/000000" }]
    } as any);
    vi.spyOn(client, "deleteMulti").mockResolvedValue({
      deleted: ["transfers/xfr_example/000000"],
      res: {}
    } as any);
    await expect(store.deleteTransfer("xfr_example")).rejects.toThrow("batch limit");
    expect(list).toHaveBeenCalledTimes(1001);
  });
});
