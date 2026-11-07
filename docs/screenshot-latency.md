# Screenshot transport

## English

`screen.capture` keeps the default lossless PNG format. For interactive model
control, an updated Android Node and Control Plane also accept
`{"format":"jpeg","quality":85,"maxWidth":720}`. JPEG quality is an integer from
1 to 100, defaulting to 85; it has no effect on PNG. Lower quality reduces detail
and must be validated against the model's actual targets.

The result reports the actual `contentType`, dimensions, byte count and SHA-256.
Android also reports `timings.frameWaitMs` and `timings.encodeMs`, in milliseconds.
These timings exclude indicator hiding, scheduling, upload and download; they
are not end-to-end latency.
In the repaired candidate, the frame stage includes copying pixels, while the
encode stage covers bitmap scaling, compression and hashing.

The updated local `adc mcp` and hosted HTTP MCP expose screenshot and log artifacts as MCP resources.
Read `adc://artifacts/<artifactId>` using `resources/read` on the same connection.
The response contains a base64 `blob` and MIME type. This reuses the authenticated
public artifact API and HTTP connection without starting a CLI process per image.
Resource reads recheck server authorization every time; they do not cache bytes,
broaden grants or require owner credentials. `adc artifact get` remains supported.
Successful `screen.capture` calls also include an MCP image content block while
preserving the JSON result and receipt. Completed screenshots returned by
`task.status`, `task.result` or `task.wait` include the same image block. If delivery
fails, the response retains the capture metadata and reports an image delivery
error. Refresh or reconnect existing MCP clients after the service update.

Deploy the Control Plane before requesting JPEG from an updated phone. Existing
PNG clients and log artifacts remain compatible. Update the APK using the same
signing certificate and restore Android screen-sharing consent after restart.
Measure the real ADC service path; USB is only for development and installation.

An updated Android Node also negotiates inline task acknowledgement with the service.
This removes one signed request per task, including ordinary phone operations.
Older services keep separate acknowledgement. See
[ADR-0007](adr/0007-inline-dispatch-ack.md) for cancellation, lease and delivery semantics.

Capture recovery uses a continuously drained single-frame queue. Each request rejects
frames predating the request or overlay hide. After 250 ms without an eligible frame,
Android reconnects a new consumer Surface to the existing authorized VirtualDisplay
once, then waits up to another 1750 ms. It never creates a second display from reused
consent or returns an old cached image on timeout. Results include
`timings.recoveryCount`. Stalled sharing is advertised as temporarily unavailable;
new frame arrival clears that state, and the permissions page provides a restart action.
These are local candidate semantics; live acceptance is tracked in
[capture repair verification](../CAPTURE-REPAIR-VERIFICATION.md).

## 中文

截图默认仍为无损 PNG。新版 Android Node 与服务端支持
`{"format":"jpeg","quality":85,"maxWidth":720}`；JPEG 质量范围为 1–100，
省略时为 85。PNG 忽略质量参数。画质降低后需要验证模型能否准确定位目标。

截图结果包含实际格式、尺寸、大小、SHA-256，以及等待帧和编码的分段耗时。
分段耗时不包含指示器隐藏、任务调度、上传和下载，不能当作完整链路耗时。
当前修复候选的帧阶段包含像素拷贝，编码阶段包含缩放、压缩与哈希；
分段边界与旧版不同，不宜直接按分段数值计算性能提升。

新版本地 `adc mcp` 与托管 HTTP MCP 可在同一连接上通过 `resources/read` 读取
`adc://artifacts/<artifactId>`，返回 base64 图片和 MIME 类型。每次读取仍经过
公共 API 的权限检查，省去逐张启动 CLI 的开销。原有 `adc artifact get` 保留。
成功的 `screen.capture` 还会直接返回 MCP 图片内容块，保留原有 JSON 结果和回执。
`task.status`、`task.result`、`task.wait` 返回已完成截图时同样交付图片。
图片交付失败时保留截图元数据并明确返回交付错误；服务更新后刷新或重连既有 MCP 客户端。

先升级服务端，再使用新版手机 JPEG 截图。APK 使用相同证书更新，重启后需恢复
Android 系统的屏幕共享授权。性能验收使用真实 ADC 服务；USB 仅用于开发和安装。

新版 Android Node 还会与服务端协商，在取任务时一并确认，减少每个任务的一次签名请求，
普通操作同样受益。旧服务继续单独确认；取消、租约和重投语义见
[ADR-0007](adr/0007-inline-dispatch-ack.md)。

截图接收端持续消费帧，每次请求拒绝请求或浮层隐藏前的帧。250ms没有合格帧时，
在已有授权的 VirtualDisplay 上重接接收 Surface 一次，再等待最多1750ms；
超时不会返回旧图。输出包含 `timings.recoveryCount`。停流显示为暂不可用，
收到新帧后恢复，权限页提供重新共享入口。这是本地候选行为，手机验收状态见
[截图修复验证](../CAPTURE-REPAIR-VERIFICATION.md)。
