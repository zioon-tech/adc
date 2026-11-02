import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AdcClientError,
  NodeApiClient,
  type NodeDispatch,
  type NodeReleaseUpdate
} from "@adc/client/node";
import {
  CapabilitySchema,
  FileTransferArgsSchema,
  absolutePathForToolArgs,
  rootForAbsolutePath,
  type CapabilityAdvertisement,
  type NodePlatform,
  type ToolName
} from "@adc/protocol";
import { ToolRuntime, type CommandTemplate, type LocalRoot } from "@adc/tool-runtime";
import { SharingConfigSchema, type McpProviderConfig, type SharingConfig } from "./config.ts";
import { DockerIsolation } from "./isolation.ts";
import { validateLocalDelegation } from "./delegation.ts";
import { McpProviderManager } from "./mcp-providers.ts";
import { nodePlatform } from "./platform.ts";
import { NodeTransferRuntime } from "./transfer.ts";
import { WakeLatch, WebSocketWakeSource, type NodeWakeSource } from "./wake.ts";

const DEFAULT_MAX_CONCURRENCY = 6;
const MAX_MAX_CONCURRENCY = 32;
const DESKTOP_TOOLS = [
  "file.list",
  "file.read",
  "file.search",
  "file.write",
  "file.edit",
  "file.patch",
  "file.transfer",
  "shell.exec",
  "command.template.list",
  "command.template.run",
  "test.run"
] as const satisfies readonly ToolName[];

interface LocalAccess {
  roots: LocalRoot[];
  templates?: CommandTemplate[];
  accessMode?: "none" | "selected" | "home" | "full";
  mcpProviders?: McpProviderConfig[];
  sharing?: SharingConfig;
}

function normalizeAccess(access: LocalAccess): Required<LocalAccess> {
  return {
    roots: access.roots,
    templates: access.templates ?? [],
    accessMode: access.accessMode ?? "selected",
    mcpProviders: access.mcpProviders ?? [],
    sharing: SharingConfigSchema.parse(access.sharing)
  };
}

function accessFingerprint(access: LocalAccess): string {
  return JSON.stringify(normalizeAccess(access));
}

export interface NodeDaemonOptions {
  controlPlaneUrl: string;
  nodeId: string;
  accountId?: string;
  privateKey: string;
  roots: LocalRoot[];
  templates?: CommandTemplate[];
  stateDirectory: string;
  nodeVersion?: string;
  buildId?: string;
  platform?: NodePlatform;
  pollIntervalMs?: number;
  leaseRenewIntervalMs?: number;
  fetcher?: typeof fetch;
  accessMode?: LocalAccess["accessMode"];
  loadAccess?: () => Promise<LocalAccess>;
  configReloadIntervalMs?: number;
  mcpProviders?: McpProviderConfig[];
  mcpProviderManager?: McpProviderManager;
  wakeSource?: NodeWakeSource;
  sharing?: SharingConfig;
  workerBundle?: string;
}

export class NodeDaemon {
  readonly api: NodeApiClient;
  readonly runtime: ToolRuntime;
  readonly providers: McpProviderManager;
  readonly transfers: NodeTransferRuntime;
  private readonly shutdown = new AbortController();
  private readonly wakeSource: NodeWakeSource;
  private access: LocalAccess;
  private accessInitialized = false;
  private reloadQueue: Promise<boolean> = Promise.resolve(false);
  private maxConcurrency = DEFAULT_MAX_CONCURRENCY;
  private announcedUpdateBuildId: string | undefined;
  private isolation: DockerIsolation | undefined;
  private isolationFingerprint = "";

