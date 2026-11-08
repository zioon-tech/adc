import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { PostgresMemoryServer } from "postgres-memory-server";

/** Match the release CI PostgreSQL service, keeping local embedded fallback isolated. */
export async function createPostgresFixture(prefix: string) {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(prefix)) throw new Error("Invalid test database prefix");
  const shared = process.env.ADC_TEST_DATABASE_URL;
  if (!shared) {
    const embedded = await PostgresMemoryServer.create({
      database: prefix,
      username: "adc_test",
      password: "adc_test"
    });
    return { databaseUrl: embedded.getUri(), stop: () => embedded.stop() };
  }
  const admin = new Pool({ connectionString: shared });
  const databaseName = `${prefix}_${randomBytes(8).toString("hex")}`;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const url = new URL(shared);
  url.pathname = `/${databaseName}`;
  let stopped = false;
  return {
    databaseUrl: url.href,
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        // No FORCE: leaked connections must fail the test rather than be hidden.
        await admin.query(`DROP DATABASE "${databaseName}"`);
      } finally {
        await admin.end();
      }
    }
  };
}
