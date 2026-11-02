# Team and device sharing management

Use account-management commands only for the user's explicit collaboration request.
Run `adc account list --json` to discover the authenticated human's personal account and teams.
For team management pass `--account <team-id>`; this does not change Agent tool authority.
Do not inspect or rewrite CLI credential files.

- Create a team: `adc team create --name <name> --json`.
- Invite: `adc team invite <team-id> --email <recipient> --json`; send no message unless asked.
  Return the generated link for the human to share. Only the named verified account can accept.
- Review before accepting: `adc invitation show <invitation-id> --json`.
  Show the source, recipient, exact device/folders/tools, mode and expiry.
  Do not accept until the user explicitly requests that reviewed invitation's acceptance.
  Then run `adc invitation accept <invitation-id> --yes --json`.
- Team policy: `adc team members <team-id> --json`, `adc team devices <team-id> --json`.
  Use an explicit `rules: [{nodeId, scope}]` policy JSON with `adc team member-update <team-id>
  <user-id> --file <policy.json> --json`. Do not infer permissions for a member.
- Share: `adc share create <node-id> --email <recipient> --scope <scope.json> --days <days> --json`.
  Scope uses exact advertised root IDs and paths, allowedTools, execution, approvalPolicy, templateIds.
  Teams may explicitly select an already exposed `/` or drive root with Connector 0.1.6+.
  Member policy and Agent grants remain independent; do not expand them just because the team
  binding includes a root. Root access supports structured reads or explicitly enabled trusted
  host execution. For isolated execution use a smaller folder. External shares use narrower folders.
  Use the matching updated CLI/SDK/plugin release for root tasks.
  Read-only is the default. Isolated mode requires verified local Linux Docker.
  Host mode requires explicit trust acknowledgement and `--acknowledge-host-trust`;
  ADC revocation cannot remove other access or modifications established on the host.
- Inspect: `adc share list --direction owned|received --json`.
- Revoke/leave only on the user's instruction: `adc share revoke|leave <binding-id> --yes --json`.
  Member removal is `adc team member-remove <team-id> <user-id> --yes --json`.

Accepting or linking devices does not connect an Agent. Create or edit the user's separate
Agent authorization with exact folders and the intended capabilities, then use `adc connect`.
Ordinary team members manage only their own Agent access.
Wider external sharing requires the original recipient's acceptance; existing Agent scope stays
fixed until explicitly edited. A conflict requires refresh and review.
On denied/cancelled/unknown outcome, preserve the original invocation identity and follow the
main Skill's task state machine. Never replace a side effect merely because access was revoked.
