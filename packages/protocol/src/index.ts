import { randomBytes } from "node:crypto";
import { z } from "zod";

export const PROTOCOL_VERSION = "0.1" as const;
export const WaitMsSchema = z.number().int().min(0).max(30_000);
export const ExecutionTimeoutMsSchema = z
  .number()
  .int()
  .min(100)
  .max(30 * 60_000);

export const ErrorCodes = {
  INVALID_REQUEST: "invalid_request",
  UNSUPPORTED_VERSION: "unsupported_version",
  EXPIRED: "expired",
  DENIED: "denied",
  APPROVAL_REQUIRED: "approval_required",
  OFFLINE: "offline",
  AMBIGUOUS_TARGET: "ambiguous_target",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  LEASE_EXPIRED: "lease_expired",
  UNKNOWN_OUTCOME: "unknown_outcome",
  EXECUTION_FAILED: "execution_failed",
  CANCELLED: "cancelled",
  INTERNAL: "internal"
} as const;

export const ErrorCodeSchema = z.enum(Object.values(ErrorCodes));
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

const idBody = /^[a-z0-9][a-z0-9_-]{2,127}$/;
export const AccountIdSchema = z.string().regex(/^acct_[a-z0-9][a-z0-9_-]{2,127}$/);
export const ActorIdSchema = z.string().regex(/^actor_[a-z0-9][a-z0-9_-]{2,127}$/);
export const NodeIdSchema = z.string().regex(/^node_[a-z0-9][a-z0-9_-]{2,127}$/);
export const ProjectIdSchema = z.string().regex(/^proj_[a-z0-9][a-z0-9_-]{2,127}$/);
export const RootIdSchema = z.string().regex(/^root_[a-z0-9][a-z0-9_-]{2,127}$/);
export const InvocationIdSchema = z.string().regex(/^inv_[a-z0-9][a-z0-9_-]{2,127}$/);
export const AttemptIdSchema = z.string().regex(/^att_[a-z0-9][a-z0-9_-]{2,127}$/);
export const DispatchIdSchema = z.string().regex(/^dsp_[a-z0-9][a-z0-9_-]{2,127}$/);
export const ApprovalIdSchema = z.string().regex(/^apr_[a-z0-9][a-z0-9_-]{2,127}$/);
export const ReceiptIdSchema = z.string().regex(/^rcpt_[a-z0-9][a-z0-9_-]{2,127}$/);
export const JobIdSchema = z.string().regex(/^job_[a-z0-9][a-z0-9_-]{2,127}$/);
export const TransferIdSchema = z.string().regex(/^xfr_[a-z0-9][a-z0-9_-]{2,127}$/);
export const ArtifactIdSchema = z.string().regex(/^artifact_[a-f0-9]{32}\.(?:log|png)$/);
export const NodePlatformSchema = z.enum(["darwin", "linux", "win32", "android"]);
export type NodePlatform = z.infer<typeof NodePlatformSchema>;

export const NodeWakeSignalSchema = z
  .object({
    schemaVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal("dispatch.available"),
    nodeId: NodeIdSchema,
    issuedAt: z.iso.datetime({ offset: true })
  })
  .strict();
export type NodeWakeSignal = z.infer<typeof NodeWakeSignalSchema>;

export const ResourcePathSchema = z
  .string()
  .max(4096)
  .superRefine((value, context) => {
    if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) {
      context.addIssue({ code: "custom", message: "resource path must be relative POSIX syntax" });
      return;
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment === "." || segment === ".." || segment === "")) {
      if (value !== "") {
        context.addIssue({ code: "custom", message: "resource path contains an unsafe segment" });
      }
    }
  });

export const AbsolutePathSchema = z
  .string()
  .max(4096)
  .superRefine((value, context) => {
    if (value.includes("\0") || value.includes("\\") || !value.startsWith("/")) {
      context.addIssue({ code: "custom", message: "path must use absolute POSIX syntax" });
      return;
    }
    if (
      value !== "/" &&
      value
        .slice(1)
        .split("/")
        .some((segment) => segment === "." || segment === ".." || segment === "")
    ) {
      context.addIssue({ code: "custom", message: "absolute path contains an unsafe segment" });
    }
  });