  constructor(private readonly options: NodeDaemonOptions) {
    this.access = normalizeAccess({
      roots: options.roots,
      ...(options.templates ? { templates: options.templates } : {}),
      ...(options.accessMode ? { accessMode: options.accessMode } : {}),
      ...(options.mcpProviders ? { mcpProviders: options.mcpProviders } : {}),
      ...(options.sharing ? { sharing: options.sharing } : {})
    });
    this.providers = options.mcpProviderManager ?? new McpProviderManager();
    this.api = options.fetcher
      ? new NodeApiClient(
          options.controlPlaneUrl,
          options.nodeId,
          options.privateKey,
          options.fetcher
        )
      : new NodeApiClient(options.controlPlaneUrl, options.nodeId, options.privateKey);
    this.wakeSource =
      options.wakeSource ??
      new WebSocketWakeSource({
        controlPlaneUrl: options.controlPlaneUrl,
        nodeId: options.nodeId,
        privateKey: options.privateKey,
        onError: (error) => {
          console.error(
            JSON.stringify({
              level: "warn",
              component: "adc-node",
              message: "wake connection failed",
              error: error instanceof Error ? error.message : String(error)
            })
          );
        }
      });
    this.runtime = new ToolRuntime({
      nodeId: options.nodeId,
      roots: options.roots,
      stateDirectory: options.stateDirectory,
      fullTrust: options.accessMode === "full",
      externalExecutor: this.providers.execute,
      ...(options.templates ? { templates: options.templates } : {})
    });
    this.transfers = new NodeTransferRuntime(options.nodeId, this.api, options.stateDirectory);
  }

  private reloadAccess(): Promise<boolean> {
    this.reloadQueue = this.reloadQueue
      .catch(() => false)
      .then(async () => {
        const next = normalizeAccess(
          this.options.loadAccess ? await this.options.loadAccess() : this.access
        );
        const changed = accessFingerprint(next) !== accessFingerprint(this.access);
        const providersBefore = JSON.stringify(this.providers.capabilities());
        await this.providers.update(next.mcpProviders);
        const providersChanged = providersBefore !== JSON.stringify(this.providers.capabilities());
        const isolationFingerprint = JSON.stringify(next.sharing);
        if (isolationFingerprint !== this.isolationFingerprint) {
          this.isolation = undefined;
          this.isolationFingerprint = isolationFingerprint;
          if (next.sharing.enabled && next.sharing.isolation === "docker" && next.sharing.image) {
            const adapter = new DockerIsolation({
              stateDirectory: this.options.stateDirectory,
              nodeId: this.options.nodeId,
              workerBundle: this.options.workerBundle ?? fileURLToPath(new URL("./collaboration-worker.mjs", import.meta.url)),
              image: next.sharing.image
            });
            try { await adapter.verify(); this.isolation = adapter; }
            catch { console.error(JSON.stringify({ level: "warn", component: "adc-node", message: "Sharing isolation unavailable; guest execution disabled." })); }
          }
        }
        if (!this.accessInitialized || changed) {
          this.runtime.updateAccess(next.roots, next.templates, next.accessMode === "full");
        }
        this.access = next;
        this.accessInitialized = true;
        return changed || providersChanged;
      });
    return this.reloadQueue;
  }

  private async waitForWork(
    wake: WakeLatch,
    maximumDelayMs: number,
    signal: AbortSignal
  ): Promise<void> {
    const deadline = Date.now() + maximumDelayMs;
    do {
      const remaining = Math.max(0, deadline - Date.now());
      const delay = this.options.loadAccess
        ? Math.min(this.options.configReloadIntervalMs ?? 1_000, remaining)
        : remaining;
      if (await wake.wait(delay, signal)) return;
      if (signal.aborted || Date.now() >= deadline) return;
      if (this.options.loadAccess && (await this.reloadAccess())) return;
    } while (!signal.aborted);
  }

