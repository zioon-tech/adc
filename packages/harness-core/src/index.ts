import { spawn } from "node:child_process";
import { AdcClient, type InvocationContext } from "@adc/client";
import { McpInvocationAdapter, projectToolDefinitions } from "@adc/mcp-adapter";
import { ResultSchema, type InvocationResult, type ToolId } from "@adc/protocol";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";

export const ADC_ORIGIN = "https://adc.zioon.tech";
export const PLUGIN_VERSION = "0.1.4";
export const WORKFLOW_GUIDANCE =
  "Discover ADC devices and live tool schemas before use. Select the intended device and its platform. " +
  "Use adc_read for read-only tools and adc_invoke for side effects with a stable idempotencyKey. " +
  "Wait on existing invocation/job identities; never resubmit on timeout or unknown_outcome. " +
  "Human approval is independent: open the ADC review link and inspect the same invocation afterwards.";
export const COLLABORATION_GUIDANCE =
  "Team and shared devices need a separate human-created Agent authorization. " +
  "Use only currently discovered devices and exact folders. Isolated access has no network, " +
  "discards workspace changes and retains bounded artifacts. Do not switch to account credentials after a denial.";

export interface Device {
  nodeId: string;
  label: string;
  platform: string;
  online: boolean;
  roots?: unknown[];
  [key: string]: unknown;
}

export interface Discovery {
  devices: Device[];
  tools: Tool[];
}

function projectDevices(devices: Device[]): Device[] {
  return devices.map((device) => ({
    ...device,
    roots: device.roots ?? (device.capability as { roots?: unknown[] } | undefined)?.roots ?? []
  }));
}

export interface InvokeInput {
  tool: string;
  args: Record<string, unknown>;
  nodeId?: string;
  idempotencyKey?: string;
  waitMs?: number;
}

export interface HarnessTransport {
  origin: string;
  status(signal?: AbortSignal): Promise<Record<string, unknown>>;
  discover(signal?: AbortSignal): Promise<Discovery>;
  invoke(input: InvokeInput, signal?: AbortSignal): Promise<InvocationResult>;
  task(
    input: { invocationId?: string; jobId?: string; cancel?: boolean; waitMs?: number },
    signal?: AbortSignal
  ): Promise<InvocationResult>;
  dispose(): void;
}

export function projectResult(result: InvocationResult, origin = ADC_ORIGIN) {
  const output = result.output === undefined ? undefined : JSON.stringify(result.output);
  return {
    ...result,
    ...(output && output.length > 24_000
      ? { output: { truncated: true, preview: output.slice(0, 24_000) } }
      : {}),
    ...(result.status === "approval_required"
      ? { reviewUrl: `${origin}/approvals`, nextAction: "Ask the user to review this approval." }
      : result.status === "unknown_outcome"
        ? { nextAction: "Reconcile this invocation; do not submit a replacement." }
        : ["queued", "running"].includes(result.status)
          ? { nextAction: "Wait on this existing invocation or job." }
          : {})
  };
}