export interface AdvertisedRootPath {
  rootId: string;
  path?: string | undefined;
}

export function containsAbsolutePath(rootPath: string, absolutePath: string): boolean {
  return (
    rootPath === "/" ||
    absolutePath === rootPath ||
    absolutePath.startsWith(`${rootPath.replace(/\/+$/, "")}/`)
  );
}

export function rootForAbsolutePath<T extends AdvertisedRootPath>(
  absolutePath: string,
  roots: readonly T[]
): T | undefined {
  AbsolutePathSchema.parse(absolutePath);
  return roots
    .filter(
      (root): root is T & { path: string } =>
        typeof root.path === "string" && containsAbsolutePath(root.path, absolutePath)
    )
    .sort(
      (left, right) =>
        right.path.length - left.path.length || left.rootId.localeCompare(right.rootId)
    )[0];
}

export function relativePathFromRoot(rootPath: string, absolutePath: string): string {
  if (!containsAbsolutePath(rootPath, absolutePath)) {
    throw new Error("absolute path is outside the selected root");
  }
  if (rootPath === "/") return absolutePath.slice(1);
  if (rootPath === absolutePath) return "";
  return absolutePath.slice(rootPath.replace(/\/+$/, "").length + 1);
}

const NonEmptyResourcePathSchema = ResourcePathSchema.pipe(z.string().min(1));

const LegacyRootPathShape = {
  rootId: RootIdSchema,
  path: ResourcePathSchema
} as const;
const AbsolutePathShape = { path: AbsolutePathSchema } as const;
const LegacyRootFileShape = {
  rootId: RootIdSchema,
  path: NonEmptyResourcePathSchema
} as const;
const AbsoluteFileShape = { path: AbsolutePathSchema } as const;

const FileListOptions = {
  glob: z.string().min(1).max(512).optional(),
  maxEntries: z.number().int().min(1).max(10_000).default(1000)
} as const;
const FileReadOptions = {
  encoding: z.literal("utf8").default("utf8"),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024)
    .default(1024 * 1024)
} as const;
const FileSearchOptions = {
  query: z.string().min(1).max(1000),
  glob: z.string().min(1).max(512).optional(),
  maxMatches: z.number().int().min(1).max(10_000).default(1000)
} as const;
const FileWriteOptions = {
  content: z.string().max(10 * 1024 * 1024),
  createOnly: z.boolean().default(false)
} as const;
const FileEditOptions = {
  oldText: z.string().min(1),
  newText: z.string(),
  replaceAll: z.boolean().default(false)
} as const;
const FilePatchOptions = {
  patch: z
    .string()
    .min(1)
    .max(10 * 1024 * 1024)
} as const;
export const TransferEndpointSchema = z
  .object({
    nodeId: NodeIdSchema,
    rootId: RootIdSchema,
    path: NonEmptyResourcePathSchema
  })
  .strict();
export type TransferEndpoint = z.infer<typeof TransferEndpointSchema>;

export const AgentTransferSourceSchema = z
  .object({
    kind: z.literal("agent"),
    path: NonEmptyResourcePathSchema,
    byteSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    contentSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  })
  .strict();

export const FileTransferArgsSchema = z
  .object({
    source: z.union([TransferEndpointSchema, AgentTransferSourceSchema]),
    destination: TransferEndpointSchema,
    overwrite: z.literal("never").default("never"),
    chunkSizeBytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(32 * 1024 * 1024)
      .default(8 * 1024 * 1024)
  })
  .strict()
  .refine(
    (value) => !("nodeId" in value.source) || value.source.nodeId !== value.destination.nodeId,
    "source and destination nodes must be different"
  );