  capability(now = new Date()): CapabilityAdvertisement {
    const platform = this.options.platform ?? nodePlatform();
    return CapabilitySchema.parse({
      schemaVersion: "0.1",
      nodeId: this.options.nodeId,
      tools: [
        ...DESKTOP_TOOLS.map((name) => ({
          name,
          version: "0.1.0",
          risk:
            name.startsWith("file.") &&
            !["file.write", "file.edit", "file.patch", "file.transfer"].includes(name)
              ? ("read" as const)
              : name === "command.template.list"
                ? ("read" as const)
                : ["file.write", "file.edit", "file.patch", "file.transfer"].includes(name)
                  ? ("write" as const)
                  : ("execute" as const),
          sandboxProfiles: [
            this.access.accessMode === "full"
              ? ("full-trust" as const)
              : ("restricted-process" as const)
          ]
        })),
        ...this.providers.capabilities()
      ],
      accessMode: this.access.accessMode ?? "selected",
      roots: this.access.roots.map((root) => ({
        rootId: root.rootId,
        ...(platform === "win32" ? {} : { path: root.path }),
        label: root.label ?? root.rootId,
        writable: root.writable
      })),
      platform,
      nodeVersion: this.options.nodeVersion ?? "0.1.0",
      transferDataPlanes: ["local", "object"],
      ...(this.access.sharing?.enabled ? { collaboration: {
        version: 1, trustedHost: this.access.sharing.trustedHost,
        isolation: this.isolation ? "container" : "none",
        features: ["team-root-sharing"],
        ...(platform === "win32" ? { roots: this.access.roots.map((root) => ({ rootId: root.rootId, path: root.path })) } : {})
      } } : {}),
      ...(this.options.buildId ? { buildId: this.options.buildId } : {}),
      advertisedAt: now.toISOString()
    });
  }

  private announceUpdate(update: NodeReleaseUpdate | undefined): void {
    if (
      update?.state !== "update_available" ||
      update.latest.buildId === this.announcedUpdateBuildId
    ) {
      return;
    }
    this.announcedUpdateBuildId = update.latest.buildId;
    console.error(
      JSON.stringify({
        level: "info",
        component: "adc-node",
        message: "connector update available",
        currentVersion: this.options.nodeVersion ?? "0.1.0",
        latestVersion: update.latest.version,
        command: "adc update"
      })
    );
  }

  private async pollForDispatch(
    activeTaskCount: number,
    claim: boolean
  ): Promise<NodeDispatch | undefined> {
    await this.reloadAccess();
    const response = await this.api.poll(this.capability(), { activeTaskCount, claim });
    this.announceUpdate(response.update);
    const configuredConcurrency = response.maxConcurrency;
    if (
      typeof configuredConcurrency === "number" &&
      Number.isInteger(configuredConcurrency) &&
      configuredConcurrency >= 1 &&
      configuredConcurrency <= MAX_MAX_CONCURRENCY
    ) {
      this.maxConcurrency = configuredConcurrency;
    }
    return response.dispatch ?? undefined;
  }

