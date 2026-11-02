import { useEffect, useState, type FormEvent } from "react";
import { CirclePlus, FolderRoot, Pencil, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import type { Project, ProjectRoot, AgentAccess } from "../../../packages/client/src/index.ts";
import type { Team } from "../../../packages/client/src/collaboration.ts";
import type { Request } from "./auth-ui.tsx";
import type { NodeRecord } from "./main.tsx";
import { ConfirmAction, Dialog } from "./dialog.tsx";
import { useI18n } from "./i18n.tsx";

type Editor = { kind: "create" } | { kind: "rename"; project: Project } | { kind: "add"; project: Project } |
  { kind: "edit"; project: Project; root: ProjectRoot };
type Removal = { project: Project; root?: ProjectRoot };
const id = encodeURIComponent;
const projectUrl = (project: Project) => `/api/v1/projects/${id(project.projectId)}`;
const agentUrl = (project: Project) => `/app/agents?project=${id(project.projectId)}&authorize=1`;

export function Projects({ request, revision, refresh, onError, selectedTeam }: {
  request: Request; revision: number; refresh: () => void; onError: (message: string) => void;
  selectedTeam?: Team | undefined;
}) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<Project[]>([]);
  const [roots, setRoots] = useState<ProjectRoot[]>([]);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [grants, setGrants] = useState<AgentAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<Editor>();
  const [removal, setRemoval] = useState<Removal>();
  useEffect(() => {
    if (selectedTeam) return;
    let active = true;
    setLoading(true);
    Promise.all([request("/api/v1/projects?include=roots"), request("/api/v1/nodes"), request("/api/v1/grants")])
      .then(([p, n, g]) => {
        if (active) { setProjects(p.projects); setRoots(p.roots); setNodes(n.nodes); setGrants(g.grants); }
      }).catch(error => { if (active) onError(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, revision, onError, selectedTeam]);
  const activeGrants = grants.filter(g => !g.revokedAt);
  const dependencies = (project: Project, root?: ProjectRoot) =>
    activeGrants.filter(g => g.projectId === project.projectId && (!root || g.rootIds.includes(root.rootId)));
  const visible = projects.filter(p => p.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()) ||
    roots.some(r => r.projectId === p.projectId && `${r.label} ${r.path ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())));

  return <section className="page">
    <div className="page-header"><div><h1>{t("Projects & folders")}</h1>{!selectedTeam ? <span className="count">{projects.length}</span> : null}</div>
      {!selectedTeam ? <button className="primary" disabled={loading} onClick={() => setEditor({ kind: "create" })}><CirclePlus size={16} />{t("New project")}</button> : null}
    </div>
    <div className="project-guide">
      <p className="description">{t(selectedTeam ? "Team devices are managed through member permissions and Agent access." :
        "Group exposed device folders into a project, then select that project when authorizing an Agent.")}</p>
      {!selectedTeam ? <p className="hint">{t("Folders stay on their devices. Adding one here does not upload files or grant Agent access.")}</p> : null}
      <Link to="/app/agents">{t("Open Agent access")}</Link>
    </div>
    {!selectedTeam ? <>
      {projects.length > 0 ? <div className="resource-toolbar"><input type="search" aria-label={t("Search projects or folders")} placeholder={t("Search projects or folders")} value={search} onChange={e => setSearch(e.target.value)} /></div> : null}
      {loading ? <p className="hint" role="status">{t("Loading…")}</p> : <div className="project-list">
        {visible.map(project => {
          const folders = roots.filter(r => r.projectId === project.projectId);
          const used = dependencies(project);
          return <article className="project-row" key={project.projectId}>
            <div className="project-title"><FolderRoot size={19} /><div className="project-heading"><strong>{project.label}</strong>
              <small>{t("{count} folders", { count: folders.length })} · {t("{count} Agent authorizations", { count: used.length })}</small></div>
              <div className="row-actions">
                <button className="secondary" onClick={() => setEditor({ kind: "add", project })}><CirclePlus size={14} />{t("Add folder")}</button>
                {folders.length ? <Link className="text-link" to={agentUrl(project)}>{t("Authorize agent")}</Link> : null}
                <button className="icon-button" title={t("Rename project")} aria-label={`${t("Rename project")} · ${project.label}`} onClick={() => setEditor({ kind: "rename", project })}><Pencil size={15} /></button>
                <button className="icon-button danger" title={t(used.length ? "Remove the affected Agent authorizations before changing or deleting this resource." : "Delete project")} aria-label={`${t("Delete project")} · ${project.label}`} disabled={!!used.length} onClick={() => setRemoval({ project })}><Trash2 size={15} /></button>
              </div>
            </div>
            <div className="root-list">
              {folders.map(root => {
                const node = nodes.find(n => n.nodeId === root.nodeId);
                const advertised = (node?.effectiveCapability ?? node?.capability)?.roots.find(r => r.rootId === root.rootId);
                const available = node?.status === "active" && !!advertised;
                const usedBy = dependencies(project, root);
                return <div className="root-row project-folder-row" key={root.rootId}>
                  <FolderRoot size={16} /><div><strong>{root.label}</strong><code>{root.path ?? root.rootId}</code></div>
                  <span className="subtle">{node?.label ?? t("Device unavailable")}{!available ? ` · ${t("Unavailable")}` : ""}</span>
                  <span className="state">{t(root.writable ? "Read & write" : "Read only")}</span>
                  <div className="row-actions"><button className="icon-button" title={t("Edit folder")} aria-label={`${t("Edit folder")} · ${root.label}`} onClick={() => setEditor({ kind: "edit", project, root })}><Pencil size={14} /></button>
                    <button className="icon-button danger" disabled={!!usedBy.length} title={t(usedBy.length ? "Remove the affected Agent authorizations before changing or deleting this resource." : "Remove folder")} aria-label={`${t("Remove folder")} · ${root.label}`} onClick={() => setRemoval({ project, root })}><Trash2 size={14} /></button></div>
                </div>;
              })}
              {!folders.length ? <p className="hint project-empty-folders">{t("Add a folder already exposed by a device to start using this project.")}</p> : null}
            </div>
            {used.length ? <p className="hint">{t("Folder access is used by active Agent authorizations. Edit those authorizations before changing access or removing folders.")} <Link to="/app/agents">{t("Open Agent access")}</Link></p> : null}
          </article>;
        })}
        {!visible.length ? <div className="empty"><FolderRoot /><span>{t(projects.length ? "No matching projects" : "No projects")}</span></div> : null}
      </div>}
    </> : null}
    {editor ? <ProjectEditor key={JSON.stringify(editor)} editor={editor} nodes={nodes} roots={roots}
      used={editor.kind === "edit" && !!dependencies(editor.project, editor.root).length}
      request={request} onClose={() => setEditor(undefined)} onSaved={() => { setEditor(undefined); refresh(); }} /> : null}
    {removal ? <ConfirmAction title={t(removal.root ? "Remove folder" : "Delete project")}
      description={t(removal.root ? "Remove this folder from the project? Files on the device are kept." : "Delete this project and its folder group? Files on the devices are kept.")}
      actionLabel={t(removal.root ? "Remove" : "Delete")} onClose={() => setRemoval(undefined)}
      onConfirm={async () => {
        await request(`${projectUrl(removal.project)}${removal.root ? `/roots/${id(removal.root.rootId)}` : ""}`, {
          method: "DELETE", body: JSON.stringify({ revision: (removal.root ?? removal.project).revision ?? 1 })
        });
        refresh();
      }} /> : null}
  </section>;
}

function ProjectEditor({ editor, nodes, roots, used, request, onClose, onSaved }: {
  editor: Editor; nodes: NodeRecord[]; roots: ProjectRoot[]; used: boolean; request: Request; onClose: () => void; onSaved: () => void;
}) {
  const { t, term } = useI18n();
  const folderMode = editor.kind === "add" || editor.kind === "edit";
  const [nodeId, setNodeId] = useState(editor.kind === "edit" ? editor.root.nodeId : "");
  const [rootId, setRootId] = useState(editor.kind === "edit" ? editor.root.rootId : "");
  const [label, setLabel] = useState(editor.kind === "edit" ? editor.root.label : editor.kind === "rename" ? editor.project.label : "");
  const [writable, setWritable] = useState(editor.kind === "edit" && editor.root.writable);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const node = nodes.find(n => n.nodeId === nodeId);
  const folders = (node?.effectiveCapability ?? node?.capability)?.roots.filter(r => !roots.some(binding => binding.rootId === r.rootId)) ?? [];
  const canWrite = node?.status === "active" && (node.effectiveCapability ?? node.capability)?.roots.some(r => r.rootId === rootId && r.writable);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const path = editor.kind === "create" ? "/api/v1/projects" : `${projectUrl(editor.project)}${folderMode ? `/roots${editor.kind === "edit" ? `/${id(editor.root.rootId)}` : ""}` : ""}`;
      const body = editor.kind === "create" ? { label } : editor.kind === "rename" ? { label, revision: editor.project.revision ?? 1 } :
        editor.kind === "add" ? { label, nodeId, rootId, writable } : { label, writable, revision: editor.root.revision ?? 1 };
      await request(path, { method: editor.kind === "create" || editor.kind === "add" ? "POST" : "PATCH", body: JSON.stringify(body) });
      onSaved();
    } catch (error) { setError(term((error as Error).message)); }
    finally { setBusy(false); }
  };
  return <Dialog title={t(editor.kind === "create" ? "New project" : editor.kind === "rename" ? "Rename project" : editor.kind === "add" ? "Add folder" : "Edit folder")} busy={busy} onClose={onClose}>
    <form className="project-editor" onSubmit={submit}>
      {editor.kind === "add" ? <>
        <label>{t("Device")}<select required value={nodeId} disabled={busy} onChange={e => { setNodeId(e.target.value); setRootId(""); setLabel(""); setWritable(false); }}>
          <option value="" disabled>{t("Choose a device")}</option>
          {nodes.filter(n => n.status === "active" && !n.resourceAuthorization).map(n => <option key={n.nodeId} value={n.nodeId}>{n.label}</option>)}
        </select></label>
        <label>{t("Device folder")}<select required disabled={busy || !nodeId || !folders.length} value={rootId} onChange={e => {
          setRootId(e.target.value); setLabel(folders.find(r => r.rootId === e.target.value)?.label ?? ""); setWritable(false);
        }}><option value="" disabled>{t("Choose an exposed folder")}</option>{folders.map(r => <option key={r.rootId} value={r.rootId}>{r.path ?? r.label}</option>)}</select></label>
        {nodeId && !folders.length ? <p className="hint">{t("No unassigned exposed folders. Add a folder on the device or choose another device.")}</p> : null}
      </> : null}
      <label>{t(folderMode ? "Folder label" : "Project name")}<input autoFocus={editor.kind !== "add"} value={label} onChange={e => setLabel(e.target.value)} maxLength={128} required disabled={busy} /></label>
      {folderMode ? <label>{t("Folder access")}<select value={writable ? "write" : "read"} disabled={busy || used} onChange={e => setWritable(e.target.value === "write")}>
        <option value="read">{t("Read only")}</option><option value="write" disabled={!canWrite && !writable}>{t("Read & write")}</option>
      </select>{used ? <span className="hint">{t("Folder access is used by active Agent authorizations. Edit those authorizations before changing access or removing folders.")}</span> : null}</label> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>{t("Cancel")}</button>
        <button className="primary" disabled={busy || !label.trim() || editor.kind === "add" && !rootId}>{t(busy ? "Please wait…" : editor.kind === "create" ? "Create" : editor.kind === "add" ? "Add folder" : "Save changes")}</button></div>
    </form>
  </Dialog>;
}