export type FileTransferArgs = z.infer<typeof FileTransferArgsSchema>;
const ShellOptions = {
  command: z.string().min(1).max(32_768),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(30 * 60 * 1000)
    .default(120_000),
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(8192)).default({})
} as const;
const UiSelectorSchema = z
  .object({
    snapshotId: z.string().min(1).max(128).optional(),
    nodeId: z.number().int().min(0).max(1000).optional(),
    ref: z.string().min(1).max(512).optional(),
    resourceId: z.string().min(1).max(256).optional(),
    text: z.string().max(1000).optional(),
    contentDescription: z.string().max(1000).optional(),
    className: z.string().min(1).max(256).optional(),
    packageName: z.string().min(1).max(256).optional(),
    role: z
      .enum([
        "button",
        "checkbox",
        "switch",
        "edit_text",
        "text",
        "image",
        "list",
        "list_item",
        "web_view",
        "container",
        "unknown"
      ])
      .optional(),
    clickable: z.boolean().optional(),
    longClickable: z.boolean().optional(),
    editable: z.boolean().optional(),
    scrollable: z.boolean().optional(),
    enabled: z.boolean().optional(),
    focused: z.boolean().optional(),
    selected: z.boolean().optional(),
    checked: z.boolean().optional(),
    match: z.enum(["exact", "contains"]).default("exact"),
    index: z.number().int().min(0).max(1000).default(0)
  })
  .strict()
  .refine(
    (selector) =>
      selector.nodeId !== undefined ||
      selector.ref !== undefined ||
      selector.resourceId !== undefined ||
      selector.text !== undefined ||
      selector.contentDescription !== undefined ||
      selector.className !== undefined ||
      selector.packageName !== undefined ||
      selector.role !== undefined ||
      selector.clickable !== undefined ||
      selector.longClickable !== undefined ||
      selector.editable !== undefined ||
      selector.scrollable !== undefined ||
      selector.enabled !== undefined ||
      selector.focused !== undefined ||
      selector.selected !== undefined ||
      selector.checked !== undefined,
    "UI selector must include at least one matching field."
  );
const UiActionArgsSchema = z
  .object({
    selector: UiSelectorSchema,
    action: z.enum([
      "click",
      "long_click",
      "focus",
      "scroll_forward",
      "scroll_backward",
      "set_text",
      "clear_text"
    ]),
    text: z.string().max(4000).optional(),
    postActionWaitMs: z.number().int().min(0).max(5000).default(500)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "set_text" && value.text === undefined) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "text is required for set_text"
      });
    } else if (value.action !== "set_text" && value.text !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "text is only accepted for set_text"
      });
    }
  });