  private async executeDispatch(dispatch: NodeDispatch, lifecycle: AbortSignal): Promise<void> {
    const acknowledged = await this.api.acknowledge(dispatch.dispatchId, dispatch.leaseToken);
    let reloadFailed = false;
    try {
      await this.reloadAccess();
    } catch {
      reloadFailed = true;
    }
    const cancellation = new AbortController();
    const onStop = () => cancellation.abort();
    lifecycle.addEventListener("abort", onStop, { once: true });
    if (lifecycle.aborted || acknowledged.cancelRequested || reloadFailed) cancellation.abort();
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    let leaseDeadline = 0;
    let finished = false;
    const armLeaseDeadline = (expiresAt: string) => {
      if (finished) return;
      if (leaseTimer) clearTimeout(leaseTimer);
      const remaining = Date.parse(expiresAt) - Date.now();
      leaseDeadline = Date.parse(expiresAt);
      if (!Number.isFinite(remaining) || remaining <= 0) {
        cancellation.abort();
        return;
      }
      leaseTimer = setTimeout(() => cancellation.abort(), remaining);
      leaseTimer.unref();
    };
    armLeaseDeadline(acknowledged.leaseExpiresAt);
    let executionTimer: ReturnType<typeof setTimeout> | undefined;
    if (dispatch.invocation.executionTimeoutMs !== undefined) {
      const deadline = Math.min(
        Date.parse(dispatch.invocation.expiresAt),
        Date.parse(dispatch.invocation.issuedAt) + dispatch.invocation.executionTimeoutMs
      );
      const remaining = deadline - Date.now();
      if (remaining <= 0) cancellation.abort();
      else {
        executionTimer = setTimeout(() => cancellation.abort(), remaining);
        executionTimer.unref();
      }
    }
    let renewInFlight = false;
    const renewTimer = setInterval(
      () => {
        if (renewInFlight) return;
        renewInFlight = true;
        void this.api
          .renewLease(dispatch.dispatchId, dispatch.leaseToken)
          .then((renewed) => {
            armLeaseDeadline(renewed.leaseExpiresAt);
            if (renewed.cancelRequested) {
              cancellation.abort();
            }
          })
          .catch((error) => {
            if (error instanceof AdcClientError && [401, 403, 409].includes(error.statusCode)) {
              cancellation.abort();
            }
            console.error(
              JSON.stringify({
                level: "warn",
                component: "adc-node",
                message: "lease renewal failed",
                error: error instanceof Error ? error.message : String(error)
              })
            );
          })
          .finally(() => {
            renewInFlight = false;
          });
      },
      Math.max(
        1,
        Math.min(
          this.options.leaseRenewIntervalMs ?? 10_000,
          Math.floor((Date.parse(acknowledged.leaseExpiresAt) - Date.now()) / 3) || 1
        )
      )
    );
    renewTimer.unref();
    const accessAtStart = this.access;
    const invocationArgs = dispatch.invocation.args as Record<string, unknown>;
    const absolutePath = absolutePathForToolArgs(dispatch.invocation.tool, invocationArgs);
    const rootId =
      (typeof invocationArgs.rootId === "string" ? invocationArgs.rootId : undefined) ??
      (dispatch.invocation.tool === "file.transfer"
        ? (() => {
            const transfer = FileTransferArgsSchema.parse(dispatch.invocation.args);
            return "nodeId" in transfer.source && transfer.source.nodeId === this.options.nodeId
              ? transfer.source.rootId
              : transfer.destination.rootId;
          })()
        : undefined) ??
      (absolutePath ? rootForAbsolutePath(absolutePath, accessAtStart.roots)?.rootId : undefined);
    let reloadInFlight = false;
    const configTimer = this.options.loadAccess
      ? setInterval(() => {
          if (reloadInFlight) return;
          reloadInFlight = true;
          void this.reloadAccess()
            .then(() => {
              const before = accessAtStart.roots.find((root) => root.rootId === rootId);
              const after = this.access.roots.find((root) => root.rootId === rootId);
              const delegatedRootChanged = dispatch.invocation.delegation?.scope.roots.some(root =>
                !this.access.roots.some(local => local.rootId === root.rootId && local.path === root.path &&
                  (!root.writable || local.writable)));
              if (
                delegatedRootChanged ||
                (before &&
                  (!after || before.path !== after.path || (before.writable && !after.writable))) ||
                (accessAtStart.accessMode === "full" && this.access.accessMode !== "full") ||
                JSON.stringify(accessAtStart.templates) !== JSON.stringify(this.access.templates) ||
                JSON.stringify(accessAtStart.mcpProviders) !==
                  JSON.stringify(this.access.mcpProviders) ||
                (dispatch.invocation.delegation && JSON.stringify(accessAtStart.sharing) !== JSON.stringify(this.access.sharing))
              )
                cancellation.abort();
            })
            .catch(() => cancellation.abort())
            .finally(() => {
              reloadInFlight = false;
            });
        }, this.options.configReloadIntervalMs ?? 1000)
      : undefined;
    configTimer?.unref();
    try {
      const invocation = dispatch.invocation;
      const delegated = invocation.delegation;
      const roots = delegated ? delegated.scope.roots.map((root) => ({ ...root, allowSensitivePaths: false })) : accessAtStart.roots;
      const templates = (accessAtStart.templates ?? []).filter((entry) => !delegated ||
        (delegated.scope.templateIds.includes(entry.templateId) && roots.some((root) => root.rootId === entry.rootId)));
      const sharing = SharingConfigSchema.parse(accessAtStart.sharing);
      const isolated = this.isolation;
      const runtime = delegated ? new ToolRuntime({
        nodeId: this.options.nodeId, stateDirectory: this.options.stateDirectory,
        roots, templates, protectSensitivePaths: true,
        fullTrust: delegated.scope.execution === "trusted-host" && sharing.trustedHost,
        externalExecutor: this.providers.execute,
        authorizeExecution: async (current) => {
          await validateLocalDelegation(current, this.options.accountId, this.options.nodeId, accessAtStart.roots, sharing, !!isolated);
        },
        ...(delegated.scope.execution === "isolated" ? {
          executionExecutor: async (current, signal) => {
            if (!isolated) throw new Error("Isolation is unavailable");
            return isolated.execute(current, roots, templates, dispatch.policyDecision, signal, () => leaseDeadline);
          }
        } : {})
      }) : this.runtime;
      const result =
        dispatch.invocation.tool === "file.transfer"
          ? await this.transfers.execute(
              dispatch.invocation,
              dispatch.policyDecision,
              accessAtStart.roots.map((root) => ({
                ...root,
                allowSensitivePaths: accessAtStart.accessMode === "full"
              })),
              cancellation.signal
            )
          : await runtime.execute(
              dispatch.invocation,
              dispatch.policyDecision,
              cancellation.signal
            );
      for (const artifactId of result.receipt?.artifactRefs ?? []) {
        const data = await runtime.readArtifact(artifactId);
        await this.api.uploadArtifact({
          dispatchId: dispatch.dispatchId,
          artifactId,
          contentType: "text/plain; charset=utf-8",
          sha256: `sha256:${createHash("sha256").update(data).digest("hex")}`,
          data
        });
      }
      await this.api.complete({
        dispatchId: dispatch.dispatchId,
        leaseToken: dispatch.leaseToken,
        result
      });
    } finally {
      finished = true;
      clearInterval(renewTimer);
      if (configTimer) clearInterval(configTimer);
      if (leaseTimer) clearTimeout(leaseTimer);
      if (executionTimer) clearTimeout(executionTimer);
      lifecycle.removeEventListener("abort", onStop);
    }
  }

