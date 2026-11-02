import { useEffect, useState, useCallback, useRef } from "react";
import { Link, useParams } from "react-router-dom";
import type { Accounts, DeviceShare, Invitation, Team, TeamMember, CollaborationScope } from "../../../packages/client/src/collaboration.ts";
import type { NodeRecord } from "./main.tsx";
import type { Request, User } from "./auth-ui.tsx";
import { Dialog, ConfirmAction } from "./dialog.tsx";
import { useI18n, type Message } from "./i18n.tsx";
import { isConsoleToolVisible } from "./file-transfer-visibility.ts";

type Props = { request: Request; revision: number; refresh: () => void; onError: (error: string) => void };
const id = encodeURIComponent;
const reads = ["device.list", "device.status", "file.list", "file.read", "file.search", "task.status", "task.result", "task.wait"];
const controls = new Set([...reads.filter(tool => !tool.startsWith("file.")), "task.cancel"]);
const toolLabels: Record<string, Message> = {
  "device.list": "List devices", "device.status": "Device status",
  "file.list": "List folders", "file.read": "Read files", "file.search": "Search files",
  "file.write": "Write files", "file.edit": "Edit files", "file.patch": "Patch files",
  "file.transfer": "Transfer files", "shell.exec": "Run commands",
  "command.template.list": "List templates", "command.template.run": "Run templates",
  "test.run": "Run tests", "task.status": "Task status", "task.result": "Task results",
  "task.wait": "Wait for tasks", "task.cancel": "Cancel tasks"
};
const post = (request: Request, path: string, body: unknown, method = "POST") =>
  request(path, { method, body: JSON.stringify(body) });
function chosenScope(scope: CollaborationScope | undefined): CollaborationScope {
  if (!scope || !scope.allowedTools.length) throw new Error("Choose at least one capability.");
  return scope;
}
const protectedFolders = new Set([".ssh", ".aws", ".gnupg", ".kube", ".npmrc", ".netrc", ".env", "credentials",
  ".adc", ".zion", ".config", ".git", "launchagents", "launchdaemons", "systemd"]);
const isWholeRoot = (path: string) => /^\/+$/.test(path) || /^[a-z]:[\\/]*$/i.test(path);
function shareableFolders(node: NodeRecord, teamAccess = false) {
  const capability = node.effectiveCapability ?? node.capability;
  return capability?.roots.flatMap(root => {
    const path = root.path ?? capability.collaboration?.roots?.find(entry => entry.rootId === root.rootId)?.path;
    if (!path || !teamAccess && isWholeRoot(path) ||
        path.split(/[\\/]/).some(part => protectedFolders.has(part.toLowerCase()) || part.toLowerCase().startsWith(".env."))) return [];
    return [{ ...root, path }];
  }) ?? [];
}

export function AccountSelector({ accounts, value, onChange }: { accounts?: Accounts | undefined; value: string; onChange: (accountId: string) => void }) {
  const { t } = useI18n();
  return <label className="account-selector">
    <span>{t("Workspace")}</span>
    <select value={value || accounts?.personalAccountId || ""} disabled={!accounts} onChange={e => onChange(e.target.value)}>
      <option value={accounts?.personalAccountId || ""}>{t("Personal account")}</option>
      {accounts?.teams.map(team => <option key={team.accountId} value={team.accountId}>{team.name}</option>)}
    </select>
  </label>;
}

function ScopeSummary({ scope }: { scope: CollaborationScope }) {
  const { t } = useI18n();
  return <div className="scope-summary">
    <strong>{t(scope.execution === "read-only" ? "Read only" : scope.execution === "isolated" ? "Isolated execution" : "Trusted host access")}</strong>
    <p className="hint">{scope.roots.map(root => `${root.path} (${t(root.writable ? "Write" : "Read")})`).join(" · ") || t("No folders selected")}</p>
    <p className="hint">{scope.allowedTools.join(", ")}</p>
    <p className="hint">{t("Approvals")}: {t(scope.approvalPolicy === "never" ? "No approval" : scope.approvalPolicy === "writes" ? "Before changes or execution" : scope.approvalPolicy === "execute" ? "Before execution" : "Every device operation")}</p>
    {scope.templateIds.length ? <p className="hint">{t("Allowed template IDs")}: {scope.templateIds.join(", ")}</p> : null}
  </div>;
}

