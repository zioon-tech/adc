import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";

export interface SdkDistribution {
  directory: string;
}

export function registerSdkDistributionRoutes(
  app: FastifyInstance,
  distribution?: SdkDistribution
) {
  app.get(
    "/downloads/sdk/:file",
    async (request: FastifyRequest<{ Params: { file: string } }>, reply) => {
      const file = request.params.file;
      const archive = /^adc-client-\d+\.\d+\.\d+-[a-f0-9]{16}\.tgz$/.test(file);
      if (!distribution || !(archive || ["manifest.json", "SHA256SUMS"].includes(file)))
        return reply.code(404).send({ error: "SDK file not found." });
      const path = resolve(distribution.directory, file);
      try {
        if (!(await lstat(path)).isFile())
          return reply.code(404).send({ error: "SDK file not found." });
      } catch {
        return reply.code(404).send({ error: "SDK file not found." });
      }
      reply.header("cache-control", archive ? "public, max-age=31536000, immutable" : "no-cache");
      if (archive)
        reply
          .header("content-disposition", `attachment; filename="${file}"`)
          .type("application/gzip");
      else reply.type(file.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8");
      return reply.send(createReadStream(path));
    }
  );
}
