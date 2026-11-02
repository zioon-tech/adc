import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { zipSync, type Zippable } from "fflate";
import { ADC_ORIGIN, nativeTools, PLUGIN_VERSION } from "../packages/harness-core/src/index.ts";

const root = resolve(import.meta.dirname, "..");
const name = "agent-device-cloud";
const description =
  "Connect authorized ADC devices, use live tools, and track tasks and approvals.";
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const identity = {
  name,
  version: PLUGIN_VERSION,
  description,
  author: { name: "ADC" },
  homepage: `${ADC_ORIGIN}/docs/integrations#plugins`
};
const commands = {
  "adc-setup":
    "Use the adc-setup Skill to guide my ADC connection, account sign-in, device setup and authorization.",
  "adc-devices":
    "Use the adc Skill to discover my ADC devices and help me select the intended target and platform.",
  "adc-tasks":
    "Use the adc Skill to inspect existing ADC invocation/job identities and their receipts. Do not resubmit.",
  "adc-approval":
    "Use the adc Skill to show the ADC approval review link. The human decides, then inspect the same invocation."
};
export const pluginHosts = [
  "portable",
  "claude",
  "codex",
  "cursor",
  "copilot",
  "gemini",
  "droid",
  "opencode",
  "pi",
  "cline",
  "zion"
] as const;