function ScopeEditor({ node, initial, onChange, teamAccess = false }: { node: NodeRecord; initial?: CollaborationScope; teamAccess?: boolean; onChange: (scope: CollaborationScope, trust: boolean) => void }) {
  const { t } = useI18n();
  const cap = node.effectiveCapability ?? node.capability;
  const [execution, setExecution] = useState<CollaborationScope["execution"]>(initial?.execution ?? "read-only");
  const allowedExecution = execution === "trusted-host" && !cap?.collaboration?.trustedHost ||
    execution === "isolated" && (!cap?.collaboration?.isolation || cap.collaboration.isolation === "none") ? "read-only" : execution;
  const folders = shareableFolders(node, teamAccess).filter(root => allowedExecution !== "isolated" || !isWholeRoot(root.path));
  const [rootIds, setRootIds] = useState(initial?.roots.map(root => root.rootId) ?? []);
  const [writable, setWritable] = useState(initial?.roots.filter(root => root.writable).map(root => root.rootId) ?? []);
  const [tools, setTools] = useState(initial?.allowedTools ?? reads.filter(tool => controls.has(tool) || cap?.tools.some(entry => entry.name === tool)));
  const [approval, setApproval] = useState<CollaborationScope["approvalPolicy"]>(initial?.approvalPolicy ?? "never");
  const [trust, setTrust] = useState(false);
  const [templates, setTemplates] = useState(initial?.templateIds.join(", ") ?? "");
  const permittedTools = cap?.tools.filter(tool => allowedExecution === "read-only" ? reads.includes(tool.name) : allowedExecution === "isolated" ? !tool.name.startsWith("mcp.") : true) ?? [];
  const constraints = JSON.stringify({ execution: allowedExecution,
    roots: folders.filter(root => !isWholeRoot(root.path) || cap?.collaboration?.features?.includes("team-root-sharing")).map(root => ({ rootId: root.rootId, path: root.path, writable: root.writable })),
    tools: [...controls, ...permittedTools.map(tool => tool.name)] });
  const rootPaths = useRef(new Map(folders.map(root => [root.rootId, root.path])));
  useEffect(() => {
    const current = JSON.parse(constraints) as { execution: CollaborationScope["execution"]; roots: Array<{ rootId: string; path: string; writable: boolean }>; tools: string[] };
    const keep = (previous: string[], next: string[]) => previous.length === next.length && previous.every((item, index) => item === next[index]) ? previous : next;
    setExecution(current.execution);
    const retargeted = new Set(current.roots.filter(root => rootPaths.current.has(root.rootId) && rootPaths.current.get(root.rootId) !== root.path).map(root => root.rootId));
    setRootIds(previous => keep(previous, previous.filter(rootId => !retargeted.has(rootId) && current.roots.some(root => root.rootId === rootId))));
    setWritable(previous => keep(previous, previous.filter(rootId => current.roots.some(root => root.rootId === rootId && root.writable))));
    setTools(previous => keep(previous, previous.filter(tool => current.tools.includes(tool))));
    rootPaths.current = new Map(current.roots.map(root => [root.rootId, root.path]));
  }, [constraints]);
  useEffect(() => {
    onChange({
      roots: folders.filter(root => rootIds.includes(root.rootId)).map(root => ({
        rootId: root.rootId, path: root.path, writable: allowedExecution !== "read-only" && root.writable && writable.includes(root.rootId)
      })),
      execution: allowedExecution, approvalPolicy: approval, templateIds: templates.split(",").map(value => value.trim()).filter(Boolean),
      allowedTools: [...new Set(tools.filter(tool => controls.has(tool) || permittedTools.some(entry => entry.name === tool)))]
    }, allowedExecution === "trusted-host" && trust);
  }, [constraints, rootIds, writable, tools, approval, trust, templates, onChange]);
  const toggle = (items: string[], value: string) => items.includes(value) ? items.filter(item => item !== value) : [...items, value];
  return <div className="scope-editor">
    <label>{t("Access mode")}<select value={execution} onChange={e => setExecution(e.target.value as typeof execution)}>
      <option value="read-only">{t("Read only")}</option>
      {cap?.collaboration?.isolation !== "none" && cap?.collaboration?.isolation ? <option value="isolated">{t("Isolated execution")}</option> : null}
      {cap?.collaboration?.trustedHost ? <option value="trusted-host">{t("Trusted host access")}</option> : null}
    </select></label>
    {execution === "isolated" ? <p className="hint">{t("Commands run without network access in a temporary container. Changes stay there; download artifacts to keep results.")}</p> : null}
    {execution === "trusted-host" ? <label className="check-label"><input type="checkbox" checked={trust} onChange={e => setTrust(e.target.checked)} />{t("I trust this person with host access. Revoking ADC access cannot remove other access or changes they created.")}</label> : null}
    <fieldset><legend>{t("Folders")}</legend>
      {folders.map(root => <div className="scope-folder" key={root.rootId}>
        <label className="check-label"><input type="checkbox" checked={rootIds.includes(root.rootId)} disabled={isWholeRoot(root.path) && !cap?.collaboration?.features?.includes("team-root-sharing")} onChange={() => setRootIds(toggle(rootIds, root.rootId))} /><code>{root.path}</code>{isWholeRoot(root.path) ? <span>{t("Device root")}</span> : null}</label>
        {execution !== "read-only" && root.writable && rootIds.includes(root.rootId) ? <label className="check-label"><input type="checkbox" checked={writable.includes(root.rootId)} onChange={() => setWritable(toggle(writable, root.rootId))} />{t("Write")}</label> : null}
      </div>)}
      {!folders.length ? <p className="hint">{t("Expose a project folder on the device before sharing.")}</p> : null}
      {teamAccess ? <p className="hint">{t("You can select an exposed device root for the team. Member policies and Agent grants still limit access.")}</p> : <p className="hint">{t("External sharing uses selected folders. Choose a team to share a device root.")}</p>}
      {teamAccess && execution === "isolated" ? <p className="hint">{t("For isolated execution, choose a smaller folder instead of a whole-device snapshot.")}</p> : null}
    </fieldset>
    <fieldset><legend>{t("Capabilities")}</legend><div className="scope-tools">
      {[...new Map([...reads.filter(tool => controls.has(tool)).map(name => ({ name })), ...permittedTools].map(tool => [tool.name, tool])).values()]
        .filter(tool => isConsoleToolVisible(tool.name) || tools.includes(tool.name)).map(tool =>
        <label className="check-label" key={tool.name}><input type="checkbox" checked={tools.includes(tool.name)} onChange={() => setTools(toggle(tools, tool.name))} /><span className="scope-tool-name">{toolLabels[tool.name] ? t(toolLabels[tool.name]!) : "title" in tool && typeof tool.title === "string" ? tool.title : tool.name}<small>{tool.name}</small></span></label>)}
    </div></fieldset>
    <label>{t("Approvals")}<select value={approval} onChange={e => setApproval(e.target.value as typeof approval)}>
      <option value="never">{t("No approval")}</option><option value="writes">{t("Before changes or execution")}</option>
      <option value="execute">{t("Before execution")}</option><option value="always">{t("Every device operation")}</option>
    </select></label>
    {tools.some(tool => tool === "command.template.run" || tool === "test.run") ? <label>{t("Allowed template IDs")}<input value={templates} onChange={e => setTemplates(e.target.value)} placeholder={t("Comma-separated IDs")} /></label> : null}
  </div>;
}

