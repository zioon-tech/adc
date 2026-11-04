import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import { AdcClient, buildInvocation, type InvocationContext } from "@adc/client";
import {
  ControlPlaneTools,
  ToolArgsSchemas,
  ToolNameSchema,
  WaitMsSchema,
  ExecutionTimeoutMsSchema,
  isBuiltinTool,
  isSideEffectTool,
  toolArgsJsonSchema,
  type InvocationResult,
  type ToolCapability,
  type ToolId,
  type ToolName
} from "@adc/protocol";

export interface McpAdapterOptions {
  client: Pick<AdcClient, "invoke">;
  context: InvocationContext;
  loadContext?: () => Promise<InvocationContext>;
  defaultTarget?: { nodeId: string } | { projectId: string; affinity?: string };
  allowedTools?: ToolId[];
  quickWaitMs?: number;
  contextRefreshIntervalMs?: number;
}

interface AdapterInput {
  args: unknown;
  target?: { nodeId: string } | { projectId: string; affinity?: string };
  idempotencyKey?: string;
  waitMs?: number;
  executionTimeoutMs?: number;
  intent?: string;
  controlSessionId?: string;
}

function nodeIdsForTool(context: InvocationContext, tool: ToolId): string[] | undefined {
  const advertised = context.toolNodeIds?.[tool];
  if (advertised === undefined) return undefined;
  const granted = new Set(context.nodeIds ?? []);
  return [...new Set(advertised.filter((nodeId) => granted.has(nodeId)))].sort();
}

function shellExecutor(platform: string): string {
  return platform === "win32"
    ? "Windows PowerShell"
    : platform === "darwin" || platform === "linux"
      ? "Bash"
      : "native platform runtime";
}

function targetDescription(context: InvocationContext, tool: ToolId, nodeIds: string[]): string {
  const nodes = new Map((context.nodes ?? []).map((node) => [node.nodeId, node]));
  const targets = nodeIds.map((nodeId) => {
    const node = nodes.get(nodeId);
    if (!node) return nodeId;
    const isolated = node.access?.execution === "isolated";
    const executor =
      tool === "shell.exec"
        ? `; shell: ${isolated ? "Bash in a temporary Linux container" : shellExecutor(node.platform)}`
        : "";
    const access = node.access
      ? `; ${node.access.kind}; access: ${node.access.execution}${isolated ? "; no network; changes discarded; artifact output retained" : ""}`
      : "";
    return `${nodeId} (${node.label}; platform: ${node.platform}${executor}${access})`;
  });
  return `Choose a device that advertises ${tool}. Available targets: ${targets.join(", ")}.`;
}

function targetJsonSchema(
  context: InvocationContext,
  tool: ToolId
): Record<string, unknown> | undefined {
  if (isBuiltinTool(tool) && ControlPlaneTools.has(tool)) {
    return {
      oneOf: [
        {
          type: "object",
          properties: { nodeId: { type: "string" } },
          required: ["nodeId"],
          additionalProperties: false
        },
        {
          type: "object",
          properties: {
            projectId: { type: "string" },
            affinity: { type: "string" }
          },
          required: ["projectId"],
          additionalProperties: false
        }
      ]
    };
  }
  const nodeIds = nodeIdsForTool(context, tool);
  if (nodeIds === undefined) {
    return {
      oneOf: [
        {
          type: "object",
          properties: { nodeId: { type: "string" } },
          required: ["nodeId"],
          additionalProperties: false
        },
        {
          type: "object",
          properties: {
            projectId: { type: "string" },
            affinity: { type: "string" }
          },
          required: ["projectId"],
          additionalProperties: false
        }
      ]
    };
  }
  if (nodeIds.length === 0) return undefined;
  return {
    type: "object",
    properties: {
      nodeId: {
        type: "string",
        enum: nodeIds,
        description: targetDescription(context, tool, nodeIds)
      }
    },
    required: ["nodeId"],
    additionalProperties: false
  };
}

