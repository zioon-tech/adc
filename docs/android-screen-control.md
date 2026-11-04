# Android screen control and declared intent

ADC Mobile Node 0.2.3 distinguishes observation from screen control. Reading location, battery,
screenshots, interface snapshots or waiting for UI state does not acquire control. App launch,
system navigation, taps, swipes, focus, scrolling and typing require an explicit screen session.

Each tool call accepts an optional single-line `intent` (up to 160 characters). MCP and SDK use
`intent` and `controlSessionId` alongside `args`; CLI uses `--intent` and `--control-session`.
HTTP carries them in `invocation.metadata`. Intent is a model declaration, never a permission
or proof of work. Receipts preserve it; the phone keeps the last 40 tool/purpose/outcome records.
These records exclude business arguments, typed text and screenshot content. Intent does not
change the argument or idempotency hash, and replaying a receipt does not restart control.

Enable interface reading, screen actions and Android Accessibility on the phone. Allow system
notifications so the start/end alerts are visible. Grant `screen.control` explicitly to the agent:
new tools are never automatically added to existing grants. In the ADC agent access editor, add
the tool to the selected tool list, save, then refresh the client's MCP catalog (or reconnect the
client if it caches tools). Account, agent, device and local capability policies still apply.

Call `screen.control` with `args: {"action":"begin"}` and a short current intent. It returns an
actor-bound `controlSessionId`. Pass that value in common metadata on every screen mutation.
End in a finally block with `args: {"action":"end","controlSessionId":"ctl_…"}`. Use a new durable
idempotency key for each intentional operation. The default lease is 120 seconds; explicit renew
requests are bounded to 10–180 seconds. Device polling does not renew the session.

The phone shows **ADC is using the screen** while a mutation runs and **waiting for the next step**
between operations. Waiting never means completion. Starting and releasing produce different
short vibrations and top notification alerts; the ongoing notification also offers **I'll take over**.
The optional draggable edge indicator is off by default. It collapses to a small ADC marker, can
be hidden, never takes keyboard focus, and is hidden during model reads and mutations. Screenshot
frames older than that hide operation are discarded.

Taking over locally fences queued/new Android dispatches first, then settles in-flight actions.
It does not stop the Node connection. New screen sessions remain paused until the user chooses
**Allow screen control again** in **This phone**. An already accepted Android gesture can take a
short time to finish; **Releasing the screen…** remains visible during settlement. This feature
does not block physical touches or lock the phone: the notification action is the handoff.

Lease expiry, process restart, connection loss or unconfirmed Android completion are **Screen
control interrupted**, never task completion. Inspect the phone before proceeding after an
unknown outcome; do not retry an accepted gesture automatically. Status requests without the
matching owner and token never disclose the active token.

## 中文

0.2.3 将位置、电量、截图与界面读取视为观察；打开 App、导航、点击、滑动、输入等需先调用
`screen.control` 开始控制，每步携带 `controlSessionId`，最后显式交还。意图参数是模型的声明，
并不授予权限。默认控制 120 秒，续期需显式请求，单次最长 180 秒。

更新 App 后，已有 Agent 授权需明确加入 `screen.control`，再刷新 MCP 工具列表；不会自动扩大授权。
请开启手机无障碍、界面读取、屏幕操作和系统通知。开始、等待下一步、交还和中断会分别提示。
顶部通知中的「我来接管」会阻止旧操作及新一轮控制；准备好后在「此手机」允许再次使用。
边缘小提示默认关闭，可拖动、隐藏，截图和操作期间会收起。

手机只保留最近 40 条工具、意图与结果记录，不记录工具参数、输入正文或截图。意图不要包含敏感信息。
等待不代表任务完成；超时、断线和结果未知会显示「屏幕控制中断」，需要先确认当前屏幕。
