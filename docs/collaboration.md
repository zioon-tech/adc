# Teams and named device sharing

ADC collaboration grants device tools and exact folders. It does not create a virtual network.
Connectors keep outbound connections and execute on the owning device.

## Website

1. Sign in with your verified Zioon account. In the console, create a team under **Teams**.
2. Invite members by email, then send the generated invitation link. Invitations expire in seven
   days. The named recipient signs in, reviews and explicitly accepts. Opening the link alone
   changes nothing. Inviting does not send an email automatically.
3. On a personally owned device, choose **Share**, select a team you administer, and select exact
   folders, tools and approvals. The device keeps its original owner. You can also switch to a team
   and pair a new device directly to that team.
4. Switch to the team and edit each member's device policy. Ordinary members start with no device
   access; owners/admins without an explicit policy receive structured reads only.
5. For an external collaborator, choose **External user** instead of a team and specify their email
   and sharing duration. The accepted device appears under **Sharing → Shared with me**.
6. Each person creates their own **Agent access** authorization and connects through CLI, MCP,
   SDK or Zioon. Accepting a device or expanding sharing never expands an existing Agent grant.

Only the owner can appoint an admin. Admins cannot alter other admins. Removing or leaving a team
revokes that person's Agent connections; rejoining does not restore old connections.
Personal account and team selection are separate from login.

## Device execution modes

| Mode | Execution | Revocation |
| --- | --- | --- |
| Read only | Structured file reads within exact shared roots; protected paths excluded | Stops new reads and cancels active work |
| Isolated | Built-in tools in a new non-root Linux container; no network, host sockets or host environment; source copied read-only, writes stay in temporary storage | Cancels leases and tears down the whole guest, including detached children; guest also expires without lease updates |
| Trusted host | Owner explicitly enables local trusted sharing and acknowledges the risk for that person | Stops ADC dispatch and cancels ADC work; cannot undo host changes or other access the person established |

Isolated work starts from a fresh snapshot for each invocation. Workspace writes are discarded.
Command stdout/stderr artifacts are retained within bounds; arbitrary modified files are not
exported automatically. Use trusted host mode only when that trust is intentional.
Linux Docker with seccomp, an installed digest-pinned image with Node 24+ and Bash, and the bundled
worker are required. Verification failure disables isolated sharing; there is no host fallback.

```sh
# Run on the device, then expose a project folder.
adc-node roots add /path/to/project --label Collaboration
adc-node sharing on --isolation docker --image 'REGISTRY/IMAGE@sha256:DIGEST'
# Local trusted-host access is off by default.
adc-node sharing on --trusted-host on
# Stop all local sharing:
adc-node sharing off
```

Teams can select an already exposed `/` or drive root with Connector 0.1.6+.
The source device's exact roots remain the upper bound, and members and Agents keep separate
scopes. Root sharing uses structured reads or explicitly enabled trusted host execution;
isolated execution requires a smaller folder for the bounded snapshot.
For root tasks, use CLI 0.1.6+, SDK 0.2.2+, or the updated ADC plugin package so the
versioned provenance in receipts is understood.
External user sharing still requires narrower folders. Protected credential/configuration/service
directories remain excluded from structured access.
Old Connectors lacking the versioned sharing contract must be updated first.
Managed execution resources and platform servers cannot be shared as physical devices.

## CLI

The console shows each device's current and available Connector versions, including offline
devices. Select the update badge to copy that device's installer command. The release resolver
uses a newer local publication in preference to a stale configured mirror, and pairs that version
with its installer source. Network failure keeps the local or last known release visible.
An unreported version or unavailable release is shown as unknown; a device running a version newer
than the available publication is never told to downgrade.

Management uses `adc login`; tools use the separate `adc connect` Agent connection.
`--account TEAM` selects a team for management using the same human's membership.
Acceptance requires a verified account session, so PATs cannot accept invitations.