function inputJsonSchema(
  argsSchema: Record<string, unknown>,
  targetSchema: Record<string, unknown>,
  sideEffect: boolean,
  targetRequired: boolean
): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      args: argsSchema,
      target: targetSchema,
      idempotencyKey: { type: "string", minLength: 8, maxLength: 256 },
      intent: {
        type: "string",
        minLength: 1,
        maxLength: 160,
        description:
          "Short current purpose shown on the device and retained with the receipt. Declared intent does not grant permission; omit sensitive details."
      },
      controlSessionId: {
        type: "string",
        pattern: "^ctl_[a-f0-9]{32}$",
        description:
          "For Android screen mutations, use the active token returned by screen.control begin. Reads do not need screen control."
      },
      waitMs: {
        type: "integer",
        minimum: 0,
        maximum: 30_000,
        default: 4000,
        description:
          "Wait for completion within this call. Zero returns immediately; expiry returns the current task without cancelling it."
      },
      executionTimeoutMs: {
        type: "integer",
        minimum: 100,
        maximum: 1_800_000,
        description:
          "Optional total execution budget from submission, including queue time. Expiry requests cooperative cancellation."
      }
    },
    required: [
      "args",
      ...(targetRequired ? ["target"] : []),
      ...(sideEffect ? ["idempotencyKey"] : [])
    ],
    additionalProperties: false
  };
}

function toolDefinition(
  context: InvocationContext,
  tool: ToolId,
  capability?: ToolCapability
): Tool | undefined {
  const targetSchema = targetJsonSchema(context, tool);
  if (!targetSchema) return;
  const builtin = isBuiltinTool(tool);
  const argsSchema = builtin ? toolArgsJsonSchema(tool) : capability?.inputSchema;
  if (!argsSchema) return;
  const sideEffect = isSideEffectTool(tool);
  const targetRequired = !(builtin && ControlPlaneTools.has(tool));
  return {
    name: tool,
    ...(capability?.title ? { title: capability.title } : {}),
    description: builtin ? descriptionFor(tool, context) : capability?.description,
    inputSchema: inputJsonSchema(argsSchema, targetSchema, sideEffect, targetRequired),
    annotations: {
      readOnlyHint: !sideEffect,
      destructiveHint: sideEffect,
      idempotentHint: sideEffect,
      openWorldHint: !builtin
    }
  };
}

export function projectToolDefinitions(
  options: Pick<McpAdapterOptions, "context" | "allowedTools">
): Tool[] {
  const allowed = options.context.allowedTools ?? options.allowedTools ?? ToolNameSchema.options;
  return allowed.flatMap((tool) => {
    const definition = toolDefinition(
      options.context,
      tool,
      options.context.toolDefinitions?.[tool]
    );
    if (!definition) return [];
    if (!isBuiltinTool(tool)) {
      const schema = options.context.toolDefinitions?.[tool]?.inputSchema;
      if (!schema) return [];
      try {
        new AjvJsonSchemaValidator().getValidator(schema as JsonSchemaType);
      } catch {
        return [];
      }
    }
    return [definition];
  });
}

export class McpInvocationAdapter {
  constructor(private readonly options: McpAdapterOptions) {}

  async loadContext(): Promise<InvocationContext> {
    return this.options.loadContext ? await this.options.loadContext() : this.options.context;
  }

