ADC plugins provide connection guidance, live device/tool discovery, device work, existing-task
tracking, receipts and independent human approval. Plugin version: **0.1.1**.

Download from [ADC integrations](https://adc.zioon.tech/docs/integrations#plugins).
The ZIPs contain the complete package, including Skills and bundled runtime dependencies.
There is no published npm package or vendor-store listing to install yet.

## Install

The easiest shared download is
[`agent-device-cloud-marketplace.zip`](https://adc.zioon.tech/downloads/plugins/agent-device-cloud-marketplace.zip).
Extract it into `adc-plugins/`. The paths below are relative to that folder. Individual host ZIPs
contain the contents of their corresponding `packages/<host>/` folder.

| Host                        | Installation                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                 | `claude plugin marketplace add /absolute/path/adc-plugins`, then `claude plugin install agent-device-cloud@adc-plugins`                                                                                       |
| Codex                       | `codex plugin marketplace add /absolute/path/adc-plugins`, then `codex plugin add agent-device-cloud@adc-plugins`                                                                                             |
| ChatGPT                     | Add ADC's HTTPS MCP endpoint through **Plugins → Add custom MCP server**, authenticate, and use the Codex package/local marketplace on supported desktop surfaces                                             |
| Cursor                      | The archive contains `.cursor-plugin/marketplace.json` and `packages/cursor/`. Use a supported local/team plugin source; public marketplace submission requires a public Git repository and vendor acceptance |
| Copilot / VS Code           | Enable `chat.plugins.enabled`; add the absolute `packages/copilot` directory to `chat.pluginLocations` with value `true` in VS Code settings                                                                  |
| Gemini CLI                  | `gemini extensions install /absolute/path/adc-plugins/packages/gemini`, then restart Gemini                                                                                                                   |
| Factory Droid               | `droid plugin marketplace add /absolute/path/adc-plugins`, then `droid plugin install agent-device-cloud@adc-plugins`                                                                                         |
| Pi                          | `pi install /absolute/path/adc-plugins/packages/pi`, or test without installation with `pi -e /absolute/path/adc-plugins/packages/pi/index.mjs`                                                               |
| Cline SDK / CLI / Kanban    | `cline plugin install /absolute/path/adc-plugins/packages/cline`, or use the single-file command below                                                                                                        |
| OpenCode                    | Copy `packages/opencode/index.mjs` to `.opencode/plugins/agent-device-cloud.js`; declare `@opencode-ai/plugin >=1.19.0` in `.opencode/package.json`, install it, and restart OpenCode                         |
| Zion                        | Import the Zion ZIP in the plugin manager. Use Plugin API v2 Runtime; apply the included narrow host compatibility patch below                                                                                |
| TRAE                        | Install the official Skill and add the ADC HTTPS MCP endpoint in MCP settings                                                                                                                                 |
| Other Agent Plugins clients | Use `packages/portable`, following the client's local plugin installation mechanism; portable components are Skills and MCP                                                                                   |

Cline single-file install:

```sh
cline plugin install https://adc.zioon.tech/downloads/plugins/agent-device-cloud-cline.mjs
```

Run `/adc setup` after single-file installation. The module embeds the complete getting-started
guide, so setup does not depend on a separate Skill folder.

For a Cline SDK application, import `createAgentDeviceCloudPlugin` from the bundled `index.mjs`.
Pass `allowSideEffects: true` only when your application explicitly enables device execution.
Use Cline's `toolPolicies` with `autoApprove: false` for `adc_invoke`/`adc_cancel` and supply
`requestToolApproval` when the host requires confirmation.

OpenCode asks its public `context.ask` permission interface for device mutations. The included
`opencode.example.json` shows the `adc_execute: "ask"` policy. Pi prompts before mutations.
Cline starts each session in read-only mode; `/adc mode execute` enables ADC execution for that
session, and `/adc mode read` disables it.

Cline's native plugin mechanism currently applies to SDK/CLI/Kanban, not its VS Code or
JetBrains extensions. For those extensions, use the Skill plus MCP.

## Start using ADC

After installation, say **“Help me start using ADC and connect an authorized device.”**
On Chinese hosts: **“帮我开始使用 ADC，引导我连接设备并配置授权。”**

MCP hosts authenticate against `https://adc.zioon.tech/mcp` using OAuth discovery and dynamic
client registration. Users sign in and select scoped authorization on ADC. Local OpenCode,
Pi and Cline adapters require the public `adc` CLI and its scoped connection:

```sh
adc login --url https://adc.zioon.tech
adc connect ACCESS
adc status --json
```

Use the bundled setup Skill for CLI installation and requested device/access setup. Installing
a plugin does not implicitly pair its computer or grant access. Device execution always uses
the existing scoped Agent authorization.

Common workflows are setup, devices, tasks and approval. Native adapters expose
`adc_status`, `adc_discover`, `adc_read`, `adc_invoke`, `adc_task` and `adc_cancel`.
MCP hosts use the live advertised ADC tools. Select the device and platform before work.
Tasks retain invocation/job IDs, approval state and receipts. A timeout waits on the existing
operation; `unknown_outcome` requires reconciliation. The human reviews approvals at
`https://adc.zioon.tech/approvals`.

## Zion

The ZIP separates Workbench UI, Runtime authority and contributed Skills. The Workbench shows
connection, selected device, authorized folders, tasks and approval links. OAuth tokens remain
in Runtime state, keyed by the authenticated Zion space and user. User/model arguments cannot
choose an account or credential. A validated Run principal maps to that same user's connection.

Current Zion account routing needs two narrow host additions, supplied in `host-compat.patch`:
allow this plugin's command route under `runtime.read`, while the router continues to enforce
`run.execute` for mutations; pass the authenticated request Origin to validate OAuth callbacks.
From the Zion source root:

```sh
git apply --check /absolute/path/packages/zion/host-compat.patch
git apply /absolute/path/packages/zion/host-compat.patch
```

Enable `dev.agent-device-cloud` through the Runtime's installed plugin configuration (or
`ZION_RUNTIME_PLUGINS` alongside your existing plugins). For a Runtime with filesystem plugin
discovery, place the complete Zion package under its configured plugin root. Import the same
ZIP in Workbench and restart Runtime after changing its plugin configuration.

Open a Zion conversation, then **ADC → Connect ADC**. Sign in and choose authorization on ADC,
return to Zion, and choose a device. The callback uses the Workbench origin and PKCE. Runtime
checks principal, state and expiry and consumes the callback once. Disconnect clears that
user's local connection and requests ADC token revocation. Generic side-effect tools require
the host's `trusted-automation` policy; read tools are available under `read-only`.

Runtime operators can supply `serviceUrl` and `redirectOrigins` through Plugin API v2's
`configByPluginId["dev.agent-device-cloud"]` when using another ADC deployment.
Use one Runtime process as the OAuth state writer; multi-process shared-store deployments
need a distributed transaction/lock before enabling concurrent callback/token refresh.

## Package and compatibility boundaries

Portable Agent Plugins 1.0 schemas are closed. Vendor commands remain in vendor layouts;
the portable MCP file contains no nonportable auth fields. OpenClaw, Kiro, Hermes, OpenHands,
NanoClaw and other compatible clients can consume the portable components their versions
support. This does not imply they execute every vendor overlay or provide identical UI.

Native Node adapters require Node.js 22 or later. Real loading is verified separately from
schema validation and ADC fixture execution in the [validation report](../docs/harness-plugin-validation.md).
Public marketplace acceptance and a human's production OAuth consent are separate steps.

Developers: `pnpm build:plugins` generates deterministic archives, marketplace directories,
an index and SHA-256 checksums. `plugins/workflows/` is the shared instruction source;
`packages/harness-core/` implements discovery, validation, invocation, task projection and
connection state. Host adapters contain only registration, interaction and lifecycle mapping.