export function validateInvocation(
  discovery: Discovery,
  input: InvokeInput,
  readOnly: boolean
): InvokeInput {
  const tool = discovery.tools.find((item) => item.name === input.tool);
  if (!tool) throw new Error("This tool is unavailable. Refresh ADC discovery.");
  const sideEffect = tool.annotations?.readOnlyHint !== true;
  if (readOnly && sideEffect) throw new Error("Use adc_invoke for this side effect.");
  if (sideEffect && !input.idempotencyKey)
    throw new Error("A stable idempotencyKey is required for side effects.");
  const targetProperty = tool.inputSchema.properties?.target as any;
  const requiresTarget = tool.inputSchema.required?.includes("target");
  const nodeId =
    input.nodeId ??
    (requiresTarget && discovery.devices.length === 1 ? discovery.devices[0]?.nodeId : undefined);
  if (requiresTarget && !nodeId) throw new Error("Choose an ADC device explicitly.");
  if (nodeId) {
    const device = discovery.devices.find((item) => item.nodeId === nodeId);
    if (!device) throw new Error("The device is outside this connection.");
    if (!device.online)
      throw new Error("The selected device is offline. Reconnect it and refresh.");
  }
  // Validate the complete current MCP schema, including Provider tools and target restrictions.
  const validator = new AjvJsonSchemaValidator().getValidator(tool.inputSchema as JsonSchemaType);
  const validation = validator({
    args: input.args,
    ...(nodeId && targetProperty ? { target: { nodeId } } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    waitMs: input.waitMs ?? 4000
  });
  if (!validation.valid) throw new Error(validation.errorMessage);
  return { ...input, ...(nodeId ? { nodeId } : {}) };
}

export function createSdkTransport(
  origin: string,
  token: string,
  fetcher: typeof fetch = fetch
): HarnessTransport {
  const lifecycle = new AbortController();
  const clientFor = (signal?: AbortSignal) =>
    new AdcClient(origin, token, (url, init) =>
      fetcher(url, {
        ...init,
        signal: AbortSignal.any([
          lifecycle.signal,
          AbortSignal.timeout(45_000),
          ...(signal ? [signal] : [])
        ]),
        redirect: "error"
      })
    );
  async function context(client: AdcClient): Promise<InvocationContext> {
    const me = await client.me();
    if (me.kind !== "agent") throw new Error("A scoped ADC connection is required.");
    return { ...me.context, allowedTools: me.context.allowedTools ?? me.grant.allowedTools };
  }
  return {
    origin,
    async status(signal) {
      const me = await clientFor(signal).me();
      if (me.kind !== "agent") throw new Error("A scoped ADC connection is required.");
      return { connected: true, origin, access: me.grant.name, accountId: me.context.accountId,
        devices: me.context.nodes, collaborationGuidance: COLLABORATION_GUIDANCE };
    },
    async discover(signal) {
      const client = clientFor(signal);
      const current = await context(client);
      const result = await new McpInvocationAdapter({ client, context: current }).invoke(
        "device.list",
        { args: {}, waitMs: 4000 },
        current,
        signal
      );
      if (result.status !== "succeeded") throw new Error("ADC device discovery is unavailable.");
      return {
        devices: projectDevices((result.output as { nodes: Device[] }).nodes),
        tools: projectToolDefinitions({ context: current })
      };
    },
    async invoke(input, signal) {
      const client = clientFor(signal);
      return new McpInvocationAdapter({ client, context: await context(client) }).invoke(
        input.tool as ToolId,
        {
          args: input.args,
          ...(input.nodeId ? { target: { nodeId: input.nodeId } } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          waitMs: input.waitMs ?? 4000
        },
        undefined,
        signal
      );
    },
    async task(input, signal) {
      const client = clientFor(signal);
      if (input.cancel && input.jobId) return client.cancelTask(input.jobId);
      if (input.invocationId)
        return client.invocationStatus(input.invocationId, { waitMs: input.waitMs ?? 4000 });
      if (input.jobId) return client.taskWait(input.jobId, input.waitMs ?? 4000, signal);
      throw new Error("An existing invocationId or jobId is required.");
    },
    dispose() {
      lifecycle.abort();
    }
  };
}

export type CliRunner = (args: string[], signal?: AbortSignal) => Promise<any>;

export function createCliRunner(executable = "adc"): { run: CliRunner; dispose(): void } {
  const lifecycle = new AbortController();
  return {
    run(args, signal) {
      return new Promise((resolve, reject) => {
        const combined = AbortSignal.any([
          lifecycle.signal,
          AbortSignal.timeout(45_000),
          ...(signal ? [signal] : [])
        ]);
        const child = spawn(executable, [...args, "--json"], {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          signal: combined
        });
        let stdout = "",
          stderr = "",
          bytes = 0;
        const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            child.kill("SIGKILL");
            reject(new Error("ADC output exceeded the plugin limit."));
          } else if (stream === "stdout") stdout += chunk.toString();
          else stderr += chunk.toString();
        };
        child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
        child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
        child.once("error", () =>
          reject(
            new Error(
              combined.aborted
                ? "ADC request cancelled or timed out."
                : "Install the ADC CLI first."
            )
          )
        );
        child.once("close", (code) => {
          if (combined.aborted) return reject(new Error("ADC request cancelled or timed out."));
          try {
            const value: any = JSON.parse(stdout || stderr);
            // ADC policy/task statuses deliberately use nonzero process exit codes.
            if (typeof value.status === "string") return resolve(ResultSchema.parse(value));
            if (code !== 0) {
              const errorCode =
                typeof value.error?.code === "string" && /^[a-z_]+$/.test(value.error.code)
                  ? ` (${value.error.code})`
                  : "";
              return reject(new Error(`ADC request failed${errorCode}. Check your connection.`));
            }
            resolve(value);
          } catch {
            reject(new Error("ADC returned invalid structured output."));
          }
        });
      });
    },
    dispose() {
      lifecycle.abort();
    }
  };
}

