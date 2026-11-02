import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { unzipSync } from "fflate";

// Optional real-host validation. Hosts and SDKs remain outside production dependencies.
const run = promisify(execFile);
const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : resolve(process.argv[index + 1]!);
};
const directory = await mkdtemp(resolve(tmpdir(), "adc-real-hosts-"));
const report: Record<string, unknown> = {};
try {
  const marketplace = resolve(directory, "marketplace");
  for (const [path, bytes] of Object.entries(
    unzipSync(await readFile("dist/plugins/agent-device-cloud-marketplace.zip"))
  )) {
    const target = resolve(marketplace, path);
    assert(target.startsWith(`${marketplace}/`));
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, bytes);
  }
  if (process.argv.includes("--claude")) {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: resolve(directory, "claude") };
    await run("claude", ["plugin", "validate", marketplace], { env });
    await run("claude", ["plugin", "validate", resolve(marketplace, "packages/claude")], { env });
    await run("claude", ["plugin", "marketplace", "add", marketplace], { env });
    await run("claude", ["plugin", "install", "agent-device-cloud@adc-plugins"], { env });
    const { stdout } = await run("claude", ["plugin", "list", "--json"], { env });
    assert(stdout.includes("agent-device-cloud@adc-plugins"));
    report.claude = {
      version: (await run("claude", ["--version"])).stdout.trim(),
      installed: true
    };
  }
  if (process.argv.includes("--codex")) {
    const env = { ...process.env, CODEX_HOME: resolve(directory, "codex") };
    await mkdir(env.CODEX_HOME);
    await run("codex", ["plugin", "marketplace", "add", marketplace], { env });
    await run("codex", ["plugin", "add", "agent-device-cloud@adc-plugins"], { env });
    const { stdout } = await run("codex", ["plugin", "list"], { env });
    assert(stdout.includes("agent-device-cloud"));
    report.codex = { version: (await run("codex", ["--version"])).stdout.trim(), installed: true };
  }
  const piLoader = option("pi-loader");
  if (piLoader) {
    const { loadExtensions } = await import(pathToFileURL(piLoader).href);
    const result = await loadExtensions([resolve(marketplace, "packages/pi/index.mjs")], directory);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    const extension = result.extensions[0];
    assert.equal(extension.tools.size, 6);
    assert(extension.commands.has("adc"));
    await assert.rejects(
      extension.tools
        .get("adc_invoke")
        .definition.execute("call", {}, new AbortController().signal, () => {}, { hasUI: false }),
      /interactive/
    );
    for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, {});
    report.pi = {
      loaded: true,
      tools: extension.tools.size,
      commands: [...extension.commands.keys()],
      headlessMutationBlocked: true
    };
  }
  const sdkRoot = option("sdk-root");
  if (sdkRoot) {
    // A normal installed package resolves the host SDK next to its bundled entry.
    await symlink(sdkRoot, resolve(marketplace, "node_modules"), "dir");
    const clineSdk = await import(pathToFileURL(resolve(sdkRoot, "@cline/sdk/dist/index.js")).href);
    const loaded = await clineSdk.loadAgentPluginsFromPathsWithDiagnostics(
      [resolve(marketplace, "packages/cline/index.mjs")],
      { cwd: directory, useCache: false }
    );
    assert.deepEqual(loaded.failures, []);
    assert.equal(loaded.plugins.length, 1);
    const cline = await import(
      pathToFileURL(resolve(marketplace, "packages/cline/index.mjs")).href
    );
    const tools: any[] = [],
      commands: any[] = [],
      rules: any[] = [],
      disposals: any[] = [];
    await cline.default.setup(
      {
        registerTool: (tool: any) => tools.push(tool),
        registerCommand: (command: any) => commands.push(command),
        registerRule: (rule: any) => rules.push(rule)
      },
      { onDispose: (dispose: any) => disposals.push(dispose) }
    );
    assert.equal(tools.length, 6);
    assert.equal(commands[0].name, "adc");
    assert.equal(rules.length, 1);
    const onboarding = await commands[0].handler("setup");
    assert(onboarding.submitPrompt.includes("--cli-only"));
    assert(onboarding.submitPrompt.includes("adc login --url"));
    for (const dispose of disposals) dispose();
    report.cline = {
      sdk: "0.0.93",
      loaded: true,
      hostLoader: true,
      embeddedSetup: true,
      tools: tools.length,
      commands: 1,
      rules: 1
    };
    const opencode = await import(
      pathToFileURL(resolve(marketplace, "packages/opencode/index.mjs")).href
    );
    const hooks = await opencode.default({});
    assert.equal(Object.keys(hooks.tool).length, 6);
    const config: any = {};
    await hooks.config(config);
    assert.equal(Object.keys(config.command).length, 4);
    await hooks.dispose();
    report.opencode = { sdk: "1.19.0", loaded: true, tools: 6, commands: 4 };
  }
  const zionRoot = option("zion-root");
  if (zionRoot) {
    const host = await import(
      pathToFileURL(resolve(zionRoot, "apps/runtime/src/runtime-plugin-service.mjs")).href
    );
    const installerModule = await import(
      pathToFileURL(resolve(zionRoot, "src/plugin/http-installer.ts")).href
    );
    const roots = resolve(directory, "zion-plugins");
    await mkdir(roots);
    await cp(resolve(marketplace, "packages/zion"), resolve(roots, "adc"), { recursive: true });
    const runtime = new host.RuntimePluginService({
      pluginRoots: [roots],
      enabledPluginIds: ["dev.agent-device-cloud"]
    });
    try {
      const snapshot = await runtime.start();
      assert.deepEqual(snapshot.failures, []);
      assert.equal(snapshot.plugins[0].status, "active");
      assert.equal(runtime.supportedToolNames.length, 6);
      const tools = await runtime.listTools({
        policy: { preset: "read-only", allowedTools: runtime.supportedToolNames }
      });
      assert.equal(tools.length, 4);
      assert(!tools.some((tool: any) => tool.name === "adc_invoke" || tool.name === "adc_cancel"));
      const status = await runtime.invokeCommand(
        "dev.agent-device-cloud",
        { action: "status" },
        {
          principal: { kind: "account", user: { id: "test-user" }, space: { id: "test-space" } }
        }
      );
      assert.equal(status.connected, false);
      const namespace = [...runtime.namespacedState.keys()][0] as string;
      assert(namespace.startsWith("dev.agent-device-cloud:private.user-"));
      const secretKey = `runtime.plugins.dev.agent-device-cloud.${namespace.split(":")[1]}.connection`;
      const { createWorkbenchStateHttpHandler } = await import(
        pathToFileURL(resolve(zionRoot, "apps/runtime/src/workbench-state-http-handler.mjs")).href
      );
      const handle = createWorkbenchStateHttpHandler({
        store: {
          readSnapshot: async () => ({
            snapshot: { kv: { [secretKey]: { accessToken: "test-secret" }, public: "visible" } }
          }),
          updateSession() {}
        }
      });
      let body = "",
        code = 0;
      const response = {
        writeHead: (status: number) => {
          code = status;
        },
        end: (value: string) => {
          body = value;
        }
      };
      await handle(
        { method: "GET", headers: {} },
        response,
        new URL("http://runtime/v1/workbench-state/snapshot")
      );
      assert.equal(code, 200);
      assert(!body.includes("test-secret"));
      assert(body.includes("visible"));
      await handle(
        { method: "GET", headers: {} },
        response,
        new URL(`http://runtime/v1/workbench-state/kv/${secretKey}`)
      );
      assert.equal(code, 404);
      const installer = new installerModule.HttpPluginInstaller({
        baseUrl: "https://adc.zioon.tech/downloads/plugins"
      });
      const bytes = await readFile("dist/plugins/agent-device-cloud-zion.zip");
      const installed = await installer.installFromFile({
        name: "agent-device-cloud-zion.zip",
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      });
      assert.equal(installed.success, true, JSON.stringify(installed.error));
      assert.equal(installed.plugin.id, "dev.agent-device-cloud");
      assert.equal(Object.keys(installed.plugin.skillContents).length, 3);
      assert(installed.plugin.scriptContents["runtime.mjs"]);
      assert(installed.plugin.styleContents["styles.css"]);
      installer.clearCache();
      report.zion = {
        runtimeLoaded: true,
        zipInstalled: true,
        tools: 6,
        readOnlyTools: 4,
        skills: 3,
        privateStateRedacted: true
      };
    } finally {
      await runtime.stop();
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
