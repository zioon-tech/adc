# ADC harness plugin validation

Plugin release: **0.1.1**. Validation date: **2026-10-16**.

The focused ADC suite passed **40 tests**; Zion's host routing suite passed **2 tests**.
Schema checks, TypeScript, ESLint, formatting, production build and diff checks passed.

The control plane adds a server-calculated `online` field to `device.list` and `device.status`
outputs, using the existing presence timeout. This is an additive response change; authorization,
invocation schemas, task identities and billing behavior remain unchanged.

## Evidence layers

The distribution test builds all eleven host packages and the complete marketplace twice,
compares SHA-256 hashes, validates the pinned closed Agent Plugins 1.0 schemas, verifies every
shared Skill against source, and checks download allowlists, immutable caching and symlink rejection.

`tests/harness-execution.e2e.test.ts` runs the actual ADC HTTP control plane, signed paired Node
and NodeDaemon. Both the public CLI subprocess and shared SDK adapter discover the same scope.
It checks read/write separation, actor-scoped idempotency across adapters, actual file execution,
terminal receipts, cancellation of the existing task and approval-sensitive work that has not executed.
Identity is injected in this test; production identity/OAuth is covered by the existing identity tests.

Core/OAuth/Zion boundary tests cover live JSON Schema, device selection, unavailable tools,
per-user state, scoped credentials, PKCE, callback expiry and single consumption, refresh/revocation,
host effect policies, task refresh and disposal cancellation. Zion stores credentials under the
host's `private` namespace, which is excluded from Workbench snapshots and direct KV access.

## Real host checks

`scripts/validate-plugin-hosts.ts` validates extracted release packages in temporary directories.
It uses isolated Claude/Codex configuration and cleans it on completion. Optional host/SDK paths
make these checks reproducible without adding those hosts as production dependencies.

```sh
node --import tsx scripts/validate-plugin-hosts.ts --claude --codex \
  --pi-loader /path/to/pi/dist/core/extensions/loader.js \
  --sdk-root /path/to/isolated/node_modules \
  --zion-root /path/to/zion/source
```

Claude Code 2.1.63 provides a real manifest validator and local marketplace installer.
Codex CLI 0.131.0 provides a real local marketplace installer.
Pi 0.74.2 provides the actual extension loader and public tool/command registry.
Cline SDK 0.0.93 and OpenCode plugin SDK 1.19.0 provide the actual package exports and registration helpers.
Zion's current Plugin API v2 provides the real RuntimePluginService and Workbench ZIP installer.

| Host                | Passed validation                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code 2.1.63  | Manifest validation, local marketplace registration and plugin installation                                                                                       |
| Codex CLI 0.131.0   | Local marketplace registration and plugin installation using the bundled compatibility manifest                                                                   |
| Pi 0.74.2           | Actual extension loader, six tools, `/adc` command, noninteractive mutation rejection and shutdown                                                                |
| Cline SDK 0.0.93    | Actual host plugin loader, six tools, one command, one rule and self-contained onboarding for single-file installation                                            |
| OpenCode SDK 1.19.0 | Actual tool helper, bundled entry import, six tools, four commands and disposal                                                                                   |
| Zion Plugin API v2  | Runtime activation, six tools with four available under read-only policy, ZIP import, three Skills, CSS, private-state snapshot filtering and direct KV rejection |

## Compatibility limits

Cursor, Copilot/VS Code, Gemini CLI, Droid and portable layouts follow current official
documentation and package/schema checks; they have not been interactively certified in this environment.
The test machine has no corresponding installed applications. Cline native plugins apply to
SDK/CLI/Kanban, not its VS Code or JetBrains extensions.

No public vendor-store listing or npm package is published. Use the HTTPS downloads and local
installation instructions. Production OAuth consent belongs to the user; automated checks do not
claim to have completed a human's consent on every vendor. OAuth endpoints and actual ADC identity
are reused, not replaced by host-specific credentials.

Zion requires the included narrow host routing/Origin additions and one Runtime OAuth state
writer. Concurrent writers sharing a persistent state store need distributed transaction/locking.
Node adapters require Node.js 22+. A stopped or timed-out client does not imply cancellation of
an already submitted ADC task: inspect the existing invocation/receipt.

## 中文说明

验证区分包结构、真实 ADC 执行链路、宿主加载三层。真实执行测试包括公共 CLI、SDK、
已配对 Node 与 NodeDaemon，检查幂等、文件执行、回执、取消和独立审批。
Zion 凭据按用户隔离并保存于宿主私有状态，浏览器不持有 token。

Cursor、Copilot、Gemini、Droid 和通用包已按官方契约生成并检查，但当前环境没有这些客户端，
不宣称已经完成逐一交互认证。安装包可从官网获取；尚未上架厂商商店，也未发布 npm 包。
生产 OAuth 登录与审批需要用户本人完成。