export function ShareDialog({ node, request, onClose, onSaved, teams, initial }: {
  node: NodeRecord; request: Request; onClose: () => void; onSaved: () => void; teams: Team[]; initial?: DeviceShare
}) {
  const { t } = useI18n();
  const [device, setDevice] = useState(node);
  const [teamId, setTeamId] = useState("");
  const teamAccess = initial?.kind === "team" || !!teamId;
  const capability = device.effectiveCapability ?? device.capability;
  const ready = capability?.collaboration?.version === 1;
  const version = capability?.nodeVersion ?? "";
  const needsUpgrade = !version || Number(version.split(".")[0]) === 0 &&
    (Number(version.split(".")[1]) < 1 || Number(version.split(".")[1]) === 1 && Number(version.split(".")[2]) < 5);
  const folders = shareableFolders(device, teamAccess);
  const rootUpgrade = teamAccess && folders.some(root => isWholeRoot(root.path)) && !capability?.collaboration?.features?.includes("team-root-sharing");
  const [downloadUrl, setDownloadUrl] = useState<string>();
  const scopeChanged = useCallback((next: CollaborationScope, acknowledged: boolean) => { setScope(next); setTrust(acknowledged); }, []);
  useEffect(() => {
    let active = true, loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const [result, installation] = await Promise.all([request("/api/v1/nodes"), request("/api/v1/node-installation")]);
        const current = result.nodes.find((candidate: NodeRecord) => candidate.nodeId === node.nodeId);
        if (active && current) setDevice(current);
        if (active) setDownloadUrl(installation.available ? installation.downloadUrl : undefined);
      } catch (error) { if (active) setError((error as Error).message); }
      finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [request, node.nodeId]);
  const [scope, setScope] = useState<CollaborationScope>();
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [link, setLink] = useState("");
  const updateCommand = downloadUrl ? `adc update --download-url '${downloadUrl.replaceAll("'", "'\\''")}'` : undefined;
  const windowsUpdateCommand = downloadUrl ? `adc update --download-url '${downloadUrl.replaceAll("'", "''")}'` : undefined;
  return <Dialog title={t(initial ? "Edit sharing permission" : "Share device")} busy={busy} onClose={onClose} className="share-dialog">
    <p className="description">{device.label} · {t(teamAccess ? "Team members use this device through their assigned policies." : "Only the chosen account can accept this invitation.")}</p>
    {!ready ? <div className="notice" role="status">
      <strong>{t(needsUpgrade ? "Update this device's Connector to 0.1.5 or newer before sharing." : "Enable local sharing on this device before continuing.")}</strong>
      <p>{t("Current Connector: {version}", { version: version || t("Unavailable") })}</p>
      <p>{t("Run this command on the device. This dialog updates automatically.")}</p>
      {needsUpgrade ? <code>{(device.platform === "win32" ? windowsUpdateCommand : updateCommand) ?? t("Loading…")}</code> : <code>adc-node sharing on</code>}
    </div> : null}
    {rootUpgrade ? <div className="notice" role="status"><p>{t("Update this device to Connector 0.1.6 or newer to share its root with a team.")}</p><code>{(device.platform === "win32" ? windowsUpdateCommand : updateCommand) ?? t("Loading…")}</code></div> : null}
    {ready && !folders.length ? <div className="notice" role="status">
      <p>{t(teamAccess ? "Expose a folder or device root locally before sharing it with the team." : "External sharing uses selected folders. Choose a team to share a device root.")}</p>
      <code>adc-node roots add "/path/to/project" --label Project</code>
    </div> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {link ? <div className="invitation-result" role="status"><p>{t("Invitation created. Send this link to the recipient.")}</p><input aria-label={t("Invitation link")} readOnly value={link} onFocus={e => e.target.select()} /><div className="row-actions"><button className="secondary" onClick={() => navigator.clipboard.writeText(link).catch(() => setError(t("Copy the invitation link manually.")))}>{t("Copy")}</button><button className="primary" onClick={onClose}>{t("Done")}</button></div></div> :
      <form className="sharing-form" onSubmit={async e => {
        e.preventDefault();
        setBusy(true); setError("");
        try {
          const checked = chosenScope(scope);
          if (!ready) throw new Error(t(needsUpgrade ? "Update this device's Connector to 0.1.5 or newer before sharing." : "Enable local sharing on this device before continuing."));
          if (!checked.roots.length) throw new Error(t("Choose at least one exposed folder or root."));
          if (checked.roots.some(root => isWholeRoot(root.path)) && rootUpgrade) throw new Error(t("Update this device to Connector 0.1.6 or newer to share its root with a team."));
          if (checked.execution === "trusted-host" && !trust) throw new Error(t("Confirm host trust before continuing."));
          const data = new FormData(e.currentTarget);
          const input = { nodeId: node.nodeId, scope: checked, acknowledgeHostTrust: trust };
          const result = initial ? await post(request, `/api/v1/device-shares/${id(initial.bindingId)}`, {
            revision: initial.revision, scope: checked, acknowledgeHostTrust: trust,
            expiresAt: data.get("expiresAt") ? new Date(String(data.get("expiresAt"))).toISOString() : null
          }, "PATCH") : teamId ? await post(request, `/api/v1/teams/${id(teamId)}/devices`, input) :
            await post(request, `/api/v1/nodes/${id(node.nodeId)}/share-invitations`, {
              email: data.get("email"), scope: checked, acknowledgeHostTrust: trust, durationDays: Number(data.get("days"))
            });
          onSaved();
          if (result.invitation) {
            setLink(result.link ?? `${window.location.origin}/invitations/${result.invitation.invitationId}#${result.token}`);
          } else onClose();
        } catch (error) { setError((error as Error).message); }
        finally { setBusy(false); }
      }}>
        {!initial ? <fieldset disabled={busy}><legend>{t("Share with")}</legend><label>{t("Recipient")}<select value={teamId} onChange={e => setTeamId(e.target.value)}><option value="">{t("External user")}</option>{teams.filter(team => team.membership.role !== "member").map(team => <option key={team.accountId} value={team.accountId}>{team.name}</option>)}</select></label>
          {!teamId ? <div className="form-grid"><label>{t("Recipient email")}<input name="email" type="email" required maxLength={320} /></label><label>{t("Expires in")}<select name="days" defaultValue="30">{[1, 7, 30, 90, 365].map(days => <option key={days} value={days}>{t("{days} days", { days })}</option>)}</select></label></div> : null}</fieldset> : null}
        {initial ? <label>{t("Sharing expires")}<input name="expiresAt" type="datetime-local" defaultValue={initial.expiresAt ? new Date(Date.parse(initial.expiresAt) - new Date(initial.expiresAt).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ""} /><span className="hint">{t("Leave empty for no expiry. Wider access requires acceptance.")}</span></label> : null}
        <fieldset disabled={busy}><legend>{t("Permissions")}</legend><ScopeEditor node={device} teamAccess={teamAccess} {...(initial ? { initial: initial.scope } : {})} onChange={scopeChanged} /></fieldset>
        <div className="dialog-actions"><button className="secondary" type="button" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className="primary" disabled={busy || !ready || !scope?.roots.length || (scope.execution === "trusted-host" && !trust)}>{busy ? t("Please wait…") : t(initial ? "Save changes" : teamId ? "Add device to team" : "Create invitation")}</button></div>
      </form>}
  </Dialog>;
}

export function InvitationPage({ request, refresh, invitationId: selectedId, onClose }: {
  request: Request; refresh: () => void; invitationId?: string; onClose?: () => void
}) {
  const params = useParams();
  const invitationId = selectedId ?? params.invitationId!;
  const { t, date } = useI18n();
  const [invitation, setInvitation] = useState<Invitation>();
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [done, setDone] = useState("");
  const token = selectedId ? undefined : window.location.hash.slice(1) || undefined;
  useEffect(() => {
    let active = true;
    request(`/api/v1/share-invitations/${id(invitationId)}${token ? `?token=${id(token)}` : ""}`).then(result => { if (active) setInvitation(result); }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [request, invitationId, token]);
  const content = <>
    <p className="description">{t("Accept only after reviewing the account, device and permissions below.")}</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {done ? <p className="notice" role="status">{done} <Link to="/app/agents">{t("Manage agent access")}</Link></p> : invitation ? <>
      <dl className="invitation-details"><dt>{t("Recipient email")}</dt><dd>{invitation.recipientEmail}</dd><dt>{t("From account")}</dt><dd><code>{invitation.senderAccountId}</code></dd>
        <dt>{t(invitation.kind === "member" ? "Team" : "Device")}</dt><dd>{invitation.teamName ?? invitation.nodeLabel} <code>{invitation.teamAccountId ?? invitation.nodeId}</code></dd>
        {invitation.role ? <><dt>{t("Role")}</dt><dd>{t(invitation.role === "admin" ? "Admin" : "Member")}</dd></> : null}
        <dt>{t("Invitation expires")}</dt><dd>{date(invitation.expiresAt)}</dd>
        {invitation.kind !== "member" ? <><dt>{t("Sharing expires")}</dt><dd>{invitation.kind === "scope" ? invitation.bindingExpiresAt ? date(invitation.bindingExpiresAt) : t("No expiry") : invitation.durationDays == null ? t("No expiry") : t("{days} days", { days: invitation.durationDays })}</dd></> : null}
      </dl>
      {invitation.scope ? <ScopeSummary scope={invitation.scope} /> : null}
      {invitation.scope?.execution === "trusted-host" ? <p className="hint">{t("Host access changes may remain after ADC access is revoked.")}</p> : null}
      {invitation.kind !== "member" ? <p className="hint">{t("Accepting does not expand existing Agent access. Create or edit an authorization to use this device.")}</p> : null}
      <div className="row-actions dialog-actions">{(["accept", "decline"] as const).map(decision => <button key={decision} className={decision === "accept" ? "primary" : "secondary"} disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try { await post(request, `/api/v1/share-invitations/${id(invitationId)}/${decision}`, { revision: invitation.revision, ...(token ? { token } : {}) }); setDone(t(decision === "accept" ? "Invitation accepted." : "Invitation declined.")); refresh(); }
        catch (error) { setError((error as Error).message); }
        finally { setBusy(false); }
      }}>{t(decision === "accept" ? "Accept" : "Decline")}</button>)}</div>
    </> : !error ? <p role="status">{t("Loading…")}</p> : null}
  </>;
  return onClose ? <Dialog title={t("Review invitation")} onClose={onClose} busy={busy}>{content}</Dialog> : <section className="page"><h1>{t("Review invitation")}</h1>{content}</section>;
}

export function Sharing({ request, revision, refresh, onError, accounts, user, team }: Props & { accounts?: Accounts | undefined; user: User; team?: Team | undefined }) {
  const { t, date } = useI18n();
  const [received, setReceived] = useState<DeviceShare[]>([]), [owned, setOwned] = useState<DeviceShare[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]), [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [review, setReview] = useState<string>(), [edit, setEdit] = useState<DeviceShare>();
  const [action, setAction] = useState<{ title: string; run: () => Promise<unknown> }>(), [activity, setActivity] = useState<Array<{ invocation_id: string; delegation: { requesterAccountId: string }; node_id: string; tool: string; status: string }>>([]);
  const manager = !team || team.membership.role !== "member";
  useEffect(() => {
    let active = true;
    Promise.all([
      request("/api/v1/device-shares"), request("/api/v1/share-invitations"), request("/api/v1/nodes"),
      manager ? request("/api/v1/device-shares?direction=owned") : Promise.resolve({ shares: [] }),
      manager ? request("/api/v1/device-shares/activity") : Promise.resolve({ activity: [] })
    ]).then(([r, i, n, o, a]) => { if (active) { setReceived(r.shares); setInvitations(i.invitations); setNodes(n.nodes); setOwned(o.shares); setActivity(a.activity); } }).catch(error => { if (active) onError(error.message); });
    return () => { active = false; };
  }, [request, revision, manager, onError]);
  const change = (title: string, run: () => Promise<unknown>) => setAction({ title, run });
  const shareRows = (shares: DeviceShare[], direction: "owned" | "received") => <div className="resource-list">{shares.map(share => <div className="resource-row" key={share.bindingId}><div>
    <strong>{nodes.find(node => node.nodeId === share.nodeId)?.label ?? share.nodeId}</strong><p className="hint">{t(share.state === "active" ? "Active" : share.state === "paused" ? "Paused" : "Revoked")} · {share.expiresAt ? date(share.expiresAt) : t("No expiry")}</p><ScopeSummary scope={share.scope} />
    <p className="hint">{t(direction === "owned" ? "Shared with account" : "From account")} <code>{direction === "owned" ? share.recipientAccountId : share.resourceAccountId}</code></p>
  </div><div className="row-actions">{share.state !== "revoked" ? direction === "owned" ? <>
    <button className="secondary" disabled={!nodes.some(node => node.nodeId === share.nodeId)} onClick={() => setEdit(share)}>{t("Edit")}</button>
    <button className="secondary" onClick={() => change(t(share.state === "paused" ? "Resume sharing?" : "Pause sharing?"), () => post(request, `/api/v1/device-shares/${id(share.bindingId)}`, { revision: share.revision, state: share.state === "paused" ? "active" : "paused" }, "PATCH"))}>{t(share.state === "paused" ? "Resume" : "Pause")}</button>
    <button className="secondary danger" onClick={() => change(t("Revoke sharing?"), () => post(request, `/api/v1/device-shares/${id(share.bindingId)}/revoke`, { revision: share.revision }))}>{t("Revoke")}</button>
  </> : manager ? <button className="secondary" onClick={() => change(t("Leave shared device?"), () => post(request, `/api/v1/device-shares/${id(share.bindingId)}/leave`, { revision: share.revision }))}>{t("Leave")}</button> : null : null}</div></div>)}{!shares.length ? <p className="empty">{t("No shared devices")}</p> : null}</div>;
  return <section className="page"><div className="page-header"><h1>{t("Sharing")}</h1><Link className="secondary" to="/app/devices">{t("Share a device")}</Link></div>
    <h2>{t("Invitations")}</h2><div className="resource-list">{invitations.map(invitation => {
      const incoming = invitation.targetUserId ? invitation.targetUserId === user.id : invitation.recipientEmail.toLowerCase() === user.email.toLowerCase();
      return <div className="resource-row" key={invitation.invitationId}><div><strong>{t(invitation.kind === "member" ? "Team invitation" : invitation.kind === "scope" ? "Permission change" : "Device invitation")}</strong><p className="hint">{invitation.recipientEmail} · {date(invitation.expiresAt)} · {invitation.state}</p></div>
        {invitation.state === "pending" && Date.parse(invitation.expiresAt) > Date.now() ? incoming ? <button className="secondary" onClick={() => setReview(invitation.invitationId)}>{t("Review")}</button> : manager ? <button className="secondary danger" onClick={() => change(t("Revoke invitation?"), () => post(request, `/api/v1/share-invitations/${id(invitation.invitationId)}/revoke`, { revision: invitation.revision }))}>{t("Revoke")}</button> : null : null}</div>;
    })}{!invitations.length ? <p className="empty">{t("No invitations")}</p> : null}</div>
    <h2>{t("Shared with me")}</h2>{shareRows(received, "received")}
    {manager ? <><h2>{t("Shared by this account")}</h2>{shareRows(owned, "owned")}<h2>{t("Shared device activity")}</h2><div className="resource-list">{activity.map(entry => <div className="resource-row" key={entry.invocation_id}><div><strong>{entry.tool}</strong><p className="hint">{entry.node_id} · {entry.delegation.requesterAccountId}</p></div><span>{entry.status}</span></div>)}{!activity.length ? <p className="empty">{t("No activity")}</p> : null}</div></> : null}
    {review ? <InvitationPage invitationId={review} request={request} refresh={refresh} onClose={() => setReview(undefined)} /> : null}
    {edit && nodes.find(node => node.nodeId === edit.nodeId) ? <ShareDialog node={nodes.find(node => node.nodeId === edit.nodeId)!} initial={edit} teams={accounts?.teams ?? []} request={request} onSaved={refresh} onClose={() => setEdit(undefined)} /> : null}
    {action ? <ConfirmAction title={action.title} description={t("New calls stop using removed permissions. Running tasks are checked on their next lease renewal.")} actionLabel={t("Confirm")} onClose={() => setAction(undefined)} onConfirm={async () => { await action.run(); refresh(); }} /> : null}
  </section>;
}

export function Teams({ request, revision, refresh, onError, accounts, selected, select }: Props & { accounts?: Accounts | undefined; selected?: Team | undefined; select: (accountId: string) => void }) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false), [inviting, setInviting] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [link, setLink] = useState("");
  const [members, setMembers] = useState<TeamMember[]>([]), [nodes, setNodes] = useState<NodeRecord[]>([]), [editing, setEditing] = useState<TeamMember>();
  const [action, setAction] = useState<{ title: string; run: () => Promise<unknown> }>();
  const manager = selected && selected.membership.role !== "member";
  useEffect(() => {
    let active = true; setMembers([]); setNodes([]);
    if (manager) Promise.all([request(`/api/v1/teams/${id(selected.accountId)}/members`), request(`/api/v1/teams/${id(selected.accountId)}/devices`)])
      .then(([m, n]) => { if (active) { setMembers(m.members); setNodes(n.nodes); } }).catch(error => { if (active) onError(error.message); });
    return () => { active = false; };
  }, [request, selected?.accountId, manager, revision, onError]);
  return <section className="page"><div className="page-header"><h1>{t("Teams")}</h1><button className="primary" onClick={() => { setError(""); setLink(""); setCreating(true); }}>{t("Create team")}</button></div>
    <div className="resource-list">{accounts?.teams.map(team => <div className="resource-row" key={team.accountId}><div><strong>{team.name}</strong><p className="hint">{t(team.membership.role === "owner" ? "Owner" : team.membership.role === "admin" ? "Admin" : "Member")}</p></div><button className="secondary" disabled={selected?.accountId === team.accountId} onClick={() => select(team.accountId)}>{t(selected?.accountId === team.accountId ? "Selected" : "Open team")}</button></div>)}</div>
    {selected ? <><div className="page-header"><h2>{selected.name}</h2>{manager ? <button className="secondary" onClick={() => { setError(""); setLink(""); setInviting(true); }}>{t("Invite member")}</button> : null}</div>
      <p className="description">{t("Members receive only the devices and permissions assigned to them. They authorize their own Agents separately.")}</p>
      {manager ? <div className="resource-list">{members.map(member => <div className="resource-row" key={member.userId}><div><strong>{member.name || member.email || member.userId}</strong><p className="hint">{member.email} · {member.role} · {member.state}</p><p className="hint">{member.rules.map(rule => nodes.find(node => node.nodeId === rule.nodeId)?.label ?? rule.nodeId).join(", ") || t("No device policy assigned")}</p></div>
        {member.state === "active" && (selected.membership.role === "owner" || member.role === "member") ? <div className="row-actions"><button className="secondary" onClick={() => setEditing(member)}>{t("Edit policy")}</button>{member.role !== "owner" ? <button className="secondary danger" onClick={() => setAction({ title: t("Remove member?"), run: () => post(request, `/api/v1/teams/${id(selected.accountId)}/members/${id(member.userId)}`, { revision: member.revision, role: member.role, state: "removed", rules: [] }, "PATCH") })}>{t("Remove")}</button> : null}</div> : null}</div>)}</div> : null}
      {selected.membership.role !== "owner" ? <button className="secondary danger" onClick={() => setAction({ title: t("Leave team?"), run: () => post(request, `/api/v1/teams/${id(selected.accountId)}/leave`, { revision: selected.membership.revision }) })}>{t("Leave team")}</button> : null}
    </> : <p className="description">{t("Choose a team above, or create one to manage collaboration.")}</p>}
    {creating || inviting ? <Dialog title={t(creating ? "Create team" : "Invite member")} busy={busy} onClose={() => { setCreating(false); setInviting(false); }}>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {link ? <><p role="status">{t("Invitation created. Send this link to the recipient.")}</p><input aria-label={t("Invitation link")} readOnly value={link} onFocus={e => e.target.select()} /></> : <form onSubmit={async e => {
        e.preventDefault(); const data = new FormData(e.currentTarget); setBusy(true); setError("");
        try {
          const result = creating ? await post(request, "/api/v1/teams", { name: data.get("name") }) : await post(request, `/api/v1/teams/${id(selected!.accountId)}/invitations`, { email: data.get("email"), role: data.get("role") });
          refresh(); if (creating) { setCreating(false); select(result.accountId); } else setLink(result.link);
        } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
      }}>{creating ? <label>{t("Team name")}<input name="name" required maxLength={128} /></label> : <><label>{t("Recipient email")}<input name="email" type="email" required maxLength={320} /></label><label>{t("Role")}<select name="role"><option value="member">{t("Member")}</option>{selected?.membership.role === "owner" ? <option value="admin">{t("Admin")}</option> : null}</select></label></>}<div className="dialog-actions"><button className="primary" disabled={busy}>{t(creating ? "Create team" : "Create invitation")}</button></div></form>}
    </Dialog> : null}
    {editing && selected ? <MemberPolicy member={editing} team={selected} nodes={nodes} request={request} onClose={() => setEditing(undefined)} onSaved={refresh} /> : null}
    {action ? <ConfirmAction title={action.title} description={t("Removing membership revokes that member's Agent connections and device access.")} actionLabel={t("Confirm")} onClose={() => setAction(undefined)} onConfirm={async () => { await action.run(); refresh(); }} /> : null}
  </section>;
}

