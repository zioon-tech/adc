#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AdcClient, AdcClientError, buildInvocation } from "@adc/client";
import { createMcpServer, projectToolDefinitions } from "@adc/mcp-adapter";
import { ToolIdSchema, isSideEffectTool, type InvocationResult, type ToolId } from "@adc/protocol";
import {
  authStatus,
  importToken,
  loadAgent,
  loadSession,
  readSecret,
  serverURL,
  signIn,
  signInWithBrowser,
  signOut
} from "./auth.ts";
import { isManagementCommand, managementUsage, runManagementCommand } from "./management.ts";
import { uploadFile } from "./transfer-upload.ts";
import {
  UPDATE_NOTICE_COMMAND,
  cachedUpdateNotice,
  launchUpdateNoticeRefresh,
  refreshUpdateNotice,
  updateClient
} from "./update.ts";

const usage = `Agent Device Cloud
Usage:
  adc login --url URL [--email EMAIL] [--no-open]
  adc logout | status
  adc update [--check] [--force] [--download-url URL] [--no-service]
  adc device add|list|show|update|wait|revoke|remove
  adc access create|list|show|update|revoke|remove
  adc connect ACCESS
  adc connection list|revoke
  adc approval list|approve|deny
  adc project list|create|roots|root-add
  adc tool list|show [TOOL]
  adc invoke TOOL --args JSON [--node DEVICE] [--wait [MILLISECONDS]]
             [--idempotency-key KEY] [--execution-timeout MILLISECONDS]
  adc invocation status INVOCATION
  adc task status|result|wait|cancel JOB [--wait MILLISECONDS]
  adc transfer create --source-node NODE --source-root ROOT --source-path PATH
                      --destination-node NODE --destination-root ROOT --destination-path PATH
                      --idempotency-key KEY [--chunk-size BYTES] [--wait MILLISECONDS]
  adc transfer status|wait|cancel TRANSFER [--wait MILLISECONDS]
  adc transfer upload --file PATH --destination-node NODE --destination-root ROOT
                      --destination-path PATH --idempotency-key KEY
  adc artifact get ID
  adc audit show|list
  adc mcp

${managementUsage}

Advanced compatibility:
  adc auth login|token|status|logout
  adc node list|pairing-code
Device-local setup and settings:
  adc-node --help`;

