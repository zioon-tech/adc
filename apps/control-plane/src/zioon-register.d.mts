import type { FastifyInstance } from "fastify";
import type { AccessService } from "./access.ts";
export function registerZioonAccounts(
  app: FastifyInstance,
  access: AccessService,
  options?: { consoleDirectory?: string }
): Promise<void>;