function MemberPolicy({ member, team, nodes, request, onClose, onSaved }: { member: TeamMember; team: Team; nodes: NodeRecord[]; request: Request; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [rules, setRules] = useState(member.rules), [role, setRole] = useState(member.role);
  const [selected, setSelected] = useState(""), [scope, setScope] = useState<CollaborationScope>(), [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const scopeChanged = useCallback((next: CollaborationScope, accepted: boolean) => { setScope(next); setTrust(accepted); }, []);
  const node = nodes.find(node => node.nodeId === selected);
  return <Dialog title={t("Edit member policy")} onClose={onClose} busy={busy} wide><p className="description">{member.name || member.email}</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <label>{t("Role")}<select value={role} disabled={member.role === "owner" || team.membership.role !== "owner"} onChange={e => setRole(e.target.value as typeof role)}>
      {member.role === "owner" ? <option value="owner">{t("Owner")}</option> : <><option value="member">{t("Member")}</option><option value="admin">{t("Admin")}</option></>}
    </select></label>
    <div className="resource-list">{rules.map(rule => <div className="resource-row" key={rule.nodeId}><div><strong>{nodes.find(node => node.nodeId === rule.nodeId)?.label ?? rule.nodeId}</strong><ScopeSummary scope={rule.scope} /></div><div className="row-actions"><button className="secondary" onClick={() => { setSelected(rule.nodeId); setScope(undefined); }}>{t("Edit")}</button><button className="secondary danger" onClick={() => setRules(rules.filter(entry => entry.nodeId !== rule.nodeId))}>{t("Remove")}</button></div></div>)}</div>
    <label>{t("Device policy")}<select value={selected} onChange={e => { setSelected(e.target.value); setScope(undefined); }}><option value="">{t("Choose a device")}</option>{nodes.map(node => <option key={node.nodeId} value={node.nodeId}>{node.label}</option>)}</select></label>
    {node ? <><ScopeEditor key={node.nodeId} node={node} teamAccess {...(rules.find(rule => rule.nodeId === selected) ? { initial: rules.find(rule => rule.nodeId === selected)!.scope } : {})} onChange={scopeChanged} /><button className="secondary" disabled={!scope || scope.execution === "trusted-host" && !trust} onClick={() => {
      try { const checked = chosenScope(scope); setRules([...rules.filter(rule => rule.nodeId !== selected), { nodeId: selected, scope: checked }]); setSelected(""); } catch (error) { setError((error as Error).message); }
    }}>{t("Apply device policy")}</button></> : null}
    {rules.some(rule => rule.scope.execution === "trusted-host") ? <label className="check-label"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />{t("I trust this person with host access. Revoking ADC access cannot remove other access or changes they created.")}</label> : null}
    <div className="dialog-actions"><button className="primary" disabled={busy || !!selected || rules.some(rule => rule.scope.execution === "trusted-host") && !acknowledged} onClick={async () => {
      setBusy(true); setError("");
      try { await post(request, `/api/v1/teams/${id(team.accountId)}/members/${id(member.userId)}`, { revision: member.revision, state: "active", role, rules, acknowledgeHostTrust: acknowledged }, "PATCH"); onSaved(); onClose(); }
      catch (error) { setError((error as Error).message); } finally { setBusy(false); }
    }}>{t("Save changes")}</button></div>
  </Dialog>;
}
