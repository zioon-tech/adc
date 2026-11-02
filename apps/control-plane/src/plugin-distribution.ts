import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";

export interface PluginDistribution {
  directory: string;
}
const hosts =
  "(?:portable|claude|codex|cursor|copilot|gemini|droid|opencode|pi|cline|zion|marketplace)";
const immutable = new RegExp(
  `^agent-device-cloud-${hosts}-[0-9]+\\.[0-9]+\\.[0-9]+-[a-f0-9]{16}\\.zip$`
);
const alias = new RegExp(`^agent-device-cloud-${hosts}\\.zip$`);

export function registerPluginDistributionRoutes(
  app: FastifyInstance,
  distribution?: PluginDistribution
) {
  app.get(
    "/downloads/plugins/:file",
    async (request: FastifyRequest<{ Params: { file: string } }>, reply) => {
      const file = request.params.file;
      if (
        !distribution ||
        (!immutable.test(file) &&
          !alias.test(file) &&
          !["index.json", "checksums.txt", "agent-device-cloud-cline.mjs"].includes(file))
      )
        return reply.code(404).send({ error: "Plugin file not found." });
      const path = resolve(distribution.directory, file);
      try {
        if (!(await lstat(path)).isFile())
          return reply.code(404).send({ error: "Plugin file not found." });
      } catch {
        return reply.code(404).send({ error: "Plugin file not found." });
      }
      reply.header(
        "cache-control",
        immutable.test(file) ? "public, max-age=31536000, immutable" : "no-cache"
      );
      if (file.endsWith(".zip"))
        reply
          .type("application/zip")
          .header("content-disposition", `attachment; filename="${file}"`);
      else
        reply.type(
          file.endsWith(".json")
            ? "application/json"
            : file.endsWith(".mjs")
              ? "application/javascript; charset=utf-8"
              : "text/plain; charset=utf-8"
        );
      return reply.send(createReadStream(path));
    }
  );
}