  async invoke(
    tool: ToolId,
    input: AdapterInput,
    currentContext?: InvocationContext,
    signal?: AbortSignal
  ): Promise<InvocationResult> {
    const context = currentContext ?? (await this.loadContext());
    if (context.allowedTools && !context.allowedTools.includes(tool)) {
      throw new Error(`Agent grant no longer allows ${tool}`);
    }
    const target = input.target ?? this.options.defaultTarget;
    const nodeIds = nodeIdsForTool(context, tool);
    if (!(isBuiltinTool(tool) && ControlPlaneTools.has(tool)) && nodeIds !== undefined) {
      if (!target || !("nodeId" in target)) {
        throw new Error(`target.nodeId is required for ${tool}`);
      }
      if (!nodeIds.includes(target.nodeId)) {
        throw new Error(`Device ${target.nodeId} does not advertise ${tool}`);
      }
    }
    const invocation = buildInvocation({
      context,
      tool,
      args: input.args,
      ...(target ? { target } : {}),
      source: "mcp",
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      ...(input.controlSessionId !== undefined ? { controlSessionId: input.controlSessionId } : {}),
      ...(input.executionTimeoutMs !== undefined
        ? { executionTimeoutMs: ExecutionTimeoutMsSchema.parse(input.executionTimeoutMs) }
        : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
    });
    return this.options.client.invoke(invocation, {
      waitMs: WaitMsSchema.parse(input.waitMs ?? this.options.quickWaitMs ?? 4000),
      ...(signal ? { signal } : {})
    });
  }
}

type ArgsValidation =
  | { valid: true; data: unknown; errorMessage: undefined }
  | { valid: false; data: undefined; errorMessage: string };
type ArgsValidator = (input: unknown) => ArgsValidation;

function toolSnapshot(options: McpAdapterOptions, context: InvocationContext) {
  const allowed = context.allowedTools ?? options.allowedTools ?? ToolNameSchema.options;
  const argsValidators = new Map<ToolId, ArgsValidator>();
  for (const tool of allowed) {
    if (isBuiltinTool(tool)) {
      argsValidators.set(tool, (input) => {
        const parsed = ToolArgsSchemas[tool].safeParse(input);
        return parsed.success
          ? { valid: true, data: parsed.data, errorMessage: undefined }
          : { valid: false, data: undefined, errorMessage: parsed.error.message };
      });
      continue;
    }
    const schema = context.toolDefinitions?.[tool]?.inputSchema;
    if (!schema) continue;
    try {
      argsValidators.set(tool, new AjvJsonSchemaValidator().getValidator(schema as JsonSchemaType));
    } catch {
      // An invalid Provider schema hides only that tool.
    }
  }
  const tools = projectToolDefinitions({ context, allowedTools: allowed }).filter((tool) =>
    argsValidators.has(tool.name)
  );
  return {
    context,
    tools,
    toolsById: new Map(tools.map((tool) => [tool.name as ToolId, tool])),
    argsValidators,
    fingerprint: JSON.stringify(tools)
  };
}

function normalizeToolArgs(input: unknown): unknown {
  if (typeof input !== "string") return input;
  if (Buffer.byteLength(input) > 64 * 1024) return input;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : input;
  } catch {
    return input;
  }
}

