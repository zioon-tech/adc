import { readFile } from "node:fs/promises";
import type { AdcClient, TeamMember } from "@adc/client";
import { CollaborationScopeSchema } from "@adc/protocol";

type Flags = Map<string, string | true>;
const flag = (flags: Flags, name: string) => typeof flags.get(name) === "string" ? flags.get(name) as string : undefined;
const required = (flags: Flags, name: string) => {
  const value = flag(flags, name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
};
const confirmed = (flags: Flags) => { if (!flags.has("yes")) throw new Error("Re-run with --yes to confirm this change."); };
async function jsonFile(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The JSON file must contain an object.");
  return value as Record<string, unknown>;
}
export const collaborationUsage = `
Collaboration (account login; --account TEAM selects a team):
  adc account list
  adc team list | create --name NAME
  adc team members TEAM | devices TEAM | invite TEAM --email EMAIL [--role member|admin]
  adc team member-update TEAM USER --file POLICY.json [--acknowledge-host-trust]
  adc team member-remove TEAM USER --yes
  adc team device-add TEAM --node NODE --scope SCOPE.json [--acknowledge-host-trust]
  adc team leave TEAM --yes
  adc share list [--direction received|owned] | activity
  adc share create NODE --email EMAIL --scope SCOPE.json [--days 30] [--acknowledge-host-trust]
  adc share update SHARE --file CHANGES.json [--acknowledge-host-trust]
  adc share pause|resume|revoke|leave SHARE --yes
  adc invitation list | show INVITATION [--token TOKEN]
  adc invitation accept|decline|revoke INVITATION [--token TOKEN] --yes

SCOPE.json contains exact roots, allowedTools, execution, approvalPolicy and templateIds.
Invitation acceptance requires a verified human account session. No message is sent automatically.`;

export async function runCollaborationCommand(input: {
  domain: string; action?: string | undefined; positionals: string[]; flags: Flags; client: AdcClient
}): Promise<{ handled: boolean; value?: unknown }> {
  const { domain, action, positionals, flags, client } = input;
  if (!["account", "team", "share", "invitation"].includes(domain)) return { handled: false };
  const target = positionals[2];
  const accounts = domain === "account" || domain === "team" ? await client.accounts() : undefined;
  const team = () => {
    if (!target) throw new Error("Choose a team.");
    const matches = accounts!.teams.filter(entry => entry.accountId === target || entry.name === target);
    if (matches.length !== 1) throw new Error("Choose an exact team ID or an unambiguous name.");
    return matches[0]!;
  };
  const acknowledgeHostTrust = flags.has("acknowledge-host-trust");
  let value: unknown;
  if (domain === "account" && action === "list") value = accounts;
  else if (domain === "team") {
    if (action === "list") value = accounts!.teams;
    else if (action === "create") value = await client.createTeam(required(flags, "name"));
    else if (action === "members") value = await client.teamMembers(team().accountId);
    else if (action === "devices") value = await client.teamDevices(team().accountId);
    else if (action === "invite") {
      const role = flag(flags, "role") ?? "member";
      if (role !== "member" && role !== "admin") throw new Error("--role must be member or admin.");
      value = await client.inviteTeamMember(team().accountId, required(flags, "email"), role);
    } else if (action === "leave") {
      confirmed(flags); const selected = team();
      value = await client.leaveTeam(selected.accountId, selected.membership.revision);
    } else if (action === "device-add") {
      value = await client.linkTeamDevice(team().accountId, {
        nodeId: required(flags, "node"), scope: CollaborationScopeSchema.parse(await jsonFile(required(flags, "scope"))), acknowledgeHostTrust
      });
    } else if (action === "member-update" || action === "member-remove") {
      const selected = team(), user = positionals[3];
      if (!user) throw new Error("Choose a team member ID.");
      const member = (await client.teamMembers(selected.accountId)).find(entry => entry.userId === user);
      if (!member) throw new Error("Member was not found.");
      if (action === "member-remove") {
        confirmed(flags);
        value = await client.updateTeamMember(selected.accountId, user, { revision: member.revision, role: member.role, state: "removed", rules: [] });
      } else {
        const changes = await jsonFile(required(flags, "file"));
        value = await client.updateTeamMember(selected.accountId, user, {
          revision: member.revision, role: member.role, state: "active", rules: member.rules,
          ...changes as Partial<TeamMember>, acknowledgeHostTrust
        });
      }
    } else throw new Error("Unknown team command. Use adc help.");
  } else if (domain === "share") {
    if (action === "list") {
      const direction = flag(flags, "direction") ?? "received";
      if (direction !== "received" && direction !== "owned") throw new Error("--direction must be received or owned.");
      value = await client.deviceShares(direction);
    } else if (action === "activity") value = await client.sharedDeviceActivity();
    else if (action === "create") {
      if (!target) throw new Error("Choose a device ID.");
      value = await client.inviteDeviceShare(target, {
        email: required(flags, "email"), scope: CollaborationScopeSchema.parse(await jsonFile(required(flags, "scope"))),
        durationDays: Number(flag(flags, "days") ?? 30), acknowledgeHostTrust
      });
    } else {
      if (!target) throw new Error("Choose a sharing permission ID.");
      const shares = await client.deviceShares(action === "leave" ? "received" : "owned");
      const share = shares.find(entry => entry.bindingId === target);
      if (!share) throw new Error("Sharing permission was not found.");
      if (action === "revoke" || action === "leave") { confirmed(flags); value = await client.endDeviceShare(target, share.revision, action); }
      else if (action === "pause" || action === "resume") {
        confirmed(flags); value = await client.updateDeviceShare(target, { revision: share.revision, state: action === "pause" ? "paused" : "active" });
      } else if (action === "update") value = await client.updateDeviceShare(target, {
        revision: share.revision, ...await jsonFile(required(flags, "file")), acknowledgeHostTrust
      });
      else throw new Error("Unknown share command. Use adc help.");
    }
  } else if (domain === "invitation") {
    if (action === "list") value = await client.invitations();
    else {
      if (!target) throw new Error("Choose an invitation ID.");
      const token = flag(flags, "token");
      if (action === "show") value = await client.invitation(target, token);
      else if (action === "accept" || action === "decline" || action === "revoke") {
        confirmed(flags);
        const invitation = action === "revoke" ? (await client.invitations()).find(entry => entry.invitationId === target) : await client.invitation(target, token);
        if (!invitation) throw new Error("Invitation was not found.");
        value = await client.respondInvitation(target, invitation.revision, action, token);
      } else throw new Error("Unknown invitation command. Use adc help.");
    }
  } else throw new Error("Use adc account list.");
  return { handled: true, value };
}