export const ToolArgsSchemas = {
  "device.list": z.object({}).strict(),
  "device.status": z.object({ nodeId: NodeIdSchema }).strict(),
  "device.battery.get": z.object({}).strict(),
  "device.info.get": z.object({}).strict(),
  "device.network.get": z.object({}).strict(),
  "device.storage.get": z.object({}).strict(),
  "device.vibrate": z
    .object({
      durationMs: z.number().int().min(1).max(10_000).default(300),
      amplitude: z.number().int().min(1).max(255).default(128)
    })
    .strict(),
  "device.navigation": z
    .object({
      action: z.enum(["back", "home", "recents", "notifications", "quick_settings"])
    })
    .strict(),
  "app.open": z
    .object({
      packageName: z
        .string()
        .min(3)
        .max(255)
        .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/),
      waitForForegroundMs: z.number().int().min(0).max(15_000).default(5000)
    })
    .strict(),
  "display.status": z.object({}).strict(),
  "audio.status": z.object({}).strict(),
  "audio.volume.set": z
    .object({
      stream: z.enum(["media", "alarm", "notification", "ring", "system", "voice_call"]),
      levelPercent: z.number().int().min(0).max(100)
    })
    .strict(),
  "flashlight.status": z.object({}).strict(),
  "flashlight.set": z
    .object({
      enabled: z.boolean(),
      cameraId: z.string().min(1).max(128).optional()
    })
    .strict(),
  "location.get": z
    .object({
      desiredAccuracy: z.enum(["coarse", "balanced", "precise"]).default("balanced"),
      maxAgeMs: z
        .number()
        .int()
        .min(0)
        .max(10 * 60 * 1000)
        .default(15_000),
      timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000)
    })
    .strict(),
  "notification.show": z
    .object({
      title: z.string().trim().min(1).max(120),
      body: z.string().max(2000)
    })
    .strict(),
  "screen.capture": z
    .object({
      format: z.literal("png").default("png"),
      maxWidth: z.number().int().min(320).max(2160).default(1080)
    })
    .strict(),
  "ui.inspect": z
    .object({
      maxDepth: z.number().int().min(1).max(30).default(12),
      maxNodes: z.number().int().min(1).max(1000).default(500)
    })
    .strict(),
  "ui.wait": z.discriminatedUnion("condition", [
    z
      .object({
        condition: z.literal("element"),
        selector: UiSelectorSchema,
        state: z.enum(["present", "absent"]).default("present"),
        timeoutMs: z.number().int().min(0).max(30_000).default(10_000),
        pollIntervalMs: z.number().int().min(50).max(1000).default(200)
      })
      .strict(),
    z
      .object({
        condition: z.literal("app"),
        packageName: z.string().min(1).max(255),
        timeoutMs: z.number().int().min(0).max(30_000).default(10_000),
        pollIntervalMs: z.number().int().min(50).max(1000).default(200)
      })
      .strict(),
    z
      .object({
        condition: z.literal("idle"),
        idleMs: z.number().int().min(100).max(5000).default(500),
        timeoutMs: z.number().int().min(0).max(30_000).default(10_000),
        pollIntervalMs: z.number().int().min(50).max(1000).default(100)
      })
      .strict()
  ]),
  "ui.action": UiActionArgsSchema,
  "ui.gesture": z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("tap"),
        x: z.number().int().min(0).max(20_000),
        y: z.number().int().min(0).max(20_000)
      })
      .strict(),
    z
      .object({
        type: z.literal("swipe"),
        startX: z.number().int().min(0).max(20_000),
        startY: z.number().int().min(0).max(20_000),
        endX: z.number().int().min(0).max(20_000),
        endY: z.number().int().min(0).max(20_000),
        durationMs: z.number().int().min(50).max(5000).default(300)
      })
      .strict()
  ]),
  "file.list": z.union([
    z.object({ ...LegacyRootPathShape, ...FileListOptions }).strict(),
    z.object({ ...AbsolutePathShape, ...FileListOptions }).strict()
  ]),
  "file.read": z.union([
    z.object({ ...LegacyRootFileShape, ...FileReadOptions }).strict(),
    z.object({ ...AbsoluteFileShape, ...FileReadOptions }).strict()
  ]),
  "file.search": z.union([
    z.object({ ...LegacyRootPathShape, ...FileSearchOptions }).strict(),
    z.object({ ...AbsolutePathShape, ...FileSearchOptions }).strict()
  ]),
  "file.write": z.union([
    z.object({ ...LegacyRootFileShape, ...FileWriteOptions }).strict(),
    z.object({ ...AbsoluteFileShape, ...FileWriteOptions }).strict()
  ]),
  "file.edit": z.union([
    z.object({ ...LegacyRootFileShape, ...FileEditOptions }).strict(),
    z.object({ ...AbsoluteFileShape, ...FileEditOptions }).strict()
  ]),
  "file.patch": z.union([
    z.object({ ...LegacyRootFileShape, ...FilePatchOptions }).strict(),
    z.object({ ...AbsoluteFileShape, ...FilePatchOptions }).strict()
  ]),
  "file.transfer": FileTransferArgsSchema,
  "shell.exec": z.union([
    z.object({ rootId: RootIdSchema, cwd: ResourcePathSchema, ...ShellOptions }).strict(),
    z.object({ cwd: AbsolutePathSchema, ...ShellOptions }).strict()
  ]),
  "command.template.list": z.object({ projectId: ProjectIdSchema.optional() }).strict(),
  "command.template.run": z.union([
    z
      .object({
        projectId: ProjectIdSchema.optional(),
        rootId: RootIdSchema,
        templateId: z.string().regex(idBody),
        parameters: z.record(z.string(), z.string().max(8192)).default({})
      })
      .strict(),
    z
      .object({
        projectId: ProjectIdSchema.optional(),
        cwd: AbsolutePathSchema,
        templateId: z.string().regex(idBody),
        parameters: z.record(z.string(), z.string().max(8192)).default({})
      })
      .strict()
  ]),
  "test.run": z.union([
    z
      .object({
        projectId: ProjectIdSchema.optional(),
        rootId: RootIdSchema,
        templateId: z.string().regex(idBody).default("test"),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(30 * 60 * 1000)
          .default(300_000)
      })
      .strict(),
    z
      .object({
        projectId: ProjectIdSchema.optional(),
        cwd: AbsolutePathSchema,
        templateId: z.string().regex(idBody).default("test"),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(30 * 60 * 1000)
          .default(300_000)
      })
      .strict()
  ]),
  "task.status": z.object({ jobId: JobIdSchema }).strict(),
  "task.result": z.object({ jobId: JobIdSchema }).strict(),
  "task.wait": z.object({ jobId: JobIdSchema, waitMs: WaitMsSchema.default(4000) }).strict(),
  "task.cancel": z.object({ jobId: JobIdSchema }).strict()
} as const;

