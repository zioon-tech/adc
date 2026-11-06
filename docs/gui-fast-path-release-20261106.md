# GUI fast-path release preparation

本次改动归属 ADC。实验曾在其他仓库目录内保存，正式源码已整理为 ADC 的独立工作区及
`examples/gui-executor` Python 示例，不包含 LAS 业务变更。

## Versions

| Component                            | Candidate              |
| ------------------------------------ | ---------------------- |
| CLI / Desktop Connector distribution | 0.1.8                  |
| SDK `@adc/client`                    | 0.2.4                  |
| Invocation protocol package          | 0.1.2                  |
| Android testing channel              | 0.2.7 / versionCode 13 |
| Standalone GUI executor example      | 0.1.0                  |

Desktop Node 的实现目录、CLI 发行归档、SDK 和 Android 分别保留自己的版本职责。
客户端归档继续包含 Node 24.21.0；源码构建使用 Node 22.18.0 与 pnpm 9.14.2。

## Behavior

- Android 复用 HTTP 连接，限制 DNS 和调用时间，不自动重放 POST。
- 动作后的界面观察可随回执返回，减少单独读取界面的往返。
- 新快照引用有容量及有效期限制；选择器利用可点击祖先和同一行的上下文。
- 应用覆盖升级恢复 Node 与无障碍绑定，控制到期和用户接管仍停止新动作。
- SDK 支持独立请求预算；Python 示例复用常驻 MCP，区分模型与工具失败。
- Python 的按键序列最多 8 步，各步仍使用新快照、独立幂等键和公开 ADC 调用。
- 200 ms 的观察等待保留真机验收版本，未采用表现更慢的 500 ms 实验配置。

## Validation and publication

真机实验的 6 个目标、42 个里程碑均完成；481 次工具调用中位数 0.597 秒、P95 0.975 秒。
这些是该实验条件下的结果，不是所有设备的性能保证。
本地验证已完成：

- Python 示例回归 146 项，Ruff 和编译检查通过；wheel 包含独立入口和 3 个诊断目标。
- ADC TypeScript 单元测试 298 项通过，数据库集成 12 项通过。
- E2E 共 54 项通过、2 项保留原跳过状态；安装测试因磁盘不足失败后重跑通过。
- Android release 单测 80 项通过，Lint 和 release 构建通过。
- 客户端归档检查覆盖五个平台、实际 CLI 调用、SDK 离线安装、TypeScript 类型编译及 Node 签名协议。
- 客户端归档自带 Node 24.21.0 访问正式 `/health` 返回 200。
- Android 0.2.7 已在本次真机覆盖安装；通过线上 ADC 核验新版本、无障碍读取和已交还的屏幕控制。

构建过程中清理了本次产生的运行时下载缓存与临时解包目录，解决磁盘不足引起的验证失败。
变更涉及的 TypeScript 文件通过 ESLint，仓库全量 ESLint 仍存在 16 个已有错误，
涉及未修改的认证、部署脚本和其他模块；不将该项声明为全量通过。
格式检查、协议生成检查、TypeScript 类型检查和 `git diff --check` 通过。

Android APK SHA-256 为 `9599786998a0a83852e0da4121d3dccbf61973d92a739bd6968cf01fd442714a`，
签名证书与现有测试渠道一致。手机覆盖安装通过不代表公开下载已切换。

发布必须先上传签名 APK 到 `android-v0.2.7` GitHub Release，再让
`apps/android-node/release.json` 固定其 SHA-256、大小、版本与证书。
随后合并代码，选择成功的 main CI 制品，以同一 CI 依次预检、发布 service、
client-tools、console-and-site，并运行 client-tools 下载目录激活。
最终从公开下载入口重新核对版本、归档 SHA-256 和健康状态。

截至此准备记录，正式 main CI、GitHub Release 与生产下载激活尚未完成。
本机 `gh auth status` 未登录；SSH Git 连接可用。必须恢复 GitHub CLI 授权后才能继续正式流水线。
本地构建产物不代表正式下载已更新。
