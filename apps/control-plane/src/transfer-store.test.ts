import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalTransferBlobStore } from "./transfer-store.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("LocalTransferBlobStore", () => {
  it("atomically stores idempotent verified chunks and removes a transfer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adc-transfer-store-"));
    directories.push(directory);
    const store = new LocalTransferBlobStore(directory);
    const data = Buffer.from("native-transfer");
    const digest = `sha256:${createHash("sha256").update(data).digest("hex")}`;

    await store.putChunk("xfr_example", 0, data, digest);
    await store.putChunk("xfr_example", 0, data, digest);

    await expect(store.getChunk("xfr_example", 0)).resolves.toEqual(data);
    await expect(readFile(join(directory, "xfr_example", "000000000.chunk"))).resolves.toEqual(
      data
    );

    await store.deleteTransfer("xfr_example");
    await expect(store.getChunk("xfr_example", 0)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects data that does not match the declared digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adc-transfer-store-"));
    directories.push(directory);
    const store = new LocalTransferBlobStore(directory);

    await expect(
      store.putChunk("xfr_example", 0, Buffer.from("wrong"), `sha256:${"0".repeat(64)}`)
    ).rejects.toThrow("hash mismatch");
  });
});
