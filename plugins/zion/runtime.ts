import {
  ADC_ORIGIN,
  createSdkTransport,
  executeNativeTool,
  nativeTools,
  projectResult,
  type HarnessTransport
} from "../../packages/harness-core/src/index.ts";
import {
  principalKey,
  ScopedOAuthConnection,
  type OAuthState
} from "../../packages/harness-core/src/oauth.ts";

export const runtimePluginApiVersion = 2;

export async function activateRuntimePlugin(
  context: any,
  dependencies: { fetcher?: typeof fetch } = {}
) {
  const origin = String(context.config.serviceUrl ?? ADC_ORIGIN);
  const lifecycle = new AbortController();
  const locks = new Map<string, Promise<unknown>>();
  const registrations: any[] = [];
  const fetcher: typeof fetch = (url, init) =>
    (dependencies.fetcher ?? fetch)(url, {
      ...init,
      signal: AbortSignal.any([lifecycle.signal, ...(init?.signal ? [init.signal] : [])])
    });
  async function scoped<T>(
    call: any,
    operation: (store: any, oauth: ScopedOAuthConnection) => Promise<T>
  ) {
    const key = principalKey(call.principal);
    const previous = locks.get(key) ?? Promise.resolve();
    const namespace = context.state.namespace(`private.user-${key}`);
    const store = {
      async read(): Promise<OAuthState> {
        return (await namespace.read("connection")) ?? {};
      },
      async write(state: OAuthState) {
        await namespace.put("connection", state);
      }
    };
    const next = previous
      .catch(() => {})
      .then(async () => {
        if (lifecycle.signal.aborted) throw new Error("ADC plugin is stopped.");
        call.signal?.throwIfCancelled?.();
        const controller = new AbortController();
        const cancelled = call.signal?.onCancel?.(() => controller.abort());
        const scopedFetch: typeof fetch = (url, init) =>
          fetcher(url, {
            ...init,
            signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])])
          });
        try {
          return await operation(store, new ScopedOAuthConnection(store, origin, scopedFetch));
        } finally {
          cancelled?.dispose?.();
        }
      });
    locks.set(key, next);
    try {
      return await next;
    } finally {
      if (locks.get(key) === next) locks.delete(key);
    }
  }
  async function withTransport<T>(
    call: any,
    oauth: ScopedOAuthConnection,
    operation: (transport: HarnessTransport, signal: AbortSignal) => Promise<T>
  ) {
    const controller = new AbortController();
    const cancelled = call.signal?.onCancel?.(() => controller.abort());
    if (call.signal?.cancelled) controller.abort();
    let transport: HarnessTransport | undefined;
    try {
      transport = createSdkTransport(origin, await oauth.token(), fetcher);
      return await operation(transport, AbortSignal.any([controller.signal, lifecycle.signal]));
    } finally {
      cancelled?.dispose?.();
      transport?.dispose();
    }
  }
  const handler = async (args: any, call: any) =>
    scoped(call, async (store, oauth) => {
      if (args.action === "connect") {
        const allowedOrigins = [
          ...(context.config.redirectOrigins ?? []),
          ...(typeof call.origin === "string" ? [call.origin] : [])
        ];
        return oauth.begin(String(args.redirectUri ?? ""), allowedOrigins);
      }
      if (args.action === "finish")
        return oauth.finish(String(args.code ?? ""), String(args.state ?? ""));
      if (args.action === "disconnect") return oauth.disconnect();
      if (args.action === "select") {
        return withTransport(call, oauth, async (transport, signal) => {
          const discovery = await transport.discover(signal);
          if (!discovery.devices.some((device) => device.nodeId === args.nodeId))
            throw new Error("Choose a device from the current ADC connection.");
          await store.write({ ...(await store.read()), selectedNodeId: args.nodeId });
          return { selectedNodeId: args.nodeId };
        });
      }
      if (args.action !== "status") throw new Error("Unknown ADC sidebar command.");
      const state = (await store.read()) as OAuthState;
      const links = {
        devices: `${origin}/app/devices`,
        access: `${origin}/app/agents`,
        approvals: `${origin}/app/approvals`,
        teams: `${origin}/app/teams`,
        sharing: `${origin}/app/sharing`
      };
      if (!state.connection) return { connected: false, links, devices: [], tasks: [] };
      try {
        return await withTransport(call, oauth, async (transport, signal) => {
          const current = (await store.read()) as OAuthState;
          const tasks = await Promise.all(
            (current.tasks ?? []).map(async (task: any) =>
              ["queued", "running", "approval_required"].includes(task.status)
                ? projectResult(
                    await transport.task({ invocationId: task.invocationId, waitMs: 0 }, signal),
                    origin
                  )
                : task
            )
          );
          await store.write({ ...current, tasks });
          return {
            ...(await transport.status(signal)),
            ...(await transport.discover(signal)),
            selectedNodeId: current.selectedNodeId,
            tasks,
            links
          };
        });
      } catch {
        return {
          connected: false,
          links,
          devices: [],
          tasks: state.tasks ?? [],
          message:
            "ADC connection is unavailable. Reconnect ADC or refresh after the service recovers."
        };
      }
    });
  registrations.push(context.runs.registerCommands(handler));
  for (const definition of nativeTools) {
    const effect = ["adc_invoke", "adc_cancel"].includes(definition.name) ? "external" : "read";
    registrations.push(
      context.tools.registerTool({
        ...definition,
        policy: { minimumPreset: effect === "read" ? "read-only" : "trusted-automation" },
        execution: {
          effect,
          timeoutMs: 45_000,
          maxTimeoutMs: 45_000,
          cancellation: "cooperative",
          idempotency: effect === "read" ? "safe" : "reconcile"
        },
        async invoke(args: any, call: any) {
          return scoped(call, async (store, oauth) =>
            withTransport(call, oauth, async (transport, signal) => {
              const state = (await store.read()) as OAuthState;
              const input =
                ["adc_read", "adc_invoke"].includes(definition.name) &&
                !args.nodeId &&
                state.selectedNodeId
                  ? { ...args, nodeId: state.selectedNodeId }
                  : args;
              const result: any = await executeNativeTool(
                transport,
                definition.name,
                input,
                signal
              );
              if (result.invocationId) {
                const tasks = (state.tasks ?? []).filter(
                  (task: any) => task.invocationId !== result.invocationId
                );
                await store.write({ ...state, tasks: [result, ...tasks].slice(0, 30) });
              }
              return {
                ok: !["failed", "denied", "unknown_outcome"].includes(result.status),
                content: JSON.stringify(result)
              };
            })
          );
        }
      })
    );
  }
  return {
    dispose() {
      lifecycle.abort();
      for (const registration of registrations) registration?.dispose?.();
    }
  };
}
