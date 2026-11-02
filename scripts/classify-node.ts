import { PostgresStore } from "../packages/db/src/index.ts";
import { z } from "zod";
import { randomBytes } from "node:crypto";

// Direct operator/database authority only; never exposed as a public management tool.
const [nodeId, requested, confirmation] = process.argv.slice(2);
const resourceClass = z.enum(["physical", "managed", "platform"]).parse(requested);
if (!nodeId || confirmation !== `--confirm=${nodeId}`)
  throw new Error("Usage: DATABASE_URL=... node --import tsx scripts/classify-node.ts NODE physical|managed|platform --confirm=NODE");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const store = new PostgresStore(process.env.DATABASE_URL);
await store.migrate();
const client = await store.pool.connect();
try {
  await client.query("BEGIN");
  const source = await client.query("SELECT account_id FROM adc_nodes WHERE node_id=$1", [nodeId]);
  if (!source.rows[0]) throw new Error("Device was not found.");
  await client.query("SELECT account_id FROM adc_accounts WHERE account_id=$1 FOR UPDATE", [source.rows[0].account_id]);
  const previous = await client.query("SELECT resource_class FROM adc_nodes WHERE node_id=$1 FOR UPDATE", [nodeId]);
  await client.query("UPDATE adc_nodes SET resource_class=$2, revision=revision+1 WHERE node_id=$1", [nodeId, resourceClass]);
  if (resourceClass !== "physical") {
    await client.query(`UPDATE adc_resource_bindings SET state='revoked', revision=revision+1,
      record=record || jsonb_build_object('state','revoked','revision',revision+1)
      WHERE node_id=$1 AND state<>'revoked'`, [nodeId]);
    await client.query(`UPDATE adc_dispatches SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancel_requested' END,
      updated_at=NOW() WHERE node_id=$1 AND invocation->'delegation' IS NOT NULL AND status IN ('queued','leased','running','cancel_requested')`, [nodeId]);
    await client.query("UPDATE adc_approvals SET status='denied',resolved_at=NOW() WHERE node_id=$1 AND invocation->'delegation' IS NOT NULL AND status='pending'", [nodeId]);
  }
  await client.query(`INSERT INTO adc_audit_events(event_id,account_id,event_type,payload,created_at) VALUES($1,$2,'node.resource_class.changed',$3,NOW())`,
    [`evt_${randomBytes(16).toString("hex")}`, source.rows[0].account_id, { nodeId, previous: previous.rows[0].resource_class, resourceClass, authority: "database-operator" }]);
  await client.query("COMMIT");
  console.log(JSON.stringify({ nodeId, resourceClass }));
} catch (error) { await client.query("ROLLBACK"); throw error; }
finally { client.release(); await store.close(); }
