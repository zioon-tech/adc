import type { CollaborationScope } from "@adc/protocol";

export type { CollaborationScope } from "@adc/protocol";
export type TeamRole = "owner" | "admin" | "member";
export interface TeamMember {
  accountId: string;
  userId: string;
  role: TeamRole;
  state: "active" | "removed";
  revision: number;
  rules: Array<{ nodeId: string; scope: CollaborationScope }>;
  name?: string;
  email?: string;
}
export interface Team {
  accountId: string;
  kind: "team";
  name: string;
  membership: TeamMember;
}
export interface Accounts {
  selectedAccountId: string;
  personalAccountId: string;
  teams: Team[];
}
export interface DeviceShare {
  bindingId: string;
  kind: "share" | "team";
  nodeId: string;
  resourceAccountId: string;
  recipientAccountId: string;
  recipientUserId?: string;
  scope: CollaborationScope;
  expiresAt: string | null;
  revision: number;
  state: "active" | "paused" | "revoked";
}
export interface Invitation {
  invitationId: string;
  kind: "member" | "share" | "scope";
  senderAccountId: string;
  recipientEmail: string;
  teamAccountId?: string;
  role?: "admin" | "member";
  nodeId?: string;
  scope?: CollaborationScope;
  expiresAt: string;
  durationDays?: number | null;
  bindingExpiresAt?: string | null;
  revision: number;
  state: "pending" | "accepted" | "declined" | "revoked";
  senderName?: string;
  teamName?: string;
  nodeLabel?: string;
  targetUserId?: string;
}
export interface InvitationCreated {
  invitation: Invitation;
  token: string;
  link?: string;
  pending?: boolean;
}