export function createCliTransport(runner?: CliRunner): HarnessTransport {
  const processRunner = runner ? undefined : createCliRunner();
  const run = runner ?? processRunner!.run;
  let origin = ADC_ORIGIN;
  async function refreshOrigin(signal?: AbortSignal) {
    const status = await run(["status"], signal);
    if (status.connection?.url) origin = new URL(status.connection.url).origin;
    return status;
  }
  return {
    get origin() {
      return origin;
    },
    async status(signal) {
      const status = await refreshOrigin(signal);
      return {
        connected: status.connection?.authenticated === true,
        origin,
        ...(status.connection?.access ? { access: status.connection.access.name } : {}),
        setupUrl: `${origin}/docs/integrations#skill`
      };
    },
    async discover(signal) {
      await refreshOrigin(signal);
      const nodes = await run(["node", "list"], signal);
      const tools = await run(["tool", "list"], signal);
      if (!Array.isArray(nodes.nodes) || !Array.isArray(tools.tools))
        throw new Error("Connect ADC and refresh discovery.");
      return { devices: projectDevices(nodes.nodes), tools: tools.tools };
    },
    async invoke(input, signal) {
      return ResultSchema.parse(
        await run(
          [
            "invoke",
            input.tool,
            "--args",
            JSON.stringify(input.args),
            "--source",
            "skill",
            ...(input.nodeId ? ["--node", input.nodeId] : []),
            ...(input.idempotencyKey ? ["--idempotency-key", input.idempotencyKey] : []),
            "--wait",
            String(input.waitMs ?? 4000)
          ],
          signal
        )
      );
    },
    async task(input, signal) {
      const args =
        input.cancel && input.jobId
          ? ["task", "cancel", input.jobId]
          : input.invocationId
            ? ["invocation", "status", input.invocationId]
            : input.jobId
              ? ["task", "wait", input.jobId, "--wait", String(input.waitMs ?? 4000)]
              : undefined;
      if (!args) throw new Error("An existing invocationId or jobId is required.");
      await refreshOrigin(signal);
      return ResultSchema.parse(await run(args, signal));
    },
    dispose() {
      processRunner?.dispose();
    }
  };
}

const string = { type: "string", minLength: 1 };
const wait = { type: "integer", minimum: 0, maximum: 30_000 };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});

export const nativeTools = [
  {
    name: "adc_status",
    description: "Check ADC connection and get setup links.",
    inputSchema: schema({})
  },
  {
    name: "adc_discover",
    description: "List authorized devices, platforms, folders and live tool schemas.",
    inputSchema: schema({})
  },
  ...["read", "invoke"].map((mode) => ({
    name: `adc_${mode}`,
    description:
      mode === "read"
        ? "Invoke an advertised read-only ADC tool."
        : "Invoke an advertised ADC tool with side effects. Requires host permission and an idempotency key.",
    inputSchema: schema(
      {
        tool: string,
        args: { type: "object", additionalProperties: true },
        nodeId: string,
        idempotencyKey: { ...string, minLength: 8, maxLength: 256 },
        waitMs: wait
      },
      ["tool", "args", ...(mode === "invoke" ? ["idempotencyKey"] : [])]
    )
  })),
  {
    name: "adc_task",
    description: "Inspect or wait on an existing ADC invocation or task.",
    inputSchema: schema({ invocationId: string, jobId: string, waitMs: wait })
  },
  {
    name: "adc_cancel",
    description: "Request cancellation of an existing ADC task.",
    inputSchema: schema({ jobId: string }, ["jobId"])
  }
];

export async function executeNativeTool(
  transport: HarnessTransport,
  name: string,
  input: any,
  signal?: AbortSignal
) {
  signal = AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]);
  const definition = nativeTools.find((tool) => tool.name === name);
  if (!definition) throw new Error("Unknown ADC plugin tool.");
  const validation = new AjvJsonSchemaValidator().getValidator(
    definition.inputSchema as JsonSchemaType
  )(input);
  if (!validation.valid) throw new Error(validation.errorMessage);
  if (name === "adc_status") return transport.status(signal);
  if (name === "adc_discover") return transport.discover(signal);
  const result =
    name === "adc_read" || name === "adc_invoke"
      ? await transport.invoke(
          validateInvocation(
            await transport.discover(signal),
            input as InvokeInput,
            name === "adc_read"
          ),
          signal
        )
      : await transport.task({ ...input, cancel: name === "adc_cancel" }, signal);
  return projectResult(result, transport.origin);
}
