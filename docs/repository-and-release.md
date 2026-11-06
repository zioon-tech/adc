# Repository and release

ADC 源码归属 `zioon-tech/adc`。维护团队为 `adc-maintainers`。现有 Apache-2.0 许可证保持不变；公开 Issue 与 PR 欢迎独立参与。

| 目录                              | 归属                                     |
| --------------------------------- | ---------------------------------------- |
| `apps/control-plane`              | 服务和账户、授权、dispatch、receipt 路由 |
| `apps/node` / `apps/android-node` | 设备 Connector 与 Android Node           |
| `apps/cli`                        | ADC CLI                                  |
| `apps/console`                    | 控制台、官网、文档网页                   |
| `docs`                            | ADC 使用、集成、架构与部署文档           |
| `packages`                        | 协议、SDK、数据库、授权及设备工具执行    |
| `plugins` / `skills`              | Zioon、MCP 及其他 Agent 的集成           |

使用 Node 22.18.0 与 pnpm 9.14.2，通过 `pnpm install --frozen-lockfile` 安装。

```sh
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:e2e
```

GUI 常驻执行器的可移植示例位于 `examples/gui-executor`，使用独立 Python 包与测试配置；
它不依赖其他业务仓库。CI 同时运行 Python 回归及静态检查，以及 Android release
单测、Lint 和无签名构建。Android 签名继续在受控的本地发布步骤完成。

PR 和主分支通过固定 SHA 的通用工作流执行检查。官网、文档与控制台保持现有共用前端实现；其静态构建与服务检查分开，文档变更不会部署或重启后端。

在本产品仓库发起 `Production release`，调用固定 SHA 的共享发布工作流；私有 `zioon-tech/infra` 管理生产配置、云权限和运行手册。选择 main 已成功的 CI 制品，校验来源、commit 和 SHA256，检查磁盘，原子切换对应组件的发布目录，执行 HTTP 健康检查并保存回滚记录。Connector 按平台产生独立、带版本与校验和的制品。

```sh
gh workflow run release.yml --repo zioon-tech/adc --ref main \
  -f component=console-and-site -f ci-run=<successful-main-ci-run-id> -f check-only=true
# 预检通过后，用相同 component 和 ci-run 将 check-only 改为 false。
```

`console-and-site`、`service` 与 `client-tools` 独立发布。静态目录切换无需重启 ADC 服务。
`client-tools` 制品包含五个平台的 CLI/Connector 和可安装的 SDK 包；CI 从实际归档运行 CLI，
验证调用意图与控制会话字段，并在隔离目录离线安装 SDK、编译 TypeScript consumer 和验证签名协议。
生产下载目录使用 `/srv/adc-client-tools/current/node` 与 `/srv/adc-client-tools/current/sdk`，
分别通过 `ADC_NODE_RELEASE_DIR` 和 `ADC_SDK_RELEASE_DIR` 配置。服务器不重新构建客户端。

统一 Zioon 登录协议由 Zioon 维护；ADC 保留自托管认证与工具 OAuth。已有生产登录兼容路由的进程拆分需要独立迁移，不能随着本次仓库整理更换账户身份或 issuer。
