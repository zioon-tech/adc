import type { PoolClient } from "pg";

/** Call after locking both requester/resource accounts, before admission. */
export async function consentIsAuthorized(client: PoolClient, accountId: string, userId: string, role: "requester" | "resource"): Promise<boolean> {
  const account = (await client.query("SELECT kind,user_id FROM adc_accounts WHERE account_id=$1", [accountId])).rows[0];
  if (!account) return false;
  if (account.kind === "personal") return account.user_id === userId;
  const member = (await client.query("SELECT role FROM adc_team_members WHERE account_id=$1 AND user_id=$2 AND state='active'", [accountId, userId])).rows[0];
  return !!member && (role === "requester" || member.role === "owner" || member.role === "admin");
}
