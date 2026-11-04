import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist/sdk");
const source = resolve(root, "packages/client");
const pkg = JSON.parse(await readFile(resolve(source, "package.json"), "utf8")) as {
  name: string;
  version: string;
};
const zod = resolve(root, "node_modules/zod");
const dependency = JSON.parse(await readFile(resolve(zod, "package.json"), "utf8")) as {
  version: string;
};
execFileSync("pnpm", ["--filter", "@adc/client", "build"], { cwd: root, stdio: "inherit" });
await mkdir(output, { recursive: true });
await mkdir(resolve(root, ".adc"), { recursive: true });
const stage = await mkdtemp(resolve(root, ".adc/sdk-build-"));
try {
  await cp(resolve(source, "dist"), resolve(stage, "dist"), { recursive: true });
  await cp(resolve(source, "README.md"), resolve(stage, "README.md"));
  await cp(resolve(root, "LICENSE"), resolve(stage, "LICENSE"));
  // Publish compiled exports, never the workspace-only TypeScript entrypoints.
  await writeFile(
    resolve(stage, "package.json"),
    `${JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        type: "module",
        license: "Apache-2.0",
        description: "ADC client SDK with the device invocation protocol included.",
        repository: {
          type: "git",
          url: "https://github.com/zioon-tech/adc.git",
          directory: "packages/client"
        },
        engines: { node: ">=18" },
        dependencies: { zod: dependency.version },
        bundledDependencies: ["zod"],
        exports: Object.fromEntries(
          [".", "./node"].map((entry) => {
            const name = entry === "." ? "index" : "node";
            return [entry, { types: `./dist/${name}.d.ts`, import: `./dist/${name}.js` }];
          })
        ),
        files: ["dist", "LICENSE", "THIRD-PARTY-NOTICES.txt", "licenses"]
      },
      null,
      2
    )}\n`
  );
  await mkdir(resolve(stage, "licenses"));
  await cp(zod, resolve(stage, "node_modules/zod"), { recursive: true, dereference: true });
  await cp(resolve(zod, "LICENSE"), resolve(stage, "licenses/zod-LICENSE"));
  await writeFile(
    resolve(stage, "THIRD-PARTY-NOTICES.txt"),
    `Includes Zod ${dependency.version} (MIT); see licenses/zod-LICENSE.\n`
  );
  const result = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
      cwd: stage,
      encoding: "utf8"
    })
  ) as Array<{ filename: string }>;
  const archive = resolve(stage, result[0]!.filename);
  const bytes = await readFile(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = `adc-client-${pkg.version}-${sha256.slice(0, 16)}.tgz`;
  await rename(archive, resolve(output, file));
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    archive: { file, sha256, bytes: bytes.length }
  };
  await writeFile(resolve(output, "SHA256SUMS"), `${sha256}  ${file}\n`);
  await writeFile(resolve(output, ".manifest.next"), `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(resolve(output, ".manifest.next"), resolve(output, "manifest.json"));
  console.log(`Built ${file}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
