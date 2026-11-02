import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresMemoryServer } from "postgres-memory-server";
import { MemoryStore, PostgresStore, type Store } from "../packages/db/src/index.ts";
import { createControlPlane } from "../apps/control-plane/src/app.ts";
import { generateNodeKeyPair } from "../packages/client/src/node.ts";
import { CapabilitySchema } from "../packages/protocol/src/index.ts";
import { accessFixture } from "./helpers/access-fixture.ts";

for (const backend of ["memory", "postgres"] as const) {
  describe(`project management over HTTP (${backend})`, () => {
    let store: Store, postgres: PostgresMemoryServer | undefined;
    let app: Awaited<ReturnType<typeof createControlPlane>>;
    let nodeId: string;
    const headers = { cookie: "adc.session_token=projects", origin: "http://adc.test" };
    const request = (url: string, payload?: object, method = "POST") =>
      app.inject({ url, method: payload === undefined ? "GET" : method as "POST",
        headers, ...(payload ? { payload } : {}) });
    const ok = async (url: string, payload?: object, method?: string) => {
      const response = await request(url, payload, method);
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    beforeAll(async () => {
      if (backend === "postgres") {
        postgres = await PostgresMemoryServer.create({ database: "adc_projects", username: "adc_projects", password: "adc_projects" });
        store = new PostgresStore(postgres.getUri());
      } else store = new MemoryStore();
      await store.migrate();
      await store.putAccount({ accountId: "acct_primary", ownerTokenHash: "owner", createdAt: new Date().toISOString() });
      app = await createControlPlane({ store, access: accessFixture({ cookie: headers.cookie }) });
      const code = (await ok("/api/v1/pairing-codes", {})).code;
      const paired = await app.inject({ method: "POST", url: "/api/v1/nodes/pair", payload: {
        code, label: "Project device", platform: "darwin", publicKey: generateNodeKeyPair().publicKey
      } });
      expect(paired.statusCode, paired.body).toBe(200);
      nodeId = paired.json().nodeId;
      await store.updateNodePresence(nodeId, CapabilitySchema.parse({
        schemaVersion: "0.1", nodeId, platform: "darwin", nodeVersion: "0.1.6", advertisedAt: new Date().toISOString(),
        roots: ["root_workspace", "root_docs", "root_blocked", "root_race", "root_response", "root_update_race"].map(rootId => ({ rootId, path: `/${rootId}`, label: rootId, writable: true })),
        tools: [{ name: "file.read", risk: "read", version: "0.1.0", sandboxProfiles: ["restricted-process"] }]
      }), new Date());
    }, 60_000);
    afterAll(async () => { await app?.close(); await postgres?.stop(); });
    const grantInput = (projectId: string, rootId: string) => ({
      projectId, name: "Project Agent", profile: "read-only", nodeIds: [nodeId], rootAccess: "selected",
      rootIds: [rootId], allowedTools: ["file.read"]
    });

    it("supports create, rename, folder editing/removal, revision conflicts and deletion with durable audit", async () => {
      const project = await ok("/api/v1/projects", { projectId: "proj_workflow", label: "Workflow" });
      expect(project.revision).toBe(1);
      const url = `/api/v1/projects/${project.projectId}`;
      expect((await request("/api/v1/projects", { projectId: project.projectId, label: "Overwrite" })).statusCode).toBe(409);
      expect((await request("/api/v1/projects", { label: "Workflow" })).statusCode).toBe(409);
      await ok(url, { label: "Renamed", revision: 1 }, "PATCH");
      expect((await request(url, { label: "Stale", revision: 1 }, "PATCH")).statusCode).toBe(409);
      const root = await ok(`${url}/roots`, { rootId: "root_workspace", nodeId, label: "Workspace", writable: false });
      const rootUrl = `${url}/roots/${root.rootId}`;
      expect(root.revision).toBe(1);
      await ok(rootUrl, { label: "Source", writable: true, revision: 1 }, "PATCH");
      expect((await request(rootUrl, { label: "Stale", writable: true, revision: 1 }, "PATCH")).statusCode).toBe(409);
      expect((await request(`${url}/roots`, { rootId: root.rootId, nodeId, label: "Overwrite", writable: true })).statusCode).toBe(409);
      const other = await ok("/api/v1/projects", { label: "Other project" });
      expect((await request(`/api/v1/projects/${other.projectId}/roots`, { rootId: root.rootId, nodeId, label: "Rebound", writable: true })).statusCode).toBe(409);
      await ok(rootUrl, { revision: 2 }, "DELETE");
      // Re-adding the same immutable binding advances its revision; old forms stay stale.
      const restored = await ok(`${url}/roots`, { rootId: root.rootId, nodeId, label: "Source", writable: false });
      expect(restored.revision).toBe(4);
      expect((await request(rootUrl, { revision: 1 }, "DELETE")).statusCode).toBe(409);
      await ok(rootUrl, { revision: 4 }, "DELETE");
      await ok(url, { revision: 2 }, "DELETE");
      expect((await ok("/api/v1/projects?include=roots")).projects.some((p: any) => p.projectId === project.projectId)).toBe(false);
      expect((await request(`${url}/roots`)).statusCode).toBe(404);
      expect((await request("/api/v1/projects", { projectId: project.projectId, label: "Reuse deleted ID" })).statusCode).toBe(409);
      const recreated = await ok("/api/v1/projects", { label: "Renamed" });
      expect(recreated.projectId).not.toBe(project.projectId);
      const events = (await store.listAudit("acct_primary")).filter(event => event.payload.projectId === project.projectId);
      expect(events.map(event => event.type)).toEqual(expect.arrayContaining(["project.created", "project.updated", "project.folder_added", "project.folder_updated", "project.folder_removed", "project.deleted"]));
    });

    it("keeps active project grants stable, allows renaming and rejects deleted resources", async () => {
      const project = await ok("/api/v1/projects", { label: "Grant dependencies" });
      const url = `/api/v1/projects/${project.projectId}`;
      const root = await ok(`${url}/roots`, { rootId: "root_docs", nodeId, label: "Docs", writable: false });
      const grant = await ok("/api/v1/grants", grantInput(project.projectId, root.rootId));
      await ok(`${url}/roots/${root.rootId}`, { revision: root.revision, label: "Documentation", writable: false }, "PATCH");
      expect((await request(`${url}/roots/${root.rootId}`, { revision: 2, label: "Documentation", writable: true }, "PATCH")).statusCode).toBe(409);
      expect((await request(`${url}/roots/${root.rootId}`, { revision: 2 }, "DELETE")).statusCode).toBe(409);
      expect((await request(url, { revision: 1 }, "DELETE")).statusCode).toBe(409);
      await ok(`/api/v1/grants/${grant.grantId}`, { revision: 1 }, "DELETE");
      await ok(`${url}/roots/${root.rootId}`, { revision: 2 }, "DELETE");
      expect((await request("/api/v1/grants", grantInput(project.projectId, root.rootId))).statusCode).toBe(403);
      await ok(url, { revision: 1 }, "DELETE");
      expect((await request("/api/v1/grants", grantInput(project.projectId, root.rootId))).statusCode).toBe(404);
    });

    it("enforces account ownership and effective device folder policy", async () => {
      await store.putAccount({ accountId: "acct_foreign", ownerTokenHash: "foreign", createdAt: new Date().toISOString() });
      await store.putProject({ projectId: "proj_foreign", accountId: "acct_foreign", label: "Foreign", createdAt: new Date().toISOString() });
      for (const method of ["PATCH", "DELETE"])
        expect((await request("/api/v1/projects/proj_foreign", { revision: 1, ...(method === "PATCH" ? { label: "Hijacked" } : {}) }, method)).statusCode).toBe(404);
      const project = await ok("/api/v1/projects", { label: "Device policy" });
      const url = `/api/v1/projects/${project.projectId}`;
      const node = await store.getNode(nodeId);
      await ok(`/api/v1/nodes/${nodeId}`, { label: node!.label, revision: node!.revision ?? 1,
        accessPolicy: { rootAccess: "selected", rootIds: ["root_workspace"], readOnlyRootIds: ["root_workspace"], allowExecution: true } }, "PATCH");
      expect((await request(`${url}/roots`, { rootId: "root_blocked", nodeId, label: "Blocked", writable: false })).statusCode).toBe(400);
      expect((await request(`${url}/roots`, { rootId: "root_workspace", nodeId, label: "Writable", writable: true })).statusCode).toBe(400);
      const root = await ok(`${url}/roots`, { rootId: "root_workspace", nodeId, label: "Read only", writable: false });
      expect((await request(`${url}/roots/${root.rootId}`, { label: root.label, writable: true, revision: root.revision }, "PATCH")).statusCode).toBe(403);
      const current = await store.getNode(nodeId);
      await ok(`/api/v1/nodes/${nodeId}`, { label: current!.label, revision: current!.revision,
        accessPolicy: { rootAccess: "all", rootIds: [], readOnlyRootIds: [], allowExecution: true } }, "PATCH");
    });

    it("serializes grant creation with project and folder deletion", async () => {
      for (const target of ["folder", "project"]) {
        const project = await ok("/api/v1/projects", { label: `Race ${target}` });
        const url = `/api/v1/projects/${project.projectId}`;
        const rootId = target === "folder" ? "root_race" : "root_blocked";
        const root = await ok(`${url}/roots`, { rootId, nodeId, label: "Race", writable: false });
        const [creation, deletion] = await Promise.all([
          request("/api/v1/grants", grantInput(project.projectId, root.rootId)),
          request(target === "folder" ? `${url}/roots/${root.rootId}` : url, { revision: 1 }, "DELETE")
        ]);
        expect(creation.statusCode === 200 && deletion.statusCode === 200).toBe(false);
        expect(creation.statusCode === 200 || deletion.statusCode === 200).toBe(true);
        if (creation.statusCode === 200) await ok(`/api/v1/grants/${creation.json().grantId}`, { revision: 1 }, "DELETE");
      }
    });

    it("returns the saved folder even when the project is deleted before the add response", async () => {
      const project = await ok("/api/v1/projects", { label: "Response snapshot" });
      const url = `/api/v1/projects/${project.projectId}`;
      const put = store.putRoot.bind(store);
      const intercept = vi.spyOn(store, "putRoot").mockImplementationOnce(async (...args) => {
        const saved = await put(...args);
        await store.deleteProject("acct_primary", project.projectId, 1, {
          eventId: "dsp_response_delete", accountId: "acct_primary", type: "project.deleted",
          payload: { projectId: project.projectId }, createdAt: new Date().toISOString()
        });
        return saved;
      });
      try {
        const root = await ok(`${url}/roots`, { rootId: "root_response", nodeId, label: "Snapshot", writable: false });
        expect(root).toMatchObject({ rootId: "root_response", projectId: project.projectId, nodeId, label: "Snapshot", writable: false, revision: 1 });
        expect((await request(`${url}/roots`)).statusCode).toBe(404);
      } finally { intercept.mockRestore(); }
    });

    it("serializes an existing grant moving into a project with project deletion", async () => {
      const project = await ok("/api/v1/projects", { label: "Grant update race" });
      const url = `/api/v1/projects/${project.projectId}`;
      const root = await ok(`${url}/roots`, { rootId: "root_update_race", nodeId, label: "Update race", writable: false });
      const direct = await ok("/api/v1/grants", {
        name: "Direct Agent", profile: "read-only", nodeIds: [nodeId], rootAccess: "selected",
        rootIds: [root.rootId], allowedTools: ["file.read"]
      });
      const [updated, deleted] = await Promise.all([
        request(`/api/v1/grants/${direct.grantId}`, { ...grantInput(project.projectId, root.rootId), revision: 1 }, "PATCH"),
        request(url, { revision: 1 }, "DELETE")
      ]);
      expect(updated.statusCode === 200 && deleted.statusCode === 200).toBe(false);
      expect(updated.statusCode === 200 || deleted.statusCode === 200).toBe(true);
      const current = await store.getGrant(direct.grantId);
      if (deleted.statusCode === 200) expect(current!.projectId).toBeUndefined();
      await ok(`/api/v1/grants/${direct.grantId}`, { revision: current!.revision }, "DELETE");
    });
  });
}
