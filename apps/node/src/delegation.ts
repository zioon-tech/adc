import {
  DelegationSchema, ProtocolError, absolutePathForToolArgs, rootForAbsolutePath,
  isBuiltinTool, isSideEffectTool, ReadOnlyTools, type Invocation, isDeviceRoot
} from "@adc/protocol";
import { assertNotSensitive, resolveResourcePath, type LocalRoot } from "@adc/tool-runtime";
import type { SharingConfig } from "./config.ts";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export async function validateLocalDelegation(
  invocation: Invocation, accountId: string | undefined, nodeId: string,
  roots: LocalRoot[], sharing: SharingConfig, isolationAvailable: boolean
) {
  const delegated = DelegationSchema.parse(invocation.delegation);
  const deny = () => new ProtocolError("denied", "Local device sharing permissions do not allow this request.", false);
  if (!sharing.enabled || !accountId || delegated.resourceAccountId !== accountId ||
      delegated.requesterAccountId !== invocation.accountId ||
      !("nodeId" in invocation.target) || invocation.target.nodeId !== nodeId ||
      Date.parse(delegated.expiresAt) <= Date.now() || !delegated.scope.allowedTools.includes(invocation.tool) ||
      invocation.tool === "file.transfer") throw deny();
  if (delegated.scope.execution === "trusted-host" && !sharing.trustedHost) throw deny();
  if (delegated.scope.execution === "isolated" && !isolationAvailable) throw deny();
  if (delegated.scope.execution === "read-only" &&
      (!isBuiltinTool(invocation.tool) || isSideEffectTool(invocation.tool) || !ReadOnlyTools.has(invocation.tool))) throw deny();
  for (const upper of delegated.scope.roots) {
    const local = roots.find((root) => root.rootId === upper.rootId && root.path === upper.path);
    if (!local || (upper.writable && !local.writable)) throw deny();
    if (isDeviceRoot(upper.path) && (delegated.bindingKind !== "team" || delegated.scope.execution === "isolated")) throw deny();
    assertNotSensitive(upper.path.replaceAll("\\", "/"));
    const canonical = await realpath(local.path);
    assertNotSensitive(canonical.replaceAll("\\", "/"));
    if (canonical !== resolve(local.path)) throw deny();
  }
  const scoped = delegated.scope.roots.map((root) => ({ ...root, allowSensitivePaths: false }));
  if (invocation.tool === "command.template.list") return scoped;
  const args = invocation.args as Record<string, unknown>;
  const absolute = absolutePathForToolArgs(invocation.tool, args);
  const rootId = typeof args.rootId === "string" ? args.rootId
    : absolute ? rootForAbsolutePath(absolute, scoped)?.rootId : undefined;
  const root = scoped.find((entry) => entry.rootId === rootId);
  if (!root) throw deny();
  if (typeof args.templateId === "string" && !delegated.scope.templateIds.includes(args.templateId)) throw deny();
  // The runtime also checks paths; checking here prevents full-trust bypasses.
  const relative = typeof args.path === "string" ? args.path : typeof args.cwd === "string" ? args.cwd : "";
  if (!absolute) await resolveResourcePath(root, relative, isSideEffectTool(invocation.tool) ? "write" : "read");
  return scoped;
}
