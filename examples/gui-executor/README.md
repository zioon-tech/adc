# ADC GUI executor

这个独立 Python 示例把一次有界 GUI 目标交给本地常驻执行器。它复用一个公开 `adc mcp`
进程，模型根据界面观察产生动作，ADC 继续负责授权、屏幕控制、执行与回执。
示例不依赖 LAS、Zioon 工作区或私有 ADC 接口，也不读取 ADC 的凭证文件。

## 安装与运行

需要 Python 3.10+ 和已连接、已授权的 ADC CLI。先使用公开 CLI 检查连接、在线设备与工具：

```sh
adc --version
adc status --json
adc node list --json
adc tool list --json
python3 -m pip install './examples/gui-executor[test]'
```

通过 `ARK_API_KEY` 和 `ARK_ENDPOINT` 环境变量提供模型服务配置。
`ARK_ENDPOINT` 应为完整 HTTPS Chat Completions 地址。密钥由调用方在自己的环境中设置，
不得写入目标文件、执行日志或源码。也可显式传入 `--config /private/path/model.yaml`，
配置支持 `endpoint`、`api_key`，以及已有的 `default_endpoint`、`default_model`、`models` 格式。
没有显式配置时不会搜索其他应用的配置文件。

```sh
adc-gui-executor run \
  --node NODE_ID \
  --goal examples/gui-executor/goal.example.json \
  --output /tmp/adc-gui-my-task
```

输出目录必须不存在。`--model` 选择模型，`--supervisor-model` 指定异常恢复用的更强模型；
`--detach` 启动独立本地进程并返回 PID。`--transport cli` 提供逐步公开 CLI 兼容模式，
默认使用常驻 MCP。`--agent-decisions` 可接入宿主 Agent 的决策邮箱。
执行记录区分模型、工具往返、已报告的设备耗时和未测量时间。

## 执行边界

目标文件明确限定应用、步骤和总时间。执行器显式开始屏幕控制，每个动作携带当前 token，
在退出路径交还控制；用户接管、拒绝、结果未知或超时均不能触发动作重放。
只有当前工具目录声明支持 `includeObservation` 时才请求动作后的观察。
后续选择器绑定新 snapshot；歧义、失效引用和反复无进展会触发重新观察或监督。
本地按键序列最多 8 步，各步仍通过独立公开 ADC 动作，并使用各自幂等键。
200 ms 的观察等待保留自本次真机验收版本。

`--usb SERIAL` 与 `adc_gui_executor.usb_benchmark` 仅用于设备所有者明确授权的诊断。
USB 基准使用 ADB/UIAutomator，必须先停止 ADC 屏幕操作，避免抢占无障碍服务。
它的本地结果不代表云端 ADC 回执。

## 验证

```sh
python3 -m pytest examples/gui-executor
python3 -m ruff check examples/gui-executor
```

测试覆盖真实管道上的 MCP 分帧、进程复用、超时与迟到响应隔离、清理专用重连，
以及目标证据、选择器恢复、序列中断、控制交还和日志脱敏。