export function createMcpServer(options: McpAdapterOptions): Server {
  const server = new Server(
    { name: "agent-device-cloud", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } }
  );
  const adapter = new McpInvocationAdapter(options);
  let current = toolSnapshot(options, options.context);
  const refresh = async (notify: boolean) => {
    const next = toolSnapshot(options, await adapter.loadContext());
    const changed = next.fingerprint !== current.fingerprint;
    current = next;
    if (notify && changed) await server.sendToolListChanged().catch(() => {});
    return current;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await refresh(false)).tools
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const snapshot = await refresh(true);
    const tool = request.params.name as ToolId;
    if (!snapshot.toolsById.has(tool)) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool is not available: ${tool}`);
    }
    const input = (request.params.arguments ?? {}) as Partial<AdapterInput>;
    const validation = snapshot.argsValidators.get(tool)?.(normalizeToolArgs(input.args));
    if (!validation?.valid) {
      throw new McpError(
        ErrorCode.InvalidParams,
        validation?.errorMessage ?? `Invalid arguments for ${tool}`
      );
    }
    try {
      if (
        Object.keys(input).some(
          (key) =>
            ![
              "args",
              "target",
              "idempotencyKey",
              "waitMs",
              "executionTimeoutMs",
              "intent",
              "controlSessionId"
            ].includes(key)
        )
      )
        throw new Error("Unknown tool call field.");
      const result = await adapter.invoke(
        tool,
        {
          args: validation.data,
          ...(input.intent !== undefined ? { intent: input.intent } : {}),
          ...(input.controlSessionId !== undefined
            ? { controlSessionId: input.controlSessionId }
            : {}),
          ...(input.target ? { target: input.target } : {}),
          ...(input.waitMs !== undefined ? { waitMs: input.waitMs } : {}),
          ...(input.executionTimeoutMs !== undefined
            ? { executionTimeoutMs: input.executionTimeoutMs }
            : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
        },
        snapshot.context,
        extra.signal
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
        isError: !["queued", "running", "succeeded"].includes(result.status)
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InvalidParams,
        error instanceof Error ? error.message : String(error)
      );
    }
  });
  const refreshIntervalMs = options.contextRefreshIntervalMs ?? 5_000;
  let proactiveRefresh: Promise<unknown> | undefined;
  const refreshTimer =
    options.loadContext && refreshIntervalMs > 0
      ? setInterval(() => {
          if (proactiveRefresh) return;
          proactiveRefresh = refresh(true)
            .catch(() => {})
            .finally(() => {
              proactiveRefresh = undefined;
            });
        }, refreshIntervalMs)
      : undefined;
  refreshTimer?.unref();
  server.onclose = () => {
    if (refreshTimer) clearInterval(refreshTimer);
  };
  return server;
}

function descriptionFor(tool: ToolName, context?: InvocationContext): string {
  const descriptions: Record<ToolName, string> = {
    "device.list": "List devices visible to the current agent grant.",
    "device.status": "Get the current state of one visible device.",
    "device.battery.get": "Read battery and charging state from a mobile device.",
    "device.info.get": "Read Android hardware, OS and ADC app details from a mobile device.",
    "device.network.get": "Read the active network type and metering state from a mobile device.",
    "device.storage.get": "Read internal storage capacity and free space from a mobile device.",
    "device.vibrate": "Vibrate an Android device for a bounded duration and amplitude.",
    "device.navigation": "Perform an Android system navigation action through Accessibility. Requires an active screen.control token in controlSessionId.",
    "app.open": "Open an installed Android app by package name and wait for it to become visible. Requires an active screen.control token in controlSessionId.",
    "display.status": "Read Android display dimensions, density, refresh rate and power state.",
    "audio.status": "Read Android audio mode, ringer state and stream volumes.",
    "audio.volume.set": "Set one Android audio stream to a percentage of its supported range.",
    "flashlight.status": "Read available Android camera flash units and their current state.",
    "flashlight.set": "Turn an Android camera flash unit on or off.",
    "location.get":
      "Read a fresh or recently cached location from a mobile device within its local permission.",
    "notification.show": "Show a notification on a mobile device.",
    "screen.capture": "Capture the current Android display after local screen-share consent.",
    "screen.control":
      "Explicitly begin, renew, end or inspect Android screen control. Begin before app.open, navigation, typing, taps or swipes; pass its token as controlSessionId on each mutation and end in finally. Default lease 120 seconds; renew explicitly up to 180 seconds. A user takeover blocks new control until the user resumes locally. Location, screenshots and UI reads do not acquire control. Existing grants must explicitly allow this tool.",
    "ui.inspect": "Read a bounded semantic snapshot of the active Android UI.",
    "ui.wait": "Wait for an Android UI element, foreground app or accessibility idle state.",
    "ui.action":
      "Perform a semantic action on an Android UI element. Requires an active screen.control token in controlSessionId.",
    "ui.gesture":
      "Perform a tap or swipe gesture on an Android device. Requires an active screen.control token in controlSessionId.",
    "file.list": "List files below an authorized root on target.nodeId.",
    "file.read": "Read a UTF-8 file below an authorized root on target.nodeId.",
    "file.search": "Search text below an authorized root on target.nodeId.",
    "file.write": "Atomically write a file below an authorized root on target.nodeId.",
    "file.edit": "Apply an exact text replacement below an authorized root on target.nodeId.",
    "file.patch": "Apply a unified diff below an authorized root on target.nodeId.",
    "file.transfer":
      "Transfer a regular file between authorized devices, or create an Agent upload to one device. Agent bytes use adc transfer upload or SDK uploadTransferChunk; never put file bytes in tool arguments.",
    "shell.exec":
      "Run a command below an authorized root on target.nodeId; Windows uses PowerShell and macOS/Linux use Bash.",
    "command.template.list": "List locally configured commands for the authorized folders.",
    "command.template.run": "Run a locally configured command below an authorized root.",
    "test.run": "Run a locally configured test command below an authorized root.",
    "task.status": "Get the state of an asynchronous invocation.",
    "task.result": "Read the terminal result of an invocation.",
    "task.wait": "Wait for an existing task without submitting or restarting it.",
    "task.cancel": "Request cancellation of an asynchronous invocation."
  };
  if (tool !== "shell.exec" || !context) return descriptions[tool];
  const targetIds = new Set(nodeIdsForTool(context, tool) ?? []);
  const executors = (context.nodes ?? [])
    .filter((node) => targetIds.has(node.nodeId))
    .map((node) =>
      node.access?.execution === "isolated"
        ? `${node.label} (temporary Linux container: Bash; no network; changes discarded, artifacts retained)`
        : `${node.label} (${node.platform}: ${shellExecutor(node.platform)})`
    );
  return executors.length
    ? `${descriptions[tool]} Target executors: ${executors.join(", ")}. Use syntax for the selected target's shell.`
    : descriptions[tool];
}
