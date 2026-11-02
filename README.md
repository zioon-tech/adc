# Agent Device Cloud

Teams and named external device sharing use the same policy, dispatch and receipt path across
website, CLI, SDK, MCP and plugins. See [collaboration workflows and boundaries](docs/collaboration.md).

Agent Device Cloud is private device infrastructure for AI agents. It gives MCP clients, coding
agents, Skills and automation controlled access to capabilities on devices you own. Desktop Nodes
provide governed files, tools and environments on macOS, Linux and Windows. The Android Mobile Node
MVP provides a smaller native capability surface. The control plane authenticates, authorizes,
routes and records calls; resource validation and execution happen on the selected device.

It is designed first for developers and self-hosters who need to continue local development, use
private infrastructure, move work between Agent interfaces or automate repeatable tasks without
turning a device into an unaudited remote shell.

Hosted and self-hosted installations use **one application**: email login, optional GitHub login,
account isolation, session management, device pairing, scoped Agent credentials, MCP OAuth consent,
approvals and audit. `/` is the public landing page; `/app` is the authenticated console. The
landing page, authentication and console share a monochrome design and a persistent English /
简体中文 selector. No shared administration token is used.

Public documentation is available at `/docs`, with quickstart, use cases, authorization concepts,
architecture, Connector, MCP/CLI/Skill integration, tool and API reference, security, self-hosting,
production operations, troubleshooting, contribution guidance, roadmap and release notes. The
authenticated console opens on an account overview with setup progress, device health, pending
approvals, client connections and recent activity.
The public positioning, product contract and delivery direction are recorded in
[product direction](docs/product-direction.md). The implementation topology, request sequence,
authorization gates and dispatch state machine are mapped in
[system architecture](docs/system-architecture.md). The public content, search indexing, hosted
analytics and release process are defined in [growth and operations](docs/growth-operations.md).
Self-hosted installations send no analytics by default.

The native Android source, build instructions, current capabilities and Xiaomi/HyperOS limitations
are documented in [apps/android-node](apps/android-node/README.md). The
[Android capability matrix](docs/android-capability-matrix.md) separates ordinary App APIs,
user-confirmed and special-access flows, and managed-device-only operations. Signed APK publication
and the App's verified update channel are documented in
[Android Mobile Node distribution](docs/android-node-distribution.md). The Mobile Node has physical
Xiaomi/MIUI validation and is available as a manually installed APK from **Devices → Pair device →
Android**. The current hosted APK uses a development signing key and does not receive automatic
updates; signed release-channel publication is a separate deployment step.

## Official hosted service

Use **https://adc.zioon.tech** to create an account, connect devices and authorize agents.
The official service serves the Console, MCP endpoint, macOS/Linux/Windows Connector packages and
the Android APK from the same deployment. `zioon.tech` and `www.zioon.tech` redirect to this address.