export type ToolName = keyof typeof ToolArgsSchemas;
export const ToolNameSchema = z.enum(Object.keys(ToolArgsSchemas) as [ToolName, ...ToolName[]]);
export const McpProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/);
export const CustomToolIdSchema = z
  .string()
  .min(12)
  .max(255)
  .regex(/^mcp\.[a-z0-9][a-z0-9_-]{1,63}\.[a-z0-9][a-z0-9_-]{0,63}\.[a-f0-9]{8}$/);
export const ToolIdSchema = z.union([ToolNameSchema, CustomToolIdSchema]);
export type ToolId = z.infer<typeof ToolIdSchema>;

export function isBuiltinTool(tool: string): tool is ToolName {
  return ToolNameSchema.safeParse(tool).success;
}

const UiSelectorMatchFields = [
  "nodeId",
  "ref",
  "resourceId",
  "text",
  "contentDescription",
  "className",
  "packageName",
  "role",
  "clickable",
  "longClickable",
  "editable",
  "scrollable",
  "enabled",
  "focused",
  "selected",
  "checked"
] as const;

export function toolArgsJsonSchema(tool: ToolName): Record<string, unknown> {
  const schema = z.toJSONSchema(ToolArgsSchemas[tool], {
    target: "draft-2020-12",
    unrepresentable: "any",
    reused: "inline",
    io: "input"
  }) as Record<string, unknown>;
  const requireSelectorField = {
    anyOf: UiSelectorMatchFields.map((field) => ({ required: [field] }))
  };
  if (tool === "ui.action") {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    properties.selector = { ...properties.selector, ...requireSelectorField };
    schema.allOf = [
      {
        if: {
          properties: { action: { const: "set_text" } },
          required: ["action"]
        },
        then: { required: ["text"] },
        else: { not: { required: ["text"] } }
      }
    ];
  } else if (tool === "ui.wait") {
    const variants = schema.oneOf as Array<Record<string, unknown>>;
    const element = variants.find(
      (variant) =>
        ((variant.properties as Record<string, Record<string, unknown>> | undefined)?.condition
          ?.const as string | undefined) === "element"
    );
    if (element) {
      const properties = element.properties as Record<string, Record<string, unknown>>;
      properties.selector = { ...properties.selector, ...requireSelectorField };
    }
  }
  return schema;
}

export function absolutePathForToolArgs(
  tool: string,
  args: Record<string, unknown>
): string | undefined {
  if (!isBuiltinTool(tool)) return undefined;
  const candidate = tool.startsWith("file.") ? args.path : args.cwd;
  return typeof candidate === "string" && candidate.startsWith("/") ? candidate : undefined;
}

export const ReadOnlyTools: ReadonlySet<ToolName> = new Set([
  "device.list",
  "device.status",
  "device.battery.get",
  "device.info.get",
  "device.network.get",
  "device.storage.get",
  "display.status",
  "audio.status",
  "flashlight.status",
  "screen.capture",
  "ui.inspect",
  "ui.wait",
  "location.get",
  "file.list",
  "file.read",
  "file.search",
  "command.template.list",
  "task.status",
  "task.result",
  "task.wait"
]);

