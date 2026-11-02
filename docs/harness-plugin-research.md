# ADC Harness Plugin Research

Research date: 2026-10-16. These findings come from current official documentation and local
source inspection. A documented integration format is not evidence that ADC has been accepted
into that vendor's marketplace.

## Supported integration surfaces

| Harness                                     | Verified mechanism                                                                                                                                 | ADC delivery                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Claude Code                                 | `.claude-plugin/plugin.json`, Skills, Markdown commands, `.mcp.json`, plugin marketplaces                                                          | Native plugin bundle and marketplace                            |
| ChatGPT / Codex                             | Agent Plugins 1.0 root `plugin.json` and `mcp.json`; optional `.codex-plugin/plugin.json`; `.agents/plugins/marketplace.json`                      | Portable bundle with an OpenAI onboarding skill                 |
| Cursor                                      | Agent Plugins 1.0 or `.cursor-plugin/plugin.json`; Skills, commands, MCP; `.cursor-plugin/marketplace.json`                                        | Portable bundle and Cursor overlay                              |
| GitHub Copilot / VS Code                    | Agent Plugins 1.0, portable Skills/MCP; `com.github.copilot` commands and other components                                                         | Portable bundle with command overlay                            |
| OpenCode                                    | Local `.opencode/plugins/*.js` or npm plugin factories; config hook, tool hook, commands, MCP OAuth                                                | Executable adapter and configuration example                    |
| Gemini CLI                                  | `gemini-extension.json`, Skills, TOML commands, MCP; local extension install/link                                                                  | Native extension bundle                                         |
| Pi                                          | Package `pi.extensions`, `pi.skills`, `pi.prompts`; `registerCommand`, `registerTool`, terminal UI; modern versions also offer `registerMcpServer` | Executable extension and package                                |
| Cline SDK / CLI / Kanban                    | `AgentPlugin`, `createTool`, `cline.plugins` package entry points, bundled Skills, HTTPS single-file installation                                  | Executable plugin and package                                   |
| Factory Droid                               | `.factory-plugin/plugin.json`, Skills, commands, `mcp.json`, marketplaces; Claude layout compatibility                                             | Native overlay and marketplace                                  |
| Zion                                        | Separate Workbench/Runtime entries, Plugin API v2, runtime tools/context/state/commands, ZIP installer, contributed Skills                         | Native sidebar and account-scoped Runtime adapter               |
| OpenClaw                                    | Agent Plugins / Claude / Codex / Cursor content bundles; portable Skills and MCP mapping                                                           | Portable bundle; no unnecessary native runtime rewrite          |
| Kiro, Hermes, OpenHands, NanoClaw, Grok Bot | Listed by Agent Plugins as portable-format clients with Skills and MCP support                                                                     | Portable bundle; document each client's installation and limits |
| TRAE                                        | Official Skills and MCP configuration; TraeWork marketplace exists, but no verified public authoring/submission contract in this research          | Existing Skill plus MCP recipe; do not invent a native manifest |

Cline's plugin feature does **not** currently apply to its VS Code or JetBrains extensions.
OpenClaw recognizes some vendor-specific hook files without executing them. Portable installation
does not mean every vendor-specific component is supported.

## Portable contract

The Agent Plugins 1.0 manifest schema is closed:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "agent-device-cloud",
  "version": "0.1.0",
  "description": "Connect authorized devices and track ADC work."
}
```

Portable components are discovered from root `skills/` and root `mcp.json`. Use separate
vendor overlays when a host needs commands, UI or other settings. The MCP schema is also closed:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "adc": {
      "type": "streamable-http",
      "url": "https://adc.zioon.tech/mcp"
    }
  }
}
```

OAuth can use the endpoint's existing discovery and DCR. Do not put tokens in packages.
OpenAI's documentation shows authentication extensions that its own connection tooling accepts;
those extra fields are not accepted by the portable MCP 1.0 schema fetched during this research.
Keep the portable file valid and avoid claiming a vendor extension is portable.

Cursor expands `${CURSOR_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}`, but not the portable
`${PLUGIN_ROOT}`/`${PLUGIN_DATA}` placeholders. Remote MCP avoids those executable path differences.
Gemini filters inherited environment variables; declare any required settings explicitly.
Claude/Droid/Gemini command layouts differ and must be generated independently.

