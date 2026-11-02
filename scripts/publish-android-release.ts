import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readdirSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AndroidReleaseManifestSchema } from "../apps/control-plane/src/android-distribution.ts";

interface Options {
  apk?: string;
  downloadUrl?: string;
  output: string;
  notesZh?: string;
  notesEn?: string;
  required: boolean;
  publishedAt: string;
  apksigner?: string;
  aapt2?: string;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2).filter((value) => value !== "--");
const options: Options = {
  output: resolve(root, "dist/android"),
  required: false,
  publishedAt: new Date().toISOString()
};

for (let index = 0; index < args.length; index++) {
  const value = args[index]!;
  const next = () => {
    const argument = args[++index];
    if (!argument) throw new Error(`${value} requires a value.`);
    return argument;
  };
  if (value === "--apk") options.apk = resolve(next());
  else if (value === "--download-url") options.downloadUrl = next();
  else if (value === "--out-dir") options.output = resolve(next());
  else if (value === "--notes-zh") options.notesZh = next();
  else if (value === "--notes-en") options.notesEn = next();
  else if (value === "--notes-zh-file") options.notesZh = await readFile(resolve(next()), "utf8");
  else if (value === "--notes-en-file") options.notesEn = await readFile(resolve(next()), "utf8");
  else if (value === "--published-at") options.publishedAt = next();
  else if (value === "--required") options.required = true;
  else if (value === "--apksigner") options.apksigner = resolve(next());
  else if (value === "--aapt2") options.aapt2 = resolve(next());
  else throw new Error(`Unknown option: ${value}`);
}

if (!options.apk || !options.downloadUrl || !options.notesZh?.trim() || !options.notesEn?.trim()) {
  throw new Error(
    "Required: --apk, --download-url, --notes-zh/--notes-zh-file and --notes-en/--notes-en-file."
  );
}
if (!(await stat(options.apk)).isFile()) throw new Error("Signed Android APK was not found.");

function androidSdkCandidates(tool: "apksigner" | "aapt2"): string[] {
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    resolve(homedir(), "Library/Android/sdk")
  ].filter((value): value is string => !!value);
  return sdkRoots.flatMap((sdk) => {
    try {
      return readdirSync(resolve(sdk, "build-tools"))
        .sort()
        .reverse()
        .map((version) => resolve(sdk, "build-tools", version, tool));
    } catch {
      return [];
    }
  });
}

function resolveTool(explicit: string | undefined, tool: "apksigner" | "aapt2"): string {
  if (explicit) return explicit;
  for (const candidate of androidSdkCandidates(tool)) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next installed Android SDK location.
    }
  }
  try {
    const locator = process.platform === "win32" ? "where" : "which";
    return execFileSync(locator, [tool], { encoding: "utf8" }).trim().split(/\r?\n/)[0]!;
  } catch {
    throw new Error(`Unable to locate ${tool}; pass --${tool} PATH.`);
  }
}

function run(tool: string, command: string[]): string {
  return execFileSync(tool, command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

const apksigner = resolveTool(options.apksigner, "apksigner");
const aapt2 = resolveTool(options.aapt2, "aapt2");
const signerOutput = run(apksigner, ["verify", "--verbose", "--print-certs", options.apk]);
const certificateMatch = signerOutput.match(
  /Signer #1 certificate SHA-256 digest:\s*([a-fA-F0-9:]{64,95})/
);
if (!certificateMatch) throw new Error("apksigner did not report a SHA-256 signing certificate.");
const signingCertificateSha256 = certificateMatch[1]!.replaceAll(":", "").toLowerCase();
const badging = run(aapt2, ["dump", "badging", options.apk]);
const packageMetadata = badging.match(
  /^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'/m
);
const minSdkMetadata = badging.match(/^minSdkVersion:'([0-9]+)'/m);
if (!packageMetadata || !minSdkMetadata) {
  throw new Error("aapt2 could not read the APK package and minimum SDK metadata.");
}
if (/^application-debuggable$/m.test(badging)) {
  throw new Error("Debuggable APKs cannot be published to the Android release channel.");
}
const packageName = packageMetadata[1]!;
const versionCode = Number(packageMetadata[2]);
const versionName = packageMetadata[3]!;
const minSdk = Number(minSdkMetadata[1]);
if (packageName !== "cloud.agentdevice.node") {
  throw new Error(`Unexpected Android package name: ${packageName}`);
}

const downloadUrl = new URL(options.downloadUrl);
const loopback =
  downloadUrl.protocol === "http:" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(downloadUrl.hostname);
if (
  (downloadUrl.protocol !== "https:" && !loopback) ||
  downloadUrl.username ||
  downloadUrl.password ||
  downloadUrl.search ||
  downloadUrl.hash ||
  downloadUrl.pathname.replace(/\/$/, "") !== "/downloads/android"
) {
  throw new Error(
    "--download-url must be an HTTPS /downloads/android URL without credentials, query or fragment."
  );
}

const apkBytes = await readFile(options.apk);
const sha256 = createHash("sha256").update(apkBytes).digest("hex");
const fileName = `adc-mobile-node-${versionName}-${sha256.slice(0, 16)}.apk`;
const release = AndroidReleaseManifestSchema.parse({
  schemaVersion: 1,
  packageName,
  versionName,
  versionCode,
  minSdk,
  publishedAt: options.publishedAt,
  required: options.required,
  releaseNotes: {
    "zh-CN": options.notesZh.trim(),
    en: options.notesEn.trim()
  },
  apk: {
    url: `${downloadUrl.href.replace(/\/$/, "")}/${fileName}`,
    sha256,
    bytes: apkBytes.byteLength,
    signingCertificateSha256
  }
});

await mkdir(options.output, { recursive: true });
const apkTemporary = resolve(options.output, `.${fileName}.next`);
await copyFile(options.apk, apkTemporary);
await rename(apkTemporary, resolve(options.output, fileName));
const manifestTemporary = resolve(options.output, ".manifest.json.next");
await writeFile(manifestTemporary, `${JSON.stringify(release, null, 2)}\n`);
await rename(manifestTemporary, resolve(options.output, "manifest.json"));

console.log(`Published ${basename(options.apk)} as ${fileName}`);
console.log(`Certificate SHA-256: ${signingCertificateSha256}`);
console.log(`Release directory: ${options.output}`);