```sh
adc account list --json
adc team create --name Research --json
adc team invite TEAM_ID --email colleague@example.com --json
adc invitation show INVITATION_ID --json
adc invitation accept INVITATION_ID --yes --json
adc team device-add TEAM_ID --node NODE_ID --scope scope.json --json
adc team member-update TEAM_ID USER_ID --file member-policy.json --json
adc access create --account TEAM_ID --name Analyst --devices NODE_ID --capabilities read
adc share create NODE_ID --email guest@example.com --scope scope.json --days 7 --json
adc share list --direction owned --json
adc share pause BINDING_ID --yes
adc share resume BINDING_ID --yes
adc share revoke BINDING_ID --yes
adc share leave BINDING_ID --yes
```

`scope.json`:

```json
{
  "roots": [{"rootId": "root_EXACT_ID", "path": "/path/to/project", "writable": false}],
  "allowedTools": ["device.list", "device.status", "file.list", "file.read", "file.search", "task.status", "task.result", "task.wait", "task.cancel"],
  "execution": "read-only",
  "approvalPolicy": "always",
  "templateIds": []
}
```

`member-policy.json` contains `role`, `state` and `rules: [{nodeId, scope}]`. CLI reads the current
revision by default; a supplied revision must match. Host trust requires
`--acknowledge-host-trust`. `share update --file changes.json` accepts scope, expiry or state with
a revision; wider external permissions create a new proposal requiring the same recipient's
acceptance. Shorter expiry and permission removal apply immediately.

## API, SDK, MCP and plugins

Sessions and human PATs can select a team through `X-ADC-Account`; Agent bearer credentials are
bound to their own grant and do not obtain account management permissions.

| Resource | Endpoints |
| --- | --- |
| Accounts / teams | `GET /api/v1/accounts`, `POST /api/v1/teams` |
| Membership | `GET/PATCH /api/v1/teams/:accountId/members[/ :userId]`, `POST .../invitations`, `POST .../leave` |
| Team devices | `GET/POST /api/v1/teams/:accountId/devices` |
| External invitations | `POST /api/v1/nodes/:nodeId/share-invitations`, `GET /api/v1/share-invitations`, `GET .../:invitationId`, `POST .../:invitationId/{accept,decline,revoke}` |
| Sharing | `GET /api/v1/device-shares?direction=owned|received`, `PATCH .../:bindingId`, `POST .../:bindingId/{revoke,leave}`, `GET .../activity` |

SDK `AdcClient` exposes `accounts`, `withAccount`, `createTeam`, `teamMembers`, `teamDevices`,
`inviteTeamMember`, `updateTeamMember`, `linkTeamDevice`, `inviteDeviceShare`, `invitations`,
`respondInvitation`, `deviceShares`, `updateDeviceShare` and `endDeviceShare`.
When creating a grant for shared devices, pass the explicitly selected
`resourceBindings: [{nodeId, bindingId}]`. Website and CLI capture these automatically.
The server captures each device's current scope; later sharing expansion requires an explicit
grant edit to include new permissions.

MCP and installed plugins discover only the grant's live projected resources. Their target
descriptions include shared/team provenance and execution mode, including container Bash and
discarded writes. ADC Studio and the original Zioon ADC plugin link to the same team/sharing
management pages, and use the same dispatch, cancellation and durable receipt path.

## Revocation, approvals and history

Revision conflicts return `409`; refresh and review before resubmitting. Cancellation or unknown
outcome never permits replacing a side effect with a new invocation.
Sharing/member/grant/device changes are checked at submission, approval, enqueue, claim, lease
renewal, retry, and result/artifact access. Resource and requester approval are independent;
dispatch waits until every required consent exists.
Each member accesses only their own conversation work and results. Device owners see activity
facts and resource approval details, not requester output, conversation or arbitrary credentials.

Operators classify platform/managed nodes with `scripts/classify-node.ts` using direct database
authority, never a browser or Node advertisement. The classification is immutable through public
APIs. Classifying a node away from physical cancels shared work and revokes its relationships.