function parseArgs(args: string[]): { positionals: string[]; flags: Map<string, string | true> } {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const item = args[index]!;
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }
    const name = item.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      index++;
    }
  }
  return { positionals, flags };
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function requiredFlag(flags: Map<string, string | true>, name: string): string {
  const value = stringFlag(flags, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function jsonArgument(value: string): Promise<unknown> {
  const content = value.startsWith("@") ? await readFile(resolve(value.slice(1)), "utf8") : value;
  return JSON.parse(content);
}

function exitCode(result: InvocationResult): number {
  if (["queued", "running", "succeeded"].includes(result.status)) return 0;
  if (result.status === "denied") return 20;
  if (result.status === "approval_required") return 21;
  if (result.status === "offline") return 22;
  if (result.status === "unknown_outcome") return 23;
  if (result.status === "cancelled") return 24;
  return 1;
}

function print(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (value && typeof value === "object" && "status" in value) {
    const result = value as InvocationResult;
    console.log(`${result.status}${result.jobId ? ` ${result.jobId}` : ""}`);
    if (result.output !== undefined) console.log(JSON.stringify(result.output, null, 2));
    if (result.error) console.error(`${result.error.code}: ${result.error.message}`);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  let [domain, action] = positionals;
  if (domain === UPDATE_NOTICE_COMMAND) {
    await refreshUpdateNotice();
    return;
  }
  if (domain === "login" || domain === "logout" || domain === "status") {
    action = domain;
    domain = "auth";
  }
  const json = flags.has("json");
  if (
    process.stderr.isTTY &&
    !json &&
    domain !== "mcp" &&
    domain !== "update" &&
    !process.env.CI &&
    process.env.ADC_NO_UPDATE_NOTIFIER !== "1"
  ) {
    const notice = await cachedUpdateNotice();
    if (notice.update) {
      process.stderr.write(
        `ADC ${notice.update.version} is available. Run "adc update" to install it.\n`
      );
    }
    if (notice.stale) launchUpdateNoticeRefresh();
  }

  if (flags.has("version") || domain === "version") {
    console.log(process.env.ADC_BUILD_VERSION ?? "0.1.0-dev");
    return;
  }
  if (!domain || flags.has("help") || domain === "help") {
    console.log(usage);
    return;
  }

  if (domain === "auth" && action === "login") {
    const url = serverURL(requiredFlag(flags, "url"));
    const email = stringFlag(flags, "email");
    if (email) {
      const password = await readSecret("Password", flags.has("password-stdin"));
      print(await signIn(url, email, password), json);
    } else {
      if (flags.has("password-stdin")) throw new Error("--password-stdin requires --email.");
      print(await signInWithBrowser(url, flags.has("no-open")), json);
    }
    return;
  }
  if (domain === "auth" && action === "token") {
    const url = serverURL(requiredFlag(flags, "url"));
    const token = await readSecret("Agent access key", flags.has("stdin"));
    print(await importToken(url, token), json);
    return;
  }
  if (domain === "auth" && action === "status") {
    print(await authStatus(), json);
    return;
  }
  if (domain === "auth" && action === "logout") {
    print(await signOut(), json);
    return;
  }
  if (domain === "update") {
    const downloadUrl = stringFlag(flags, "download-url");
    print(
      await updateClient({
        check: flags.has("check"),
        force: flags.has("force"),
        noService: flags.has("no-service"),
        ...(downloadUrl ? { downloadUrl } : {})
      }),
      json
    );
    return;
  }

  const management = isManagementCommand(domain, action, flags);
  if (flags.has("session") && !management)
    throw new Error("This command does not accept the account login. Use an Agent connection.");
  const config = management ? await loadSession() : await loadAgent();
  const credential = management
    ? "cookie" in config
      ? { cookie: config.cookie }
      : { sessionToken: config.token }
    : "token" in config
      ? config.token
      : { cookie: config.cookie };
  let client = new AdcClient(config.url, credential);
  const account = stringFlag(flags, "account");
  if (management && account) {
    const accounts = await client.accounts();
    const matches = accounts.teams.filter(team => team.accountId === account || team.name === account);
    if (account === accounts.personalAccountId || account === "personal") client = client.withAccount(accounts.personalAccountId);
    else if (matches.length === 1) client = client.withAccount(matches[0]!.accountId);
    else throw new Error("--account must select your personal account or an exact team ID/unambiguous name.");
  }

  if (management) {
    const result = await runManagementCommand({
      domain,
      action,
      positionals,
      flags,
      client,
      url: config.url
    });
    if (result.handled) {
      print(result.value, json);
      return;
    }
  }

  if (domain === "node" && action === "list") {
    if (management) {
      print({ schemaVersion: "0.1", nodes: await client.listNodes() }, json);
      return;
    }
    const me = await client.me();
    if (me.kind !== "agent") throw new Error("An Agent connection is required.");
    const result = await client.invoke(
      buildInvocation({
        context: me.context,
        tool: "device.list",
        args: {},
        source: "cli"
      })
    );
    print(
      result.status === "succeeded"
        ? { schemaVersion: "0.1", nodes: (result.output as { nodes: unknown[] }).nodes }
        : result,
      json
    );
    process.exitCode = exitCode(result);
    return;
  }
  if (domain === "node" && action === "pairing-code") {
    print(await client.createPairingCode(Number(stringFlag(flags, "ttl") ?? 600)), json);
    return;
  }
  if (domain === "transfer" && action === "upload") {
    const result = await uploadFile(client, {
      path: requiredFlag(flags, "file"),
      destination: {
        nodeId: requiredFlag(flags, "destination-node"),
        rootId: requiredFlag(flags, "destination-root"),
        path: requiredFlag(flags, "destination-path")
      },
      idempotencyKey: requiredFlag(flags, "idempotency-key"),
      ...(stringFlag(flags, "chunk-size")
        ? { chunkSizeBytes: Number(stringFlag(flags, "chunk-size")) }
        : {}),
      ...(stringFlag(flags, "execution-timeout")
        ? { executionTimeoutMs: Number(stringFlag(flags, "execution-timeout")) }
        : {})
    });
    const waitMs = Number(stringFlag(flags, "wait") ?? 0);
    const final =
      result.jobId && waitMs && ["queued", "running"].includes(result.status)
        ? await client.taskWait(result.jobId, waitMs)
        : result;
    print(final, json);
    process.exitCode = exitCode(final);
    return;
  }
  if (domain === "transfer" && action === "create") {
    const me = await client.me();
    if (me.kind !== "agent") throw new Error("An Agent connection is required.");
    const sourceNode = requiredFlag(flags, "source-node");
    const destinationNode = requiredFlag(flags, "destination-node");
    const sourceRoot = requiredFlag(flags, "source-root");
    const destinationRoot = requiredFlag(flags, "destination-root");
    for (const nodeId of [sourceNode, destinationNode]) {
      if (!me.context.nodeIds?.includes(nodeId)) {
        throw new Error(`Device is outside this connection's authorization: ${nodeId}`);
      }
    }
    for (const rootId of [sourceRoot, destinationRoot]) {
      if (me.context.rootAccess !== "all" && !me.context.rootIds.includes(rootId)) {
        throw new Error(`Folder is outside this connection's authorization: ${rootId}`);
      }
    }
    const invocation = buildInvocation({
      context: me.context,
      tool: "file.transfer",
      args: {
        source: {
          nodeId: sourceNode,
          rootId: sourceRoot,
          path: requiredFlag(flags, "source-path")
        },
        destination: {
          nodeId: destinationNode,
          rootId: destinationRoot,
          path: requiredFlag(flags, "destination-path")
        },
        overwrite: "never",
        ...(stringFlag(flags, "chunk-size")
          ? { chunkSizeBytes: Number(stringFlag(flags, "chunk-size")) }
          : {})
      },
      source: "cli",
      idempotencyKey: requiredFlag(flags, "idempotency-key"),
      ...(stringFlag(flags, "execution-timeout")
        ? { executionTimeoutMs: Number(stringFlag(flags, "execution-timeout")) }
        : {})
    });
    const waitMs = Number(stringFlag(flags, "wait") ?? 0);
    const result = await client.invoke(invocation, { waitMs });
    print(result, json);
    process.exitCode = exitCode(result);
    return;
  }
  if (domain === "transfer" && ["status", "wait", "cancel"].includes(action ?? "")) {
    const transferId = positionals[2];
    if (!transferId) throw new Error("transfer id is required");
    const jobId = transferId.startsWith("job_") ? transferId : `job_${transferId}`;
    const result =
      action === "cancel"
        ? await client.cancelTask(jobId)
        : action === "wait"
          ? await client.taskWait(jobId, Number(stringFlag(flags, "wait") ?? 4000))
          : await client.taskStatus(jobId);
    print(result, json);
    process.exitCode = exitCode(result);
    return;
  }
  if (domain === "tool" && (action === "list" || action === "show")) {
    const me = await client.me();
    if (me.kind !== "agent") throw new Error("Tool discovery requires an Agent connection.");
    const tools = projectToolDefinitions({
      context: me.context,
      allowedTools: me.grant.allowedTools
    });
    if (action === "show") {
      const selector = positionals[2];
      if (!selector) throw new Error("tool name is required");
      const tool = tools.find((candidate) => candidate.name === selector);
      if (!tool) throw new Error(`Tool is not available: ${selector}`);
      const targetIds = new Set(me.context.toolNodeIds?.[selector as ToolId] ?? []);
      const targets = (me.context.nodes ?? [])
        .filter((node) => targetIds.has(node.nodeId))
        .map((node) => ({
          nodeId: node.nodeId,
          label: node.label,
          platform: node.platform,
          ...(selector === "shell.exec"
            ? {
                executor: {
                  kind: "shell",
                  dialect: node.platform === "win32" ? "powershell" : "bash"
                }
              }
            : {})
        }));
      print({ schemaVersion: "0.1", tool, targets }, json);
      return;
    }
    print({ schemaVersion: "0.1", tools }, json);
    return;
  }
  if (domain === "invoke") {
    if (!action) throw new Error("tool name is required");
    const tool = ToolIdSchema.parse(action);
    const me = await client.me();
    if (me.kind !== "agent") throw new Error("Invocations require an Agent connection.");
    const projectId = stringFlag(flags, "project") ?? me.context.projectId;
    if (projectId !== me.context.projectId)
      throw new Error("The project must match this token's authorization.");
    const rootIds = (stringFlag(flags, "roots")?.split(",") ?? me.context.rootIds).filter(Boolean);
    if (me.context.rootAccess !== "all" && rootIds.some((id) => !me.context.rootIds.includes(id)))
      throw new Error("Requested folders are outside this token's authorization.");
    if (flags.has("actor") || flags.has("grant") || flags.has("account"))
      throw new Error("Account and agent identity are derived from the credential.");
    const nodeId = stringFlag(flags, "node");
    const idempotencyKey = stringFlag(flags, "idempotency-key");
    if (isSideEffectTool(tool) && !idempotencyKey) {
      throw new Error("--idempotency-key is required for side-effecting tools");
    }
    const toolArgs = await jsonArgument(requiredFlag(flags, "args"));
    const invocation = buildInvocation({
      context: {
        ...me.context,
        rootIds,
        ...(flags.has("roots") ? { rootAccess: "selected" as const } : {}),
        ...(projectId ? { projectId } : {})
      },
      tool,
      args: toolArgs,
      ...(nodeId
        ? { target: { nodeId } }
        : projectId && stringFlag(flags, "affinity")
          ? {
              target: {
                projectId: projectId!,
                affinity: stringFlag(flags, "affinity")!
              }
            }
          : {}),
      source: stringFlag(flags, "source") === "skill" ? "skill" : "cli",
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(stringFlag(flags, "execution-timeout")
        ? { executionTimeoutMs: Number(stringFlag(flags, "execution-timeout")) }
        : {}),
      ...(stringFlag(flags, "timeout") ? { timeoutMs: Number(stringFlag(flags, "timeout")) } : {})
    });
    const wait = flags.get("wait");
    const waitMs = wait === true ? 4000 : typeof wait === "string" ? Number(wait) : 0;
    if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 30_000)
      throw new Error("--wait must be between 0 and 30000 milliseconds");
    const result = await client.invoke(invocation, { waitMs });
    print(result, json);
    process.exitCode = exitCode(result);
    return;
  }
  if (domain === "invocation" && action === "status") {
    const invocationId = positionals[2];
    if (!invocationId) throw new Error("invocation id is required");
    const result = await client.invocationStatus(invocationId);
    print(result, json);
    process.exitCode = exitCode(result);
    return;
  }
  if (domain === "task" && ["status", "result", "wait", "cancel"].includes(action ?? "")) {
    const jobId = positionals[2];
    if (!jobId) throw new Error("job id is required");
    const result =
      action === "cancel"
        ? await client.cancelTask(jobId)
        : action === "wait"
          ? await client.taskWait(jobId, Number(stringFlag(flags, "wait") ?? 4000))
          : await client.taskStatus(jobId);
    print(result, json);
    process.exitCode = exitCode(result);
    return;
  }
  if (domain === "artifact" && action === "get") {
    const artifactId = positionals[2];
    if (!artifactId) throw new Error("artifact id is required");
    const data = await client.artifact(artifactId);
    const output = stringFlag(flags, "output");
    if (output) {
      await writeFile(resolve(output), data, { flag: "w", mode: 0o600 });
      print({ schemaVersion: "0.1", artifactId, bytes: data.byteLength, output }, json);
    } else if (json) {
      print(
        {
          schemaVersion: "0.1",
          artifactId,
          bytes: data.byteLength,
          dataBase64: Buffer.from(data).toString("base64")
        },
        true
      );
    } else {
      process.stdout.write(data);
    }
    return;
  }
  if (domain === "audit" && (action === "show" || action === "list")) {
    print(
      {
        schemaVersion: "0.1",
        events: await client.audit(action === "show" ? positionals[2] : undefined)
      },
      json
    );
    return;
  }
  if (domain === "mcp") {
    const me = await client.me();
    if (me.kind !== "agent") throw new Error("MCP requires an Agent connection.");
    const server = createMcpServer({
      client,
      context: me.context,
      loadContext: async () => {
        const current = await client.me();
        if (current.kind !== "agent") throw new Error("Agent authorization is unavailable.");
        return current.context;
      },
      allowedTools: me.grant.allowedTools
    });
    await server.connect(new StdioServerTransport());
    return;
  }

  throw new Error(usage);
}

main().catch((error) => {
  if (error instanceof AdcClientError) {
    process.stderr.write(`${JSON.stringify({ error: error.error })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