  async runOnce(signal?: AbortSignal): Promise<boolean> {
    const lifecycle = signal
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal;
    if (lifecycle.aborted) return false;
    const dispatch = await this.pollForDispatch(0, true);
    if (!dispatch) return false;
    await this.executeDispatch(dispatch, lifecycle);
    return true;
  }

  async run(signal?: AbortSignal): Promise<void> {
    const lifecycle = signal
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal;
    const wake = new WakeLatch();
    const wakeTask = this.wakeSource
      .run(() => wake.notify(), lifecycle)
      .catch((error) => {
        console.error(
          JSON.stringify({
            level: "error",
            component: "adc-node",
            message: "wake listener stopped",
            error: error instanceof Error ? error.message : String(error)
          })
        );
      });
    const active = new Set<Promise<void>>();
    const start = (dispatch: NodeDispatch) => {
      const task = this.executeDispatch(dispatch, lifecycle).catch((error) => {
        console.error(
          JSON.stringify({
            level: "error",
            component: "adc-node",
            message: "task execution failed",
            dispatchId: dispatch.dispatchId,
            error: error instanceof Error ? error.message : String(error)
          })
        );
      });
      active.add(task);
      void task.finally(() => {
        active.delete(task);
        wake.notify();
      });
    };
    let errorDelay = 1_000;
    try {
      while (!lifecycle.aborted) {
        try {
          const claim = active.size < this.maxConcurrency;
          const dispatch = await this.pollForDispatch(active.size, claim);
          errorDelay = 1_000;
          if (dispatch) {
            start(dispatch);
            continue;
          }
          // A settings-only poll can raise the limit while all known slots are occupied.
          if (!claim && active.size < this.maxConcurrency) continue;
          await this.waitForWork(wake, this.options.pollIntervalMs ?? 30_000, lifecycle);
        } catch (error) {
          console.error(
            JSON.stringify({
              level: "error",
              component: "adc-node",
              message: error instanceof Error ? error.message : String(error)
            })
          );
          await wake.wait(errorDelay, lifecycle);
          errorDelay = Math.min(errorDelay * 2, 30_000);
        }
      }
    } finally {
      await wakeTask;
      await Promise.allSettled([...active]);
      await this.providers.close();
    }
  }

  stop(): void {
    this.shutdown.abort();
  }
}