## Zion source evidence

The current Runtime implementation is in
`/Users/bytedance/Downloads/zion-next/.worktrees/core-observability`, branch
`feature/core-observability`, committed head `08af0024`, with substantial existing user changes.
The root `/Users/bytedance/Downloads/zion-next` and `/Users/bytedance/Downloads/gits/zion-next`
are older distinct checkouts. Preserve all existing changes.

Important current interfaces:

- `packages/plugin-sdk/src/manifest.mjs`: manifest version 2; `entries.workbench`,
  `entries.runtime`, `entries.skill`, `hosts`, capability declarations; legacy `entries.ui`
  remains an alias.
- `apps/runtime/src/runtime-plugin-service.mjs`: export `runtimePluginApiVersion = 2`,
  `activateRuntimePlugin(context)`; use `context.tools.registerTool`,
  `context.context.registerProvider`, `context.runs.registerCommands`, and
  `context.state.namespace`. Tool invocation receives the authenticated `principal`,
  Run/Attempt/Session identities and cancellation signal.
- `apps/runtime/src/server.mjs`: `POST /v1/plugins/:id/commands` requires a real `sessionId`,
  passes `request.zionPrincipal`; mutations require `run.execute`.
- `apps/runtime/src/accounts/account-access-control.mjs`: only `dev.goal` and
  `dev.context-compression` command routes currently receive the `runtime.read` route policy.
  Other plugin command routes fall back to `runtime.manage`. ADC needs an explicit host policy
  addition if ordinary members are to use its sidebar commands.
- `src/runtime/runtime-plugin-commands.ts`: Workbench route client, active Session selection,
  runtime config and `credentials: include`. A distributable plugin must not import this source
  by an external relative path; reproduce the small public HTTP adapter within its package.
- `src/plugin/http-installer.ts` and `tests/http-plugin-installer.test.ts`: ZIP file import,
  relative JS module rewriting, contributed styles, `scriptContents` and `sourceEntries`.
- `docs/layout/09-plugin-guide.md`: `window.zion.commands`, `sideBar`, `statusBar`, `state`,
  events, subscriptions, and contributed Skills.

Zion's ongoing harness abstraction is in the separate
`/Users/bytedance/Downloads/zion-next/.worktrees/harness-integration` worktree. Its architecture
keeps business contributions in a shared Extension IR and lets Runner adapters map them to
vendor APIs. ADC should fit that direction instead of reimplementing a harness loop.

## Local host versions

Detected without changing user installations:

- Claude Code: `2.1.63`.
- Codex CLI: `0.131.0`.
- Pi: `0.74.2`.
- Gemini, OpenCode, Cline and Droid executables were not found on PATH.

Latest documentation contains capabilities newer than these local versions. Test version
compatibility explicitly; do not infer that Pi 0.74.2 has the latest MCP registration API.

## Official sources

- [Agent Plugins authoring](https://agent-plugins.org/plugin-authors)
- [Portable manifest schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)
- [Portable MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json)
- [Compatible clients](https://agent-plugins.org/compatible-clients)
- [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude components](https://code.claude.com/docs/en/plugins/components)
- [Codex plugin build guide](https://developers.openai.com/codex/plugins/build/)
- [Cursor plugin reference](https://cursor.com/docs/reference/plugins)
- [VS Code Agent Plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [OpenCode MCP and OAuth](https://opencode.ai/docs/mcp-servers/)
- [Gemini extension reference](https://geminicli.com/docs/extensions/reference/)
- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [Pi packages](https://pi.dev/docs/latest/packages)
- [Cline plugin installation](https://docs.cline.bot/customization/plugins)
- [Cline plugin authoring](https://docs.cline.bot/sdk/guides/writing-plugins)
- [Droid plugins](https://docs.factory.com/harness/plugins)
- [Droid marketplace format](https://docs.factory.com/enterprise/internal-plugin-marketplaces)
- [OpenClaw bundle mapping](https://docs.openclaw.ai/plugins/bundles)
- [TRAE MCP configuration](https://docs.trae.ai/ide/add-mcp-servers)
- [TraeWork marketplace](https://docs.trae.cn/work_plugins.md)
