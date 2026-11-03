import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { AndroidReleaseManifestSchema } from "../apps/control-plane/src/android-distribution.ts";

// The source-controlled manifest pins the qualified signed bytes. CI never needs a signing key.
const manifest = AndroidReleaseManifestSchema.parse(
  JSON.parse(await readFile(resolve("apps/android-node/release.json"), "utf8"))
);
const file = basename(new URL(manifest.apk.url).pathname);
if (!/^adc-mobile-node-[0-9A-Za-z._+-]+-[a-f0-9]{16}\.apk$/.test(file)) {
  throw new Error("Invalid pinned Android release filename.");
}
const source = `https://github.com/zioon-tech/adc/releases/download/android-v${manifest.versionName}/${file}`;
const response = await fetch(source, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`Android release download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (
  bytes.byteLength !== manifest.apk.bytes ||
  createHash("sha256").update(bytes).digest("hex") !== manifest.apk.sha256
) {
  throw new Error("Android release does not match the qualified source manifest.");
}
const directory = resolve("dist/android");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, `${file}.next`), bytes);
await rename(resolve(directory, `${file}.next`), resolve(directory, file));
await copyFile(resolve(directory, file), resolve(directory, "preview.apk"));
await writeFile(resolve(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Verified Android ${manifest.versionName}: ${manifest.apk.sha256}`);
