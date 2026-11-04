import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const base = event.pull_request?.base?.sha || event.before;
const head = event.pull_request?.head?.sha || process.env.GITHUB_SHA;
const all = !base || /^0+$/.test(base) || process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
const paths = all
  ? []
  : execFileSync("git", ["diff", "--name-only", base, head], { encoding: "utf8" })
      .trim()
      .split("\n");
const shared = paths.some((path) =>
  /^(package\.json|pnpm-|tsconfig|\.github\/workflows\/|scripts\/ci\/)/.test(path)
);
const service =
  all || shared || paths.some((path) => !/^(docs\/|apps\/console\/|README|.*\.md$)/.test(path));
const site = all || shared || paths.some((path) => /^(apps\/console\/|docs\/)/.test(path));
const clientTools =
  all ||
  shared ||
  paths.some((path) =>
      /^(apps\/(?:cli|node)\/|packages\/|deploy\/(?:install\.|node-runtime)|scripts\/(?:build-node|build-sdk|release-manifest))/.test(
      path
    )
  );
for (const [component, affected] of Object.entries({
  service,
  site,
  "client-tools": clientTools
})) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${component}=${affected}\n`);
  console.log(`${component}: ${affected}`);
}