export const ControlPlaneTools: ReadonlySet<ToolName> = new Set([
  "device.list",
  "device.status",
  "file.transfer",
  "task.status",
  "task.result",
  "task.wait",
  "task.cancel"
]);

export const ExecutionTools: ReadonlySet<ToolName> = new Set([
  "device.navigation",
  "device.vibrate",
  "app.open",
  "audio.volume.set",
  "flashlight.set",
  "ui.action",
  "ui.gesture",
  "shell.exec",
  "command.template.run",
  "test.run"
]);

export const SideEffectTools: ReadonlySet<ToolName> = new Set([
  "device.navigation",
  "device.vibrate",
  "app.open",
  "audio.volume.set",
  "flashlight.set",
  "notification.show",
  "ui.action",
  "ui.gesture",
  "file.write",
  "file.edit",
  "file.patch",
  "file.transfer",
  "shell.exec",
  "command.template.run",
  "test.run",
  "task.cancel"
]);

export function isSideEffectTool(tool: string): boolean {
  return !isBuiltinTool(tool) || SideEffectTools.has(tool);
}

/** An exact, versioned upper bound on delegated access. No future-root wildcard. */
export const DeviceFolderPathSchema = z.string().min(1).max(32767).refine((path) =>
  (path.startsWith("/") && !path.startsWith("//") && !path.includes("\0")) ||
  /^[a-z]:[\\/]/i.test(path) && !path.includes("\0"), "Use an absolute local device folder.");
export function isDeviceRoot(path: string): boolean {
  return /^\/+$/.test(path) || /^[a-z]:[\\/]*$/i.test(path);
}
export const CollaborationScopeSchema = z.object({
  roots: z.array(z.object({
    rootId: RootIdSchema,
    path: DeviceFolderPathSchema,
    writable: z.boolean()
  }).strict()).max(64),
  allowedTools: z.array(ToolIdSchema).min(1).max(256),
  execution: z.enum(["read-only", "trusted-host", "isolated"]).default("read-only"),
  approvalPolicy: z.enum(["never", "writes", "execute", "always"]).default("never"),
  templateIds: z.array(z.string().min(1).max(128)).max(64).default([])
}).strict();
export type CollaborationScope = z.infer<typeof CollaborationScopeSchema>;

/** Generated by the control plane, carried over the authenticated Node lease. */
export const DelegationSchema = z.object({
  version: z.literal(1),
  requesterAccountId: AccountIdSchema,
  requesterUserId: z.string().min(1).max(256),
  resourceAccountId: AccountIdSchema,
  bindingId: z.string().min(1).max(256).optional(),
  bindingRevision: z.number().int().positive().optional(),
  /** Emitted only for whole-device team access supported by the current Node. */
  bindingKind: z.literal("team").optional(),
  membershipRevision: z.number().int().positive().optional(),
  grantRevision: z.number().int().positive(),
  scope: CollaborationScopeSchema,
  expiresAt: z.iso.datetime({ offset: true })
}).strict();
export type Delegation = z.infer<typeof DelegationSchema>;

const InvocationBaseSchema = z
  .object({
    schemaVersion: z.literal(PROTOCOL_VERSION),
    invocationId: InvocationIdSchema,
    attemptId: AttemptIdSchema,
    accountId: AccountIdSchema,
    actor: z
      .object({
        type: z.enum(["owner", "agent", "service", "user"]),
        id: ActorIdSchema
      })
      .strict(),
    target: z.union([
      z.object({ nodeId: NodeIdSchema }).strict(),
      z
        .object({
          projectId: ProjectIdSchema,
          affinity: z.string().min(1).max(128).optional()
        })
        .strict()
    ]),
    authorization: z
      .object({
        projectId: ProjectIdSchema.optional(),
        rootIds: z.array(RootIdSchema).max(64).default([]),
        grantId: z.string().regex(/^grant_[a-z0-9][a-z0-9_-]{2,127}$/)
      })
      .strict(),
    delegation: DelegationSchema.optional(),
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    executionTimeoutMs: ExecutionTimeoutMsSchema.optional(),
    idempotencyKey: z.string().min(8).max(256).optional(),
    metadata: z
      .object({
        correlationId: z.string().min(1).max(128).optional(),
        sessionId: z.string().min(1).max(128).optional(),
        source: z.enum(["http", "cli", "mcp", "sdk", "skill", "internal"])
      })
      .strict()
  })
  .strict();

