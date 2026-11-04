import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const component = process.argv[2];
const stage = resolve(".release-stage", component);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const copy = (from, to = from) =>
  cpSync(from, resolve(stage, to), {
    recursive: true,
    verbatimSymlinks: true
  });
if (component === "service") {
  execFileSync("pnpm", ["exec", "tsx", "scripts/fetch-android-release.ts"], { stdio: "inherit" });
  execFileSync("bash", [
    "-e",
    "-o",
    "pipefail",
    "-c",
    'git archive HEAD | tar -x -C "$1"',
    "_",
    stage
  ]);
  for (const path of [
    "node_modules",
    "apps/control-plane/node_modules",
    "dist/skills",
    "dist/plugins",
    "dist/android"
  ])
    copy(path);
  for (const path of ["client", "db", "mcp-adapter", "policy", "protocol"])
    copy(`packages/${path}/node_modules`);
} else if (component === "console-and-site") copy("apps/console/dist", ".");
else if (component === "client-tools") {
  copy("dist/node", "node");
  copy("dist/sdk", "sdk");
} else throw new Error(`Unsupported component: ${component}`);
execFileSync(
  "python3",
  [
    resolve(process.env.RELEASE_TOOLS_DIR || ".release-tools", "scripts/pack.py"),
    "--stage",
    stage,
    "--output",
    resolve(".release-out", component),
    "--product",
    "adc",
    "--component",
    component
  ],
  { stdio: "inherit" }
);
