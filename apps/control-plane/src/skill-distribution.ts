import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface SkillDistribution {
  directory: string;
}

const name = "agent-device-cloud";
const resources = new Set([
  "SKILL.md",
  "references/getting-started.md",
  "references/account-and-device-management.md",
  "references/collaboration.md",
  "references/tool-invocation.md"
]);

export function registerSkillDistributionRoutes(
  app: FastifyInstance,
  distribution?: SkillDistribution
) {
  async function serve(file: string, reply: FastifyReply) {
    const archive = new RegExp(`^${name}-[0-9]+\\.[0-9]+\\.[0-9]+-[a-f0-9]{16}\\.zip$`).test(file);
    const resource = file.startsWith(`${name}/`) && resources.has(file.slice(name.length + 1));
    const allowed =
      archive ||
      resource ||
      ["index.json", "legacy-index.json", "manifest.json", `${name}.zip`].includes(file);
    if (!distribution || !allowed) return reply.code(404).send({ error: "Skill file not found." });
    const path = resolve(distribution.directory, file);
    try {
      if (!(await lstat(path)).isFile())
        return reply.code(404).send({ error: "Skill file not found." });
    } catch {
      return reply.code(404).send({ error: "Skill file not found." });
    }
    reply.header("cache-control", archive ? "public, max-age=31536000, immutable" : "no-cache");
    if (file.endsWith(".zip")) {
      reply.header("content-disposition", `attachment; filename="${file}"`).type("application/zip");
    } else reply.type(file.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8");
    return reply.send(createReadStream(path));
  }
  app.get("/.well-known/agent-skills/index.json", async (_request, reply) =>
    serve("index.json", reply)
  );
  app.get("/.well-known/skills/index.json", async (_request, reply) =>
    serve("legacy-index.json", reply)
  );
  for (const prefix of ["/.well-known/agent-skills", "/.well-known/skills"]) {
    app.get(
      `${prefix}/${name}/*`,
      async (request: FastifyRequest<{ Params: { "*": string } }>, reply) =>
        serve(`${name}/${request.params["*"]}`, reply)
    );
  }
  app.get(
    "/downloads/skills/:file",
    async (request: FastifyRequest<{ Params: { file: string } }>, reply) =>
      serve(request.params.file, reply)
  );
}