const invocationVariants = Object.entries(ToolArgsSchemas).map(([tool, argsSchema]) =>
  InvocationBaseSchema.extend({
    tool: z.literal(tool),
    args: argsSchema
  }).strict()
);
const CustomInvocationSchema = InvocationBaseSchema.extend({
  tool: CustomToolIdSchema,
  args: z.record(z.string(), z.unknown())
}).strict();
const BuiltinInvocationSchema = z.union(
  invocationVariants as unknown as [
    (typeof invocationVariants)[number],
    (typeof invocationVariants)[number],
    ...(typeof invocationVariants)[number][]
  ]
);

export const InvocationSchema = z
  .union([BuiltinInvocationSchema, CustomInvocationSchema])
  .superRefine((invocation, context) => {
    if (Date.parse(invocation.expiresAt) <= Date.parse(invocation.issuedAt)) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "must be after issuedAt" });
    }
    if (isSideEffectTool(invocation.tool) && !invocation.idempotencyKey) {
      context.addIssue({
        code: "custom",
        path: ["idempotencyKey"],
        message: "required for side-effecting tools"
      });
    }
  });

export type Invocation = z.infer<typeof InvocationSchema>;

export const ErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string().min(1).max(2000),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional()
  })
  .strict();
export type AdcError = z.infer<typeof ErrorSchema>;

export const PolicyDecisionSchema = z
  .object({
    outcome: z.enum(["allow", "deny", "approval_required"]),
    reasonCode: z.string().regex(/^[a-z][a-z0-9_.-]{2,127}$/),
    explanation: z.string().min(1).max(2000),
    evaluatedLayers: z.array(z.enum(["account", "agent", "node", "root", "capability"])),
    profile: z.enum(["read-only", "workspace-write", "approve-required", "unattended"]),
    decisionHash: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  })
  .strict();
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const ReceiptSchema = z
  .object({
    schemaVersion: z.literal(PROTOCOL_VERSION),
    receiptId: ReceiptIdSchema,
    invocationId: InvocationIdSchema,
    attemptId: AttemptIdSchema,
    nodeId: NodeIdSchema,
    tool: ToolIdSchema,
    terminalStatus: z.enum(["succeeded", "failed", "denied", "cancelled", "unknown_outcome"]),
    sideEffect: z.boolean(),
    replayed: z.boolean().default(false),
    idempotencyKeyHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    argsHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    policyDecisionHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    outputHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    startedAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }),
    durationMs: z.number().int().nonnegative(),
    artifactRefs: z.array(ArtifactIdSchema).default([]),
    delegation: DelegationSchema.optional()
  })
  .strict();
export type Receipt = z.infer<typeof ReceiptSchema>;

export const ResultSchema = z
  .object({
    schemaVersion: z.literal(PROTOCOL_VERSION),
    invocationId: InvocationIdSchema,
    attemptId: AttemptIdSchema,
    status: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "denied",
      "approval_required",
      "offline",
      "cancelled",
      "unknown_outcome"
    ]),
    output: z.unknown().optional(),
    error: ErrorSchema.optional(),
    receipt: ReceiptSchema.optional(),
    jobId: JobIdSchema.optional()
  })
  .strict()
  .superRefine((result, context) => {
    const errorStatuses = new Set([
      "failed",
      "denied",
      "approval_required",
      "offline",
      "cancelled",
      "unknown_outcome"
    ]);
    if (errorStatuses.has(result.status) && !result.error) {
      context.addIssue({ code: "custom", path: ["error"], message: "required for error status" });
    }
  });
export type InvocationResult = z.infer<typeof ResultSchema>;