export async function buildPlugins(output = resolve(root, "dist/plugins")) {
  const allFiles: Record<string, Uint8Array> = {};
  const index: Array<{
    host: string;
    file: string;
    sha256: string;
    bytes: number;
    version: string;
  }> = [];
  await mkdir(output, { recursive: true });
  // Only remove this generator's package trees; keep immutable prior archives available.
  await rm(resolve(output, "packages"), { recursive: true, force: true });
  async function sourceTree(directory: string, prefix: string, files: Record<string, Uint8Array>) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (entry.isDirectory())
        await sourceTree(resolve(directory, entry.name), `${prefix}/${entry.name}`, files);
      else if (entry.isFile())
        files[`${prefix}/${entry.name}`] = await readFile(resolve(directory, entry.name));
      else throw new Error("Plugin source must contain only regular files.");
    }
  }
  async function bundle(source: string, platform: "node" | "browser", entry?: string) {
    const result = await build({
      ...(entry
        ? {
            stdin: {
              contents: entry,
              resolveDir: root,
              sourcefile: `${source}-entry.ts`,
              loader: "ts"
            }
          }
        : { entryPoints: [resolve(root, source)] }),
      bundle: true,
      platform,
      format: "esm",
      target: platform === "node" ? "node22" : "es2022",
      minify: true,
      write: false,
      legalComments: "inline",
      external: ["@cline/sdk", "@opencode-ai/plugin"],
      // Ajv's CommonJS dynamic require needs an ESM bridge in bundled Node entries.
      ...(platform === "node"
        ? {
            banner: {
              js: "import {createRequire as __adcCreateRequire} from 'node:module';const require=__adcCreateRequire(import.meta.url);"
            }
          }
        : {})
    });
    return result.outputFiles[0]!.contents;
  }
  async function archive(host: string, files: Record<string, Uint8Array>) {
    const entries: Zippable = {};
    for (const file of Object.keys(files).sort())
      entries[file] = [files[file]!, { mtime: new Date("2000-01-01T00:00:00Z") }];
    const bytes = zipSync(entries, { level: 9 });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const file = `${name}-${host}-${PLUGIN_VERSION}-${sha256.slice(0, 16)}.zip`;
    await writeFile(resolve(output, file), bytes);
    await writeFile(resolve(output, `${name}-${host}.zip`), bytes);
    index.push({ host, version: PLUGIN_VERSION, file, sha256, bytes: bytes.byteLength });
  }
  for (const host of pluginHosts) {
    const files: Record<string, Uint8Array> = {};
    const add = (path: string, value: string | object) => {
      files[path] = Buffer.from(typeof value === "string" ? value : json(value));
    };
    await sourceTree(resolve(root, "plugins/workflows"), "skills", files);
    await sourceTree(resolve(root, "skills", name), `skills/${name}`, files);
    const readme = (await readFile(resolve(root, "plugins/README.md"), "utf8")).replace(
      "../docs/harness-plugin-validation.md",
      "./VALIDATION.md"
    );
    add("README.md", `# ADC ${host} plugin ${PLUGIN_VERSION}\n\n${readme}`);
    files["VALIDATION.md"] = await readFile(resolve(root, "docs/harness-plugin-validation.md"));
    const portable = ["portable", "codex", "copilot"].includes(host);
    if (portable) {
      add("plugin.json", {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        ...identity,
        ...(host === "codex"
          ? {
              extensions: {
                "com.openai": {
                  onboardingSkill: "./skills/adc-setup/SKILL.md",
                  interface: {
                    displayName: "ADC",
                    shortDescription: description,
                    developerName: "ADC",
                    category: "Productivity",
                    websiteURL: ADC_ORIGIN,
                    defaultPrompt: ["Help me get started with ADC."]
                  }
                }
              }
            }
          : {})
      });
      add("mcp.json", {
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { adc: { type: "streamable-http", url: `${ADC_ORIGIN}/mcp` } }
      });
      if (host === "codex") {
        // Codex 0.131 predates root portable-manifest loading.
        add(".codex-plugin/plugin.json", {
          ...identity,
          skills: "./skills",
          mcpServers: "./.mcp.json",
          extensions: { "com.openai": { onboardingSkill: "./skills/adc-setup/SKILL.md" } }
        });
        add(".mcp.json", { mcpServers: { adc: { type: "http", url: `${ADC_ORIGIN}/mcp` } } });
      }
    }
    if (["claude", "cursor", "droid"].includes(host)) {
      add(
        host === "claude"
          ? ".claude-plugin/plugin.json"
          : host === "cursor"
            ? ".cursor-plugin/plugin.json"
            : ".factory-plugin/plugin.json",
        {
          ...identity,
          ...(host === "claude"
            ? {}
            : { skills: "./skills", commands: "./commands", mcpServers: "./mcp.json" })
        }
      );
      add(host === "claude" ? ".mcp.json" : "mcp.json", {
        mcpServers: { adc: { type: "http", url: `${ADC_ORIGIN}/mcp` } }
      });
    }
    if (host === "gemini") {
      add("gemini-extension.json", {
        ...identity,
        contextFileName: "GEMINI.md",
        mcpServers: { adc: { httpUrl: `${ADC_ORIGIN}/mcp` } }
      });
      add(
        "GEMINI.md",
        "Use the bundled adc-setup and adc Skills for ADC connection, live discovery, execution, tasks and human approvals.\n"
      );
    }
    if (["claude", "cursor", "droid", "gemini", "copilot", "pi"].includes(host)) {
      for (const [command, prompt] of Object.entries(commands)) {
        const folder =
          host === "copilot"
            ? "com.github.copilot/commands"
            : host === "pi"
              ? "prompts"
              : "commands";
        add(
          `${folder}/${command}.${host === "gemini" ? "toml" : "md"}`,
          host === "gemini"
            ? `description = ${JSON.stringify(prompt)}\nprompt = ${JSON.stringify(prompt)}\n`
            : `---\nname: ${command}\ndescription: ${prompt}\n---\n\n${prompt}\n`
        );
      }
    }
    if (host === "opencode") {
      files["index.mjs"] = await bundle(
        "plugins/opencode/index.ts",
        "node",
        "import {tool} from '@opencode-ai/plugin';import {createOpenCodePlugin} from './plugins/opencode/index.ts';export default createOpenCodePlugin(tool);"
      );
      add("package.json", {
        name: "adc-opencode-plugin",
        version: PLUGIN_VERSION,
        type: "module",
        exports: "./index.mjs",
        peerDependencies: { "@opencode-ai/plugin": ">=1.19.0" }
      });
      add("opencode.example.json", {
        $schema: "https://opencode.ai/config.json",
        permission: { adc_execute: "ask" }
      });
    }
    if (host === "pi") {
      files["index.mjs"] = await bundle("plugins/pi/index.ts", "node");
      add("package.json", {
        name: "adc-pi-extension",
        version: PLUGIN_VERSION,
        type: "module",
        pi: { extensions: ["./index.mjs"], skills: ["./skills"], prompts: ["./prompts"] }
      });
    }
    if (host === "cline") {
      const setupGuidance = await readFile(
        resolve(root, "skills/agent-device-cloud/references/getting-started.md"),
        "utf8"
      );
      files["index.mjs"] = await bundle(
        "plugins/cline/index.ts",
        "node",
        `import {createTool} from '@cline/sdk';import {createClinePlugin} from './plugins/cline/index.ts';export const createAgentDeviceCloudPlugin=(options={})=>createClinePlugin(createTool,{setupGuidance:${JSON.stringify(setupGuidance)},...options});export default createAgentDeviceCloudPlugin();`
      );
      add("package.json", {
        name: "adc-cline-plugin",
        version: PLUGIN_VERSION,
        type: "module",
        exports: "./index.mjs",
        cline: {
          plugins: [{ paths: ["./index.mjs"], capabilities: ["tools", "commands", "rules"] }]
        },
        peerDependencies: { "@cline/sdk": ">=0.0.93" },
        peerDependenciesMeta: { "@cline/sdk": { optional: true } }
      });
    }
    if (host === "zion") {
      files["runtime.mjs"] = await bundle("plugins/zion/runtime.ts", "node");
      files["workbench.mjs"] = await bundle("plugins/zion/workbench.ts", "browser");
      files["styles.css"] = await readFile(resolve(root, "plugins/zion/styles.css"));
      files["host-compat.patch"] = await readFile(resolve(root, "plugins/zion/host-compat.patch"));
      add("manifest.json", {
        name: "dev.agent-device-cloud",
        version: PLUGIN_VERSION,
        description,
        zion: {
          manifestVersion: 2,
          id: "dev.agent-device-cloud",
          name: "ADC",
          version: PLUGIN_VERSION,
          entries: {
            workbench: "./workbench.mjs",
            runtime: "./runtime.mjs",
            skill: "./skills/adc"
          },
          hosts: { workbench: true, runtime: true },
          runtime: { apiVersion: 2 },
          capabilities: nativeTools.map((tool) => ({
            id: tool.name,
            kind: "tool",
            host: "runtime",
            risk: ["adc_invoke", "adc_cancel"].includes(tool.name) ? "external" : "read",
            requiredScopes: []
          })),
          presentation: {
            displayName: { "zh-CN": "ADC", "en-US": "ADC" },
            icon: "remote",
            category: "ai"
          },
          contributes: {
            styles: ["./styles.css"],
            skills: ["./skills/adc", "./skills/adc-setup", `./skills/${name}`],
            commands: [
              { id: "adc.open", title: "ADC" },
              { id: "adc.refresh", title: "ADC: Refresh" }
            ]
          },
          activationEvents: ["onStartupFinished"]
        }
      });
    }
    for (const [file, bytes] of Object.entries(files)) {
      const path = resolve(output, "packages", host, file);
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, bytes);
      allFiles[`packages/${host}/${file}`] = bytes;
    }
    await archive(host, files);
  }
  const marketplace = (host: string) => ({
    name: "adc-plugins",
    owner: { name: "ADC" },
    plugins: [{ name, source: `./packages/${host}`, description, version: PLUGIN_VERSION }]
  });
  const marketplaces: Record<string, unknown> = {
    ".claude-plugin/marketplace.json": marketplace("claude"),
    ".cursor-plugin/marketplace.json": marketplace("cursor"),
    ".factory-plugin/marketplace.json": marketplace("droid"),
    ".agents/plugins/marketplace.json": {
      name: "adc-plugins",
      interface: { displayName: "ADC" },
      plugins: [
        {
          name,
          source: { source: "local", path: "./packages/codex" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity"
        }
      ]
    }
  };
  for (const [file, value] of Object.entries(marketplaces)) {
    const path = resolve(output, "marketplace", file);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, json(value));
    allFiles[file] = Buffer.from(json(value));
  }
  allFiles["README.md"] = Buffer.from(
    (await readFile(resolve(root, "plugins/README.md"), "utf8")).replace(
      "../docs/harness-plugin-validation.md",
      "./VALIDATION.md"
    )
  );
  allFiles["VALIDATION.md"] = await readFile(resolve(root, "docs/harness-plugin-validation.md"));
  await archive("marketplace", allFiles);
  await writeFile(resolve(output, "index.json"), json({ version: PLUGIN_VERSION, plugins: index }));
  await writeFile(
    resolve(output, "checksums.txt"),
    index.map((item) => `${item.sha256}  ${item.file}`).join("\n") + "\n"
  );
  // Cline permits HTTPS installation of a single file containing only Node / @cline imports.
  await writeFile(
    resolve(output, "agent-device-cloud-cline.mjs"),
    allFiles["packages/cline/index.mjs"]!
  );
  return index;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`Built ${(await buildPlugins()).length} ADC plugin archives`);
}