Email/password registration, email verification, password recovery and GitHub login are configured.
Hosted and self-hosted installations share the same authorization and local execution boundaries.
See [security](https://adc.zioon.tech/docs/security) and [implementation status](docs/implementation-status.md) for
current safeguards, verified platforms and remaining limitations.

## Start a public installation

Requirements: Docker Compose 2.24.4+, a hostname pointing to the server, ports 80/443, and SMTP.

```bash
cp .env.example .env
openssl rand -hex 48
openssl rand -hex 32
```

Edit `.env`: set `ADC_PUBLIC_URL=https://devices.example.com`, paste the generated values into
`ADC_AUTH_SECRET` and `ADC_DATABASE_PASSWORD`, and configure `ADC_SMTP_URL` / `ADC_SMTP_FROM`.
Use a URL-safe database password (the hex generator above is suitable). SMTP credentials inside
the URL must be percent-encoded.

```bash
docker compose --env-file .env -f deploy/compose.yaml up -d --build
```

Caddy obtains and renews TLS certificates. PostgreSQL and the API have no published host ports.
Open your hostname, create an account, verify your email and sign in. Each registered user receives
their own account; the first registrant does not control other users. Set
`ADC_REGISTRATION_ENABLED=false` after creating the intended accounts to close registration.
All deployments support password reset through SMTP.

The bundle uses subnet `172.29.74.0/24` for trusted proxy traffic; if it conflicts with your network,
change both the subnet and `ADC_TRUSTED_PROXIES`.

## Try the same application locally

After copying `.env.example` and generating the two secrets:

```bash
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.local.yaml up -d --build
```

Open **http://localhost:8088** and register normally. This override binds only to loopback and
disables mandatory email verification. SMTP is optional here; without it, password recovery is
unavailable. Do not use this HTTP override as a public deployment.

## Connect a device and an agent

1. Sign in to the console and choose **Devices → Pair device**.
2. Copy the installation command and run it on your device. Its general form is:

   ```bash
   curl -fsSL https://devices.example.com/downloads/node/install.sh | sh -s -- \
     --url https://devices.example.com --code 'PAIRING_CODE'
   ```

   On Windows 10/11 x64, select **Windows PowerShell** in the console. The generated command
   downloads `install.ps1` with `Invoke-WebRequest`; curl, a Unix shell and Node.js are not required.
   WSL remains a separate Linux node and uses the macOS/Linux command.
   For Android, download the APK from the pairing dialog and enter the displayed service URL and
   pairing code in ADC Mobile Node. Enable only the local capabilities you intend to share.

   The installer includes Node.js and both `adc` and `adc-node`; no source checkout, npm or pnpm is
   needed. It asks for a device name and offers local access choices: choose folders, home, full
   trust, or decide later. A directory is not required for pairing. macOS uses launchd, Linux uses
   `systemd --user`, and Windows uses a least-privilege current-user Scheduled Task. Windows
   commands run in Windows PowerShell and Windows roots are addressed by `rootId`; `full` covers the
   current user's system drive, not other drives or UNC shares.

   The Ed25519 private key remains on the device. Unix stores it in the mode-0600
   `~/.config/adc/node.json`; Windows stores it under `%LOCALAPPDATA%\AgentDeviceCloud\config`.
   The daemon reconnects with backoff after connection loss.

3. In **Agent access**, select devices and use all their exposed folders, or select specific folders.
   All-folder access explicitly includes folders you expose on those devices in the future.
   The website displays the advertised physical paths without asking you to enter them again.
   Projects are optional workflow groups.
4. Choose capabilities (read, write, execution, or templates) and an independent approval policy
   (never, before changes/execution, before execution, or every device operation).
   `test.run` requires execution permission and a writable local root.
5. Connect an OAuth MCP client, or sign in with `adc login` and run `adc connect <access>`.
   ADC creates and stores the scoped CLI credential without asking you to copy it. Raw expiring
   access keys remain available under advanced settings for SDKs and legacy clients.

### Manage connected devices and authorizations

- **Devices → Manage**: rename a device, choose which exposed folders agents can use, make a folder
  read-only, or disable commands/tests for all agents on that device. The panel lists affected
  agents and provides a copyable command for adding another local folder.
- **Agent access → Edit**: change the name, devices, folders, capabilities, optional project and
  approval policy in place. Existing tokens and OAuth connections remain attached to the same grant.
  Reconnect MCP clients if they cache the old tool list; the server always checks current permissions.
- **Revoke** stops access and retains the record under the Revoked filter. **Delete** also removes
  the record from the management list. Deleting a grant invalidates its tokens/OAuth connections;
  deleting a device stops that device. Local files, historical receipts and audit are retained.
  Before pairing the same computer again, run `adc-node unpair --confirm <old-node-id>` locally;
  this removes only the old identity and preserves durable receipts.
- Both lists support search and Active / Revoked / All filters. Version checks prevent an older
  editor from overwriting newer changes.

Device controls in the console narrow the device's advertised local scope. Adding a new physical
directory or enabling home/full access remains a local owner action. New calls use saved restrictions
immediately; running commands are checked on the next lease renewal. An unreachable or revoked
device stops its running command by lease expiry. These console features also work with existing
paired connectors, without re-pairing or regenerating Agent tokens.

```bash
adc-node status
adc-node roots add "/path/to/workspace" --label Workspace
adc-node roots add "/path/to/another-folder" --read-only
adc-node roots list
adc-node roots remove root_id
adc-node templates add test --root root_id --command "pnpm test"
adc-node templates list
adc-node templates remove test --root root_id
adc-node access home
adc-node access full
adc-node access none
adc-node logs
adc-node restart
adc-node stop
adc-node start
adc-node rotate-key
adc-node uninstall
```

Repeat the installation command to upgrade; it preserves the existing pairing and folders and does
not consume another pairing code. Uninstall removes the service/program but keeps local identity and
receipts. Revoke the device in the console when retiring it. For noninteractive installation pass
`--label NAME --access none|home|full`, or `--label NAME --root-path /absolute/folder`;
`--read-only` restricts access and `--no-service` lets you start the daemon with `adc-node run`.
Directory/access changes reload without restarting. Removal or access downgrade cancels affected
running work. Reinstall preserves these newer local choices even if an old install command included
different directory flags.

### Register local MCP Providers

The device Connector can act as an MCP client for stdio or Streamable HTTP servers already available
on that machine. Registering a Provider discovers it with `tools/list`; it does not grant any Agent
access. Select the discovered tools separately in **Agent access**.

```bash
# Create this optional JSON file with a secure editor; do not pass secrets on the command line.
chmod 600 ~/.config/adc/github-mcp-env.json

adc-node mcp add github \
  --name GitHub \
  --stdio npx \
  --args '["-y","@modelcontextprotocol/server-github"]' \
  --env-file ~/.config/adc/github-mcp-env.json

adc-node mcp add internal \
  --name Internal \
  --http https://mcp.internal.example/api \
  --headers-file ~/.config/adc/internal-mcp-headers.json

adc-node mcp list
adc-node mcp remove github
```

Provider environment variables, headers and process details stay in local Node configuration and are
not advertised to the Control Plane. HTTP Providers require HTTPS except on loopback. The Connector
publishes only the tool title, description, input/output schemas and Provider identity, then forwards
`tools/call` locally after ADC authorization. Tool results still travel through ADC and must therefore
be treated as returned Agent data.

Use the same Provider ID on multiple devices when they represent the same logical Provider. ADC
derives `mcp.<provider>.<tool>.<schema-hash>` IDs, so an identical Provider tool appears once with
multiple valid `target.nodeId` choices. A schema change creates a new ID and requires explicit
authorization instead of silently changing an existing contract. Dynamic MCP tools default to
execution risk, require idempotency keys and are unavailable to read-only or unattended grants.

Full device trust uses the connector user's OS permissions, inherits its environment and disables
ADC's command, network-command and protected-filename filters. It does not elevate privileges.
Local writable flags, Agent capabilities, approvals, expiry, revocation and receipts still apply.
Selected folders and home access retain process guardrails, not an OS sandbox.

To host downloads separately, build and publish `dist/node/` as described in
[client distribution](docs/node-distribution.md). The download server and Control Plane can use
different domains.

Command templates are local Node configuration entries, never remote command interpolation:

```bash
adc-node templates add test \
  --root root_workspace \
  --command "pnpm test" \
  --timeout 300000
adc-node templates list
adc-node templates remove test --root root_workspace
```

The daemon reloads template changes automatically.
`projectId` is optional and can limit a template to a project. `readOnly` is descriptive;
it never grants execution on a read-only root or to a read-only Agent. Template parameters are
currently rejected. Template commands must be available on the device's tool PATH. `rootId` in this
local configuration is an internal stable binding; public calls select the device and absolute path.

## CLI, MCP, Skill and SDK

Sign in once to manage the account from the CLI:

```bash
adc login --url https://devices.example.com
adc device add --name "Work Mac" --json
adc device list --json
adc access create \
  --name coding \
  --devices "Work Mac" \
  --folders all \
  --capabilities run \
  --approval writes \
  --json
adc connect coding --json
adc status --json
```

`adc login` opens a short-lived browser authorization page, so GitHub and email accounts use the
same CLI flow. Confirm the code shown in both places; the resulting CLI login is independent from
the browser session and can be revoked from Account settings. Use `--no-open` to print the URL
without launching a browser. The legacy `--email you@example.com` form remains available for
password accounts. `adc connect` creates an expiring scoped connection and stores it locally
without printing its secret. Account and access context are resolved automatically. A sole device
is selected automatically; with multiple devices, add `--node NODE_ID`. Optional projects retain
project placement:

```bash
adc node list --json
adc tool list --json
adc tool show file.read --json
adc invoke file.read --node node_example --args '{"path":"/Users/me/work/README.md"}' --json
adc invoke file.write --node node_example \
  --args '{"path":"/Users/me/work/notes.txt","content":"hello"}' \
  --idempotency-key notes-first-write --json
adc invoke shell.exec --node node_example \
  --args '{"cwd":"/Users/me/work","command":"pnpm test"}' \
  --idempotency-key test-workspace-once --json
adc transfer create \
  --source-node node_source --source-root root_source --source-path models/model.bin \
  --destination-node node_target --destination-root root_target \
  --destination-path cache/model.bin \
  --idempotency-key model-copy-1 --wait 4000 --json
adc transfer wait xfr_example --wait 4000 --json
adc invocation status <invocation-id> --json
adc task status <job-id> --json
adc task wait <job-id> --wait 4000 --json
adc artifact get <artifact-id> --output ./artifact.log --json
adc audit show <invocation-id> --json
adc update --check --json
adc update
adc mcp
adc logout
```

Device policy, access, connection, project and approval management are available through
`adc device`, `adc access`, `adc connection`, `adc project` and `adc approval`; run `adc --help`
for command usage and add `--json` to operations whose output will be parsed. `adc update --check`
compares the installed build with the
current platform archive; `adc update` downloads the checksummed release, switches atomically and
restarts the Connector while preserving identity, folders and receipts. The current release format
contains its Node.js runtime, so updates download the complete platform archive. The console marks
desktop Connectors whose build differs from the published release, including legacy nodes without a
build ID. Interactive CLI commands use a daily local cache and detached refresh to print update
notices without delaying the foreground command; JSON, CI and MCP paths remain deterministic.

For advanced headless integrations, use `ADC_URL` + `ADC_TOKEN`, or import an access key with
`adc auth token --url URL --stdin`. Use `--password-stdin` for noninteractive login. Do not put
secrets in command arguments. Tool invocation and stdio MCP never inherit the user's account login.

Remote MCP uses `https://devices.example.com/mcp`: OAuth discovery → registration → login →
explicit grant selection → PKCE code exchange. Access tokens are resource-bound, short-lived and
revocable; refresh tokens rotate. The bundle enables dynamic client registration through
`ADC_OAUTH_DYNAMIC_REGISTRATION=true`; registration alone provides no tool access. Registered names
are client-provided, not an endorsement. CIMD and named third-party client compatibility still need
separate validation.

MCP exposes each logical device tool once. Its `target.nodeId` schema is generated from the
authorized devices whose latest effective capability advertises that tool. Multiple implementations
therefore become one tool with several valid targets, while a machine-specific tool has a single
valid target. Tools with no valid device instance are omitted. The model selects a listed Node
explicitly, and the Control Plane revalidates the grant, device capability and local scope before
dispatch because device state can change after discovery.

Token-based MCP clients can use:

```json
{
  "mcpServers": {
    "adc": {
      "url": "https://devices.example.com/mcp",
      "headers": { "Authorization": "Bearer <AGENT_TOKEN>" }
    }
  }
}
```

Install the [official Skill](skills/agent-device-cloud/SKILL.md) directly from the hosted service:

```sh
npx skills@latest add https://adc.zioon.tech --skill agent-device-cloud
```

Choose your Agent host when prompted; add `--global` to install across projects. The installer
requires Node.js 22.20 or later and npm. You can also [download the complete Skill ZIP](https://adc.zioon.tech/downloads/skills/agent-device-cloud.zip),
extract it into an `agent-device-cloud` directory and import that directory with your host.
Keep all `references/` files. No GitHub checkout is required.

Then ask: **Help me get started with ADC. Check my setup, connect my device and authorize this Agent.**
The Skill installs a missing ADC CLI using its bundled runtime, guides browser registration or
sign-in, reuses or pairs devices, connects selected access and verifies a first read-only tool call.
The user completes browser sign-in and confirms the login code. Installing the Skill itself does
not grant device access. Later requests use live discovery, approvals, task tracking and receipts.
Self-hosted builds publish the same discovery endpoints and ZIP through `pnpm build:skill` (also
included in `pnpm build`); replace the hosted origin with your installation's origin.

SDK callers use `AdcClient`, `buildInvocation` and the same scoped Agent token. All four entry points
use the same authorization, placement and receipt path. Side effects require a stable idempotency key.
CLI exits 20–24 represent denied, approval required, offline, unknown outcome and cancelled.

## GitHub login

Create a GitHub OAuth App, set its homepage to `ADC_PUBLIC_URL`, and its callback to
`<ADC_PUBLIC_URL>/api/auth/callback/github`. Configure `ADC_GITHUB_CLIENT_ID` and
`ADC_GITHUB_CLIENT_SECRET` on the server, then restart. For local development the callback is
`http://localhost:8787/api/auth/callback/github`. The button appears when both values are configured;
neither credential is sent to the console. See [deployment configuration](docs/deployment.md).

GitHub must return a verified email (including private primary emails). Closing registration also
blocks new GitHub users, while existing users can still log in. Existing unverified email accounts
must first sign in with their password and explicitly **Account → Connect GitHub**; they are never
silently merged by email. Both sides must use the same email address.

## Develop and verify

Set `.env` to a reachable PostgreSQL 16+ database, `ADC_PUBLIC_URL=http://localhost:8787`, a generated
auth secret, and `ADC_REQUIRE_EMAIL_VERIFICATION=false` if no SMTP is available.

```bash
pnpm install --frozen-lockfile
pnpm build:node
pnpm dev
```

This builds the console, loads `.env`, and serves UI and API together at http://localhost:8787.
`pnpm build:node` creates the downloadable clients; Docker builds them automatically. Source developers
can use `pnpm adc` / `pnpm adc-node` in place of installed launchers.
For UI hot reload, use `ADC_PUBLIC_URL=http://localhost:5178` and run
`pnpm --filter @adc/console exec vite` alongside the API; open port 5178 so auth stays same-origin.

```bash
pnpm build
pnpm lint
pnpm format:check
pnpm test
pnpm audit --prod
```

Tests start disposable real PostgreSQL processes without Docker. `ADC_TEST_DATABASE_URL` can select
a disposable external database for store integration tests. In-memory stores are test fixtures;
the running application always requires PostgreSQL.

Focused fixes, tests, documentation and integrations are welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and report suspected
vulnerabilities through the private process in [SECURITY.md](SECURITY.md), never through a public
issue.

## Operations and execution boundary

`GET /health` checks database connectivity; `GET /metrics` requires a user session. Back up PostgreSQL
and preserve the auth secret before upgrading; migrations run under locks before serving requests.
See [deployment operations](docs/deployment.md) and [implementation status](docs/implementation-status.md).

Public file APIs use `nodeId` plus canonical absolute paths. The control plane records those paths
for understandable authorization, approval and audit views; installations should treat path names as
account metadata. The Node maps each path to its most specific advertised root and then applies
mode-dependent sensitive-path checks, bounded reads and atomic writes. Legacy `rootId` plus relative
path calls remain accepted during migration. Node receipts survive restarts; uncertain effects
return `unknown_outcome`. Processes stop on cancellation, timeout or lease expiry. Long output uses
authenticated artifacts.

`file.transfer` copies a regular file between devices or from an Agent to one device. Production
uses private OSS with short-lived direct-upload/download tickets; file bytes bypass ADC.
Select `ADC_TRANSFER_BACKEND=oss` and configure the private bucket. Transfers default to disabled,
with a 1 GiB file limit and eight active transfers per account. Explicit `local` relay remains
available for small self-hosted installations. Destinations are verified and never overwritten.
See [file transfer](docs/native-node-transfer.md).

`restricted-process` executes with the Node OS user's authority. Its command classifier and output
redaction are guardrails; arbitrary code can access host files and networking. Node's portable path
checks also cannot eliminate every hostile parent-directory race. Grant command execution only to
trusted agents or run the Node under an appropriately isolated OS identity. A container executor,
OS keychain integration and resource quotas are not implemented.
See the [threat model](docs/threat-model.md).