export const JsonObjectSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  try {
    if (JSON.stringify(value).length > 128 * 1024) {
      context.addIssue({ code: "custom", message: "JSON schema exceeds 128 KiB" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "JSON schema must be serializable" });
  }
});
export type JsonObject = z.infer<typeof JsonObjectSchema>;

export const ToolCapabilitySchema = z
  .object({
    name: ToolIdSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    risk: z.enum(["read", "write", "execute"]),
    sandboxProfiles: z
      .array(z.enum(["restricted-process", "full-trust", "container", "native-app"]))
      .min(1),
    availability: z
      .object({
        state: z.enum([
          "available",
          "permission_required",
          "foreground_required",
          "temporarily_unavailable"
        ]),
        reason: z.string().min(1).max(500).optional(),
        observedAt: z.iso.datetime({ offset: true })
      })
      .strict()
      .optional(),
    title: z.string().min(1).max(128).optional(),
    description: z.string().min(1).max(4000).optional(),
    inputSchema: JsonObjectSchema.optional(),
    outputSchema: JsonObjectSchema.optional(),
    provider: z
      .object({
        kind: z.literal("mcp"),
        providerId: McpProviderIdSchema,
        providerName: z.string().min(1).max(128),
        sourceToolName: z.string().min(1).max(256)
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((tool, context) => {
    if (CustomToolIdSchema.safeParse(tool.name).success) {
      if (!tool.provider) {
        context.addIssue({
          code: "custom",
          path: ["provider"],
          message: "required for custom MCP tools"
        });
      }
      if (!tool.inputSchema || tool.inputSchema.type !== "object") {
        context.addIssue({
          code: "custom",
          path: ["inputSchema"],
          message: "custom MCP tools require an object input schema"
        });
      }
      if (tool.risk !== "execute") {
        context.addIssue({
          code: "custom",
          path: ["risk"],
          message: "custom MCP tools default to execute risk"
        });
      }
    }
  });
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

export const CapabilitySchema = z
  .object({
    schemaVersion: z.literal(PROTOCOL_VERSION),
    nodeId: NodeIdSchema,
    tools: z
      .array(ToolCapabilitySchema)
      .max(512)
      .refine(
        (tools) => new Set(tools.map((tool) => tool.name)).size === tools.length,
        "Tool IDs must be unique."
      ),
    roots: z.array(
      z
        .object({
          rootId: RootIdSchema,
          path: AbsolutePathSchema.optional(),
          label: z.string().min(1).max(128),
          writable: z.boolean()
        })
        .strict()
    ),
    platform: NodePlatformSchema,
    accessMode: z.enum(["none", "selected", "home", "full"]).optional(),
    nodeVersion: z.string().min(1).max(64),
    transferDataPlanes: z.array(z.enum(["local", "object"])).optional(),
    collaboration: z.object({
      version: z.literal(1),
      trustedHost: z.boolean(),
      isolation: z.enum(["none", "container", "rootless-container", "vm"]),
      features: z.array(z.literal("team-root-sharing")).optional(),
      roots: z.array(z.object({ rootId: RootIdSchema, path: DeviceFolderPathSchema }).strict()).max(64).optional()
    }).strict().optional(),
    buildId: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    advertisedAt: z.iso.datetime({ offset: true })
  })
  .strict();
export type CapabilityAdvertisement = z.infer<typeof CapabilitySchema>;

export function assertInvocationCurrent(invocation: Invocation, now = new Date()): void {
  if (Date.parse(invocation.expiresAt) <= now.getTime()) {
    throw new ProtocolError(ErrorCodes.EXPIRED, "invocation has expired", false);
  }
}

export class ProtocolError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }

  toJSON(): AdcError {
    return ErrorSchema.parse({
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {})
    });
  }
}

export function createId(
  prefix:
    | "acct"
    | "actor"
    | "node"
    | "proj"
    | "root"
    | "inv"
    | "att"
    | "dsp"
    | "apr"
    | "rcpt"
    | "job"
    | "xfr"
    | "grant"
): string {
  const timestamp = Date.now().toString(36).padStart(9, "0");
  return `${prefix}_${timestamp}${randomBytes(10).toString("hex")}`;
}
