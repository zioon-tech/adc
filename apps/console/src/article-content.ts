import type { LocalizedText, PublicContentEntry } from "./public-content.ts";

const text = (en: string, zh: string): LocalizedText => ({ en, "zh-CN": zh });
const link = (href: string, en: string, zh: string) => ({ href, label: text(en, zh) });

export const articleContent: PublicContentEntry[] = [
  {
    path: "/updates/connector-0-1-3",
    kind: "Product update",
    title: text("Connector 0.1.3: bounded task waits and the official service", "Connector 0.1.3：有界任务等待与正式服务"),
    summary: text(
      "Follow a long-running task without submitting it again, use the official service address, and choose the installation for your device.",
      "跟踪长任务而不重复提交，使用正式服务地址，并选择适合设备的安装方式。"
    ),
    publishedAt: "2026-10-16",
    updatedAt: "2026-11-03",
    readingMinutes: 4,
    keywords: ["ADC 0.1.3", "ADC task.wait", "Android Mobile Node", "adc.zioon.tech"],
    listed: true,
    relatedPaths: ["/articles/durable-receipts-for-agent-side-effects", "/updates/connector-0-1-1", "/guides/first-device-to-first-tool-call"],
    sections: [
      {
        id: "task-wait",
        title: text("Wait for the task you already submitted", "等待已经提交的任务"),
        paragraphs: [
          text(
            "A build may take a minute while the agent's request waits only four seconds. The October 13 Connector 0.1.3 release adds a common bounded wait across CLI, MCP and SDK: return the result if it is ready, otherwise return the current state and existing jobId so the caller can follow the same task.",
            "构建可能需要一分钟，而 Agent 的一次请求只等待四秒。10 月 13 日发布的 Connector 0.1.3 为 CLI、MCP 与 SDK 增加统一的有界等待：结果就绪就返回结果，否则返回当前状态和已有 jobId，让调用方继续跟踪同一个任务。"
          ),
          text(
            "task.wait accepts waitMs from 0 to 30000 milliseconds, defaulting to 4000. Zero reads the current state immediately. queued or running is not proof of failure. Save the jobId and wait again; closing the client or reaching the wait limit does not cancel device work. Explicit cancellation uses task.cancel and remains cooperative.",
            "task.wait 的 waitMs 范围为 0 到 30000 毫秒，默认 4000；设为 0 会立即读取当前状态。queued 或 running 并不能证明执行失败。保留 jobId 后继续等待；关闭客户端或达到等待上限，都不会取消设备上的工作。主动取消使用 task.cancel，仍按协作式取消处理。"
          ),
          text(
            "Follow-up reads need the same account and grant plus task read permission. Existing grants are not expanded automatically. If waiting is denied, check the grant instead of resubmitting the command. The optional executionTimeoutMs is a separate total budget, including queue time; later waits and lease renewals never reset it.",
            "后续读取需要同一账号与授权，并具备任务读取权限；已有授权不会自动扩展。如果等待被拒绝，应检查授权，而不是重新提交命令。可选的 executionTimeoutMs 是独立的总执行预算，包含排队时间；后续等待与租约续期不会重置预算。"
          ),
          text(
            "Replace JOB_ID below with the identifier returned by your invocation. Both commands read the existing task. Treat success as a terminal result with the expected output, not merely a successful HTTP response or an expired wait.",
            "把下方 JOB_ID 替换成原调用返回的任务标识，两条命令都读取已有任务。成功应以终态结果和预期输出为准，不能仅凭 HTTP 请求成功或一次等待结束来判断。"
          )
        ],
        code: `adc task wait JOB_ID --wait 4000 --json
adc invoke task.wait --args '{"jobId":"JOB_ID","waitMs":4000}' --json`,
        links: [link("/docs/api", "Task states, budgets and cancellation", "任务状态、预算与取消")]
      },
      {
        id: "official-service",
        title: text("Connect through the official domain", "通过正式域名连接"),
        paragraphs: [
          text(
            "The official hosted service uses https://adc.zioon.tech. Use this origin for new setup and agent login. Self-hosted installations continue to use their own HTTPS origin and share the same authorization, approval and local execution model. Hosting location does not change where a device tool runs.",
            "官方托管服务使用 https://adc.zioon.tech。新设备接入与 Agent 登录请使用这一地址。自托管实例继续使用自己的 HTTPS 地址，并采用相同的授权、审批与本地执行模型。服务托管位置不会改变设备工具实际运行的位置。"
          ),
          text(
            "Upgrade an existing installation with adc update, then inspect adc-node status for the version and connection state. Normal updates preserve device identity. Changing service origin or replacing an expired credential is a different operation; check local status and the troubleshooting guide before unpairing.",
            "已有安装使用 adc update 升级，再通过 adc-node status 查看版本与连接状态。正常更新保留设备身份。切换服务地址或替换过期凭据属于另一类操作；取消配对前，应先检查本地状态与排障指南。"
          ),
          text(
            "The new execution budget field requires an updated Connector; older strict protocol readers may reject it. Keep requests unchanged until the target has been updated. After upgrading, verify a read-only call through the access your agent actually uses.",
            "新的执行预算字段需要更新后的 Connector，旧版严格协议读取器可能拒绝它。目标更新前请保留原有请求格式。升级后，还应通过 Agent 实际使用的授权验证一次只读调用。"
          )
        ],
        code: "adc update --check\nadc update\nadc-node status",
        links: [link("/docs/troubleshooting", "Diagnose connection problems", "排查连接问题")]
      },
      {
        id: "device-downloads",
        title: text("Choose the installation for your device", "选择适合设备的安装方式"),
        paragraphs: [
          text(
            "Devices → Pair device offers macOS, glibc Linux, Windows x64 and Android installation paths. Desktop installers include a runtime. Android uses an APK and the service URL and pairing code from the console; its screen capture and UI actions require permissions granted locally on the phone.",
            "「设备 → 配对设备」提供 macOS、glibc Linux、Windows x64 与 Android 安装入口。桌面安装器自带运行时。Android 使用 APK，以及控制台中的服务地址与配对码；屏幕捕获和 UI 操作需要在手机本地授予权限。"
          ),
          text(
            "Windows Node and Android Node remain in testing. The current Android package uses development signing and manual installation and updates. Testing on Xiaomi/MIUI does not certify every Android model. Android exposes mobile tools rather than the desktop filesystem and shell toolset; check the target's advertised capabilities.",
            "Windows Node 与 Android Node 仍在测试阶段。当前 Android 安装包采用开发签名，安装与更新需要手动完成。Xiaomi/MIUI 上的测试不代表所有 Android 机型均已认证。Android 开放移动工具，而不是桌面文件与 Shell 工具集；请以目标上报的能力为准。"
          )
        ],
        links: [link("/docs/quickstart", "Install and verify a Node", "安装与验证 Node"), link("/docs/quickstart#android", "Android setup", "Android 接入")]
      }
    ]
  },
  {
    path: "/updates/connector-0-1-1",
    kind: "Product update",
    title: text("Connector 0.1.1: faster mobile control and visible updates", "Connector 0.1.1：更快的移动端控制与可见更新"),
    summary: text(
      "How the release handles changing Android screens, keeps long-running MCP sessions current, and helps find outdated Connectors.",
      "本次更新怎样处理变化中的 Android 界面、刷新长时间运行的 MCP 会话，以及帮助发现旧版 Connector。"
    ),
    publishedAt: "2026-10-11",
    updatedAt: "2026-11-03",
    readingMinutes: 4,
    keywords: ["ADC 0.1.1", "Android accessibility", "MCP tool refresh", "Connector update"],
    listed: true,
    relatedPaths: ["/updates/connector-0-1-3", "/guides/first-device-to-first-tool-call", "/articles/least-privilege-for-ai-agents"],
    sections: [
      {
        id: "mobile-control",
        title: text("Mobile actions follow observed UI state", "移动端操作遵循实际 UI 状态"),
        paragraphs: [
          text(
            "A mobile agent inspects the screen, chooses a control and clicks it. Between inspection and action, a dialog can open, a list can move, or another app can become active. This release tightens the relationship between an action and the UI the agent observed, while reducing repeated full snapshots during a wait for change.",
            "移动端 Agent 先检查屏幕，再选择控件并点击。检查与操作之间，可能出现弹窗、列表移动，或前台切换到另一个应用。本次更新收紧操作与 Agent 已观察界面之间的关系，等待变化时也减少了反复生成完整快照。"
          ),
          text(
            "Snapshot-bound actions reject a changed UI. After a stale-state rejection, inspect again and select the target from the new observation. Repeating an old click without a fresh observation can still address the wrong control. For a workflow such as opening Settings, verify the foreground app and resulting screen before proceeding.",
            "绑定快照的操作会拒绝已经变化的界面。收到过期状态拒绝后，应重新检查，再从新的观察结果中选择目标。未经重新观察便重复旧点击，仍可能操作到错误控件。以打开设置为例，继续下一步前，应确认前台应用和实际出现的页面。"
          ),
          text(
            "The implementation waits for Accessibility revisions, resolves clickable ancestors without an arbitrary traversal-depth cutoff, and releases native callbacks when the service stops. This improves action handling; it does not remove local permission requirements or make every app expose a complete semantic UI. Android Node remains in testing.",
            "实现会等待无障碍修订；查找可点击祖先时不再采用任意层级截断；服务停止时会释放原生回调。这些改进加强了操作处理，但不会取消本地权限要求，也不能让所有应用提供完整的语义界面。Android Node 仍在测试阶段。"
          )
        ],
        links: [link("/docs/quickstart#android", "Android permissions and tools", "Android 权限与工具")]
      },
      {
        id: "mcp-refresh",
        title: text("Long-running MCP sessions stay current", "长时间运行的 MCP 会话保持最新"),
        paragraphs: [
          text(
            "An MCP client can stay open for hours while devices reconnect or the owner changes an Agent access. A cached tool list can show an unavailable device, omit a new tool or encourage a call that the current grant denies. Long-running MCP sessions now refresh tools, targets and authorization context while the server remains open.",
            "MCP 客户端可能连续打开数小时，这期间设备会重连，所有者也可能修改 Agent 授权。缓存列表可能展示不可用设备、遗漏新工具，或者引导 Agent 发起已被当前授权拒绝的调用。现在，长时间运行的 MCP 会话会刷新工具、目标与授权上下文。"
          ),
          text(
            "Discovery refresh does not replace invocation authorization. The service still checks each request and the device retains its local limits. After a permission change, inspect the refreshed list and make a small read-only call. If the client itself caches tools indefinitely, reconnect that client to discover the current surface.",
            "刷新发现信息不能替代调用授权。服务仍会逐次检查请求，设备也保留本地限制。权限改变后，请检查更新后的列表并验证一次小范围只读调用。如果客户端自身长期缓存工具，则应重新连接客户端，获取当前工具集合。"
          ),
          text(
            "A malformed MCP request and a denied request need different fixes. Check the request format for the former and the grant for the latter. Expanding access is not a remedy for a transport or schema error.",
            "格式错误的 MCP 请求与权限被拒绝，需要不同的处理方式。前者应检查请求格式，后者应检查授权。扩大访问范围不能修复传输或参数结构错误。"
          )
        ],
        links: [link("/docs/integrations", "Connect an MCP client", "连接 MCP 客户端")]
      },
      {
        id: "update-discovery",
        title: text("Find outdated devices without blocking work", "发现旧设备而不阻塞工作"),
        paragraphs: [
          text(
            "The console shows installed and available desktop versions, including the last reported version of an offline device. This helps locate old installations but does not prove reachability. CLI update checks remain advisory so a version lookup does not block ordinary commands.",
            "控制台显示桌面端已安装与可更新版本，离线设备也会显示最后上报的版本。这有助于找到旧安装，但不能证明设备可达。CLI 更新检查保持提示性质，避免版本查询阻塞普通命令。"
          ),
          text(
            "Run adc update on the relevant installation and then adc-node status. Confirm the version, service origin and online state, followed by one tool call through the agent connection. If the new version is installed but the device stays offline, check startup, credentials and outbound connectivity before reinstalling.",
            "在对应安装上运行 adc update，再运行 adc-node status。确认版本、服务地址和在线状态，然后通过 Agent 连接验证一次工具调用。如果新版本已安装但设备仍离线，应先检查后台启动、凭据与出站网络，再考虑重装。"
          ),
          text(
            "Windows Node also remains in testing. New installations should use the current release; this historical article explains the change, while the Connector guide maintains current setup and recovery instructions.",
            "Windows Node 同样仍在测试阶段。新安装应使用当前版本；本篇历史记录解释当时的变化，Connector 指南则维护当前的接入与恢复步骤。"
          )
        ],
        code: "adc update --check --json\nadc update\nadc-node status\nadc-node logs",
        links: [link("/docs/connector", "Connector configuration", "Connector 配置"), link("/docs/troubleshooting", "Offline device troubleshooting", "离线设备排障")]
      }
    ]
  },
  {
    path: "/guides/first-device-to-first-tool-call",
    kind: "Guide",
    title: text("From the first device to the first verified tool call", "从第一台设备到第一次可验证工具调用"),
    summary: text("Pair one computer, expose a test folder, create read-only Agent access, and verify the result and task record.", "配对一台电脑、开放测试目录、创建只读 Agent 授权，并核对结果与任务记录。"),
    publishedAt: "2026-09-29",
    updatedAt: "2026-11-03",
    readingMinutes: 5,
    keywords: ["ADC tutorial", "local device tools", "MCP device setup", "Agent authorization"],
    listed: true,
    relatedPaths: ["/use-cases/remote-local-development", "/articles/least-privilege-for-ai-agents", "/articles/not-remote-ssh"],
    sections: [
      {
        id: "prepare",
        title: text("Prepare one known file", "准备一个已知文件"),
        paragraphs: [
          text(
            "This walkthrough uses macOS or glibc Linux and the official HTTPS service. You need an ADC account, outbound connectivity, and permission to install a user-level background service. The desktop installer includes its runtime. Windows Node and Android Node are in testing; use their platform-specific instructions rather than copying Unix paths onto them.",
            "本指南使用 macOS 或 glibc Linux 与官方 HTTPS 服务。你需要 ADC 账号、可用出站网络，以及安装用户级后台服务的权限。桌面安装器自带运行时。Windows Node 与 Android Node 仍在测试阶段，请按对应平台说明操作，不要直接照搬 Unix 路径。"
          ),
          text(
            "Create a small folder with predictable content. The first goal is to prove that the authorized agent can read this file on this device. No model is needed for the verification: the CLI exercises the same access path that an agent will use.",
            "创建一个内容可预期的小目录。第一步要证明：获得授权的 Agent 能读取这台设备上的这个文件。验证不需要模型，CLI 会使用 Agent 后续调用的同一访问链路。"
          )
        ],
        code: `mkdir -p "$HOME/adc-demo"
printf 'ADC device read verified\\n' > "$HOME/adc-demo/README.txt"`
      },
      {
        id: "pair",
        title: text("Pair the Connector and expose the folder", "配对 Connector 并开放目录"),
        paragraphs: [
          text(
            "Sign in to the console and choose Devices → Pair device. Select the target platform and use its generated installation command. The pairing code is one-time and short-lived. Replace PAIRING_CODE below with that code; pairing belongs on the target computer, where the Connector creates its local identity and startup service.",
            "登录控制台，选择「设备 → 配对设备」，再选择目标平台并使用生成的安装命令。配对码短时有效且只能使用一次。把下方 PAIRING_CODE 替换成该配对码；配对应在目标电脑上完成，Connector 会在那里创建本地身份与后台启动服务。"
          ),
          text(
            "Set local access to selected folders and add the demo folder as read-only. Inspect status and roots. Keep the returned nodeId and root ID; if the folder already exists in the list, reuse its root ID. Success at this stage means the Connector is online and advertises the intended folder, not that an agent is already authorized.",
            "把本地访问模式设为指定目录，并以只读方式添加测试目录。查看状态与目录列表，记录返回的 nodeId 和根目录 ID；如果目录已经在列表中，则复用已有 ID。本阶段成功意味着 Connector 在线并开放了目标目录，尚不代表 Agent 已获得授权。"
          )
        ],
        code: `curl -fsSL https://adc.zioon.tech/downloads/node/install.sh | sh -s -- \\
  --url https://adc.zioon.tech --code 'PAIRING_CODE'
adc-node access selected
adc-node roots add "$HOME/adc-demo" --label Demo --read-only
adc-node status
adc-node roots list`,
        links: [link("/docs/connector", "Installation and local access modes", "安装与本地访问模式")]
      },
      {
        id: "authorize",
        title: text("Authorize a caller separately", "单独授权调用方"),
        paragraphs: [
          text(
            "On the computer or cloud environment where your agent will run, install the CLI if necessary using the installer with --cli-only. Log in, create an access named first-agent, and bind the CLI to it. Pairing connects a device to your account; this separate access determines what the caller can do.",
            "在 Agent 所在的电脑或云端环境，如果尚未安装 CLI，可使用安装器的 --cli-only 模式安装。登录后创建名为 first-agent 的授权，再让 CLI 绑定它。配对负责把设备接入账号；这份独立授权决定调用方可以做什么。"
          ),
          text(
            "Replace NODE_ID and ROOT_ID with the identifiers from the previous step. The explicit tool list allows reading and following tasks while keeping write and command tools out. You can make the same selection in the console's Agent access form. Keep the local folder read-only as well: neither side can widen the other's restriction.",
            "把 NODE_ID 与 ROOT_ID 替换成上一步取得的标识。显式工具列表只允许读取与跟踪任务，不包含写入或命令执行工具。也可以在控制台的 Agent 授权表单中做同样选择。本地目录同样保持只读，两侧都不能扩大对方的限制。"
          )
        ],
        code: `curl -fsSL https://adc.zioon.tech/downloads/node/install.sh | sh -s -- --cli-only
adc login --url https://adc.zioon.tech
adc access create --name first-agent --devices NODE_ID --folders ROOT_ID \\
  --tools device.list,device.status,file.list,file.read,file.search,task.status,task.wait \\
  --profile read-only --approval never --json
adc connect first-agent --json
adc node list --json`
      },
      {
        id: "verify",
        title: text("Read the file and check the task", "读取文件并核对任务"),
        paragraphs: [
          text(
            "Use the absolute device path from the root listing, including the target user's real home directory. adc node list should show the authorized target, and file.read should return the line ADC device read verified. Inspect the terminal status and matching Activity record. A queued or running response only means more waiting is needed.",
            "使用目录列表中的设备绝对路径，包含目标用户的实际主目录。adc node list 应显示被授权目标；file.read 应返回 ADC device read verified 这一行。核对终态与对应活动记录。若返回 queued 或 running，则只是需要继续等待。"
          ),
          text(
            "Replace JOB_ID with the returned task ID when needed. If the device is missing, check local status and the access's device selection. If reading is denied, check both folder selections, the read tool and the absolute path. Do not solve a setup mismatch by opening the whole filesystem.",
            "需要时把 JOB_ID 替换成返回的任务 ID。设备缺失时，检查本地状态与授权中的设备选择。读取被拒绝时，检查两侧目录范围、读取工具与绝对路径。接入配置不匹配时，应定位具体原因。"
          )
        ],
        code: `adc invoke file.read --node NODE_ID \\
  --args '{"path":"/Users/me/adc-demo/README.txt"}' --wait 4000 --json
adc task wait JOB_ID --wait 4000 --json`,
        links: [link("/docs/troubleshooting", "Resolve pairing and authorization failures", "处理配对与授权故障")]
      },
      {
        id: "expand",
        title: text("Expand only after the read path works", "读取成功后再扩展用途"),
        paragraphs: [
          text(
            "Once this succeeds, connect the same access to an MCP client or your agent's CLI integration. Add a separate writable project folder or a fixed test template when the task requires it, and choose approvals for side effects. A successful file read verifies routing and read permission; it does not verify shell isolation or every Android capability.",
            "验证成功后，可以把同一授权连接到 MCP 客户端或 Agent 的 CLI 集成。任务需要时，再添加独立的可写项目目录或固定测试模板，并为副作用选择审批规则。文件读取成功验证的是路由和读取权限，不代表 Shell 隔离或所有 Android 能力均已验证。"
          )
        ],
        links: [link("/docs/integrations", "Use the access in your agent", "在 Agent 中使用授权"), link("/docs/tools", "Choose tools and command templates", "选择工具与命令模板")]
      }
    ]
  },
  {
    path: "/articles/least-privilege-for-ai-agents",
    kind: "Engineering",
    title: text("Least privilege for AI agents is an intersection, not a checkbox", "AI Agent 的最小权限是多层交集，不是一个开关"),
    summary: text("Follow a read, a denied write and an approved test to see how account access, Agent grants and device policy work together.", "通过一次读取、一次被拒绝的写入和一次获批测试，说明账号访问、Agent 授权与设备策略怎样共同生效。"),
    publishedAt: "2026-09-29",
    updatedAt: "2026-11-03",
    readingMinutes: 5,
    keywords: ["AI agent least privilege", "MCP authorization", "device policy", "ADC approvals"],
    listed: true,
    relatedPaths: ["/articles/not-remote-ssh", "/guides/first-device-to-first-tool-call", "/articles/durable-receipts-for-agent-side-effects"],
    sections: [
      {
        id: "why",
        title: text("A credential is not the whole permission model", "凭据不是全部权限"),
        paragraphs: [
          text(
            "Suppose you ask a cloud coding agent to inspect a repository and run its tests. You may want it to read that project, while keeping private documents and other projects unavailable. Later, the same agent may need to edit a file. A single allow-agent switch cannot express those changing task boundaries clearly.",
            "假设你让云端编程 Agent 检查仓库并运行测试。你可能允许它读取这个项目，但不开放私人文档与其他项目。之后，同一个 Agent 又可能需要修改文件。单一的「允许 Agent」开关无法清晰表达这些随任务变化的边界。"
          ),
          text(
            "ADC separates resource access from caller authority and local device limits. Owning a device, holding an Agent credential and exposing a folder answer different questions. Work proceeds only where those permissions overlap. This also makes a denial diagnosable: identify the narrow layer instead of guessing which broad role to enable.",
            "ADC 将资源访问、调用方权限与设备本地限制分开。拥有设备、持有 Agent 凭据、开放目录，回答的是不同问题；只有权限重叠的操作才允许继续。这也让拒绝更容易排查：找到具体限制层，而不是猜测应该开启哪个宽泛角色。"
          )
        ]
      },
      {
        id: "layers",
        title: text("Follow a request through the boundaries", "沿一次请求检查各层边界"),
        paragraphs: [
          text(
            "First, the account must own the device or receive valid shared access. Next, the Agent grant selects the permitted device, folders and tools. Device policy can independently make a folder read-only or disable execution. The local Connector exposes the actual roots and capabilities, and validates the target path before executing.",
            "首先，账号必须拥有设备或获得有效共享访问。接着，Agent 授权选择允许的设备、目录与工具。设备策略可以独立地把目录设为只读或关闭执行。本地 Connector 开放实际目录与能力，并在执行前校验目标路径。"
          ),
          text(
            "For file.read on the repository README, every layer must allow the target and read tool. If the grant allows file.edit but the local root is read-only, editing is still denied. If the local device allows writes but the grant contains only read tools, editing is also denied. An online device alone grants nothing.",
            "读取仓库 README 时，每一层都必须允许对应目标与读取工具。授权允许 file.edit、本地根目录只读时，编辑仍会被拒绝；本地允许写入、授权只有读取工具时，也同样被拒绝。设备在线本身不授予任何权限。"
          ),
          text(
            "Shared devices add the owner's sharing and member policy to the same evaluation. An invitation does not transfer ownership or automatically authorize every agent. The recipient accepts the share and creates their own Agent access; all narrower restrictions still apply.",
            "共享设备还会把所有者的共享与成员策略纳入同一检查。邀请不会转移设备归属，也不会自动授权所有 Agent。接收人接受共享后，还需要创建自己的 Agent 授权；更窄的限制仍然生效。"
          )
        ],
        links: [link("/docs/security", "Security boundaries and verification limits", "安全边界与验证范围"), link("/docs/collaboration", "Shared-device permissions", "共享设备权限")]
      },
      {
        id: "approval",
        title: text("Approve an allowed action", "对已允许的操作做审批"),
        paragraphs: [
          text(
            "Approval answers whether an otherwise permitted operation needs a human decision. It cannot make a denied path or missing tool available. For example, running a configured test template can require approval while reading the README does not. If both the caller's access and the device owner require approval, both decisions are needed.",
            "审批回答的是：一项本来已允许的操作，是否还需要人工决定。它不能开放被拒绝的路径或缺失工具。例如，运行配置好的测试模板可以需要审批，读取 README 则不需要。如果调用方授权和设备所有者都要求审批，就需要双方决定。"
          ),
          text(
            "Review the target, working directory and command before approving. Templates restrict the command choice, but the configured program may still write files or contact services. General shell access is broader: a working directory check is not an operating-system sandbox and does not confine all subprocess access to that directory.",
            "批准前，应核对目标、工作目录与命令。模板限制了命令选择，但配置的程序仍可能写文件或访问服务。通用 Shell 的权限更广：检查工作目录不等于操作系统沙箱，也不能把子进程的所有访问限制在该目录内。"
          )
        ],
        links: [link("/docs/tools", "Read tools, templates and shell execution", "读取工具、模板与 Shell 执行")]
      },
      {
        id: "operating",
        title: text("Apply this to everyday work", "落实到日常任务"),
        paragraphs: [
          text(
            "Start by selecting the device and project folder, then choose tools for the actual task. Add a fixed template for a repeated test, or explicitly grant shell execution for tasks that need arbitrary commands. When a request fails, inspect the grant, device policy, root and advertised capability in that order, together with the recorded denial.",
            "先选择设备和项目目录，再按实际任务选择工具。重复测试可以添加固定模板；需要任意命令的任务则显式开放 Shell。请求失败时，结合拒绝记录，依次检查授权、设备策略、根目录与上报能力。"
          ),
          text(
            "Narrowing or revoking access affects new work and is rechecked for active work during lease renewal. Cancellation remains cooperative and cannot undo an already completed write. Least privilege limits future authority; receipts and resource-specific recovery are still needed to understand earlier effects.",
            "收紧或撤销权限会影响新任务，运行中任务也会在租约续期时再次检查。取消仍按协作式处理，无法撤回已经完成的写入。最小权限限制后续权限；要理解之前发生的修改，仍需要回执与目标资源自身的恢复方式。"
          )
        ],
        links: [link("/guides/first-device-to-first-tool-call", "Create and verify read-only access", "创建并验证只读授权")]
      }
    ]
  },
  {
    path: "/articles/durable-receipts-for-agent-side-effects",
    kind: "Engineering",
    title: text("Durable receipts help recover agent side effects", "持久回执怎样帮助恢复 Agent 副作用"),
    summary: text("What to do when a command may have finished but its response was lost: follow the task, preserve its identity and reconcile uncertain effects.", "命令可能已经执行、响应却丢失时，怎样跟踪原任务、保留请求身份，并核对不确定的副作用。"),
    publishedAt: "2026-09-29",
    updatedAt: "2026-11-03",
    readingMinutes: 5,
    keywords: ["AI agent idempotency", "durable receipt", "distributed task retry", "unknown_outcome"],
    listed: true,
    relatedPaths: ["/updates/connector-0-1-3", "/articles/least-privilege-for-ai-agents", "/articles/ai-agent-behind-nat"],
    sections: [
      {
        id: "ambiguity",
        title: text("A missing response does not prove a missing effect", "响应丢失不代表操作未发生"),
        paragraphs: [
          text(
            "Imagine an agent runs a command that publishes a package. The process completes, but the device loses its network connection before reporting the result. From the agent's view, the request has not succeeded. Repeating the command may publish twice or fail for a reason that hides the first successful effect.",
            "设想 Agent 执行发布软件包的命令。进程完成了，但设备在上报结果前断网。从 Agent 看，请求还没有成功；重复执行可能重复发布，也可能以另一种错误掩盖第一次已经产生的效果。"
          ),
          text(
            "A short wait ending is an easier case: keep the returned jobId and follow the existing task. A device crash during execution is harder because the affected resource may have changed without a terminal result. ADC distinguishes these situations instead of treating every missing response as permission to retry.",
            "短时间等待结束属于较容易处理的情况：保留 jobId 并跟踪已有任务。执行期间设备崩溃则更复杂，目标资源可能已经改变，却没有终态结果。ADC 区分这些情况，避免把每个缺失响应都当成可以重试。"
          )
        ],
        code: "adc task wait JOB_ID --wait 4000 --json",
        links: [link("/docs/api", "Task recovery and waiting", "任务恢复与等待")]
      },
      {
        id: "identity",
        title: text("Preserve the identity and the request", "保留身份与原请求"),
        paragraphs: [
          text(
            "Mutating requests carry an idempotency key. Keep it with the invocation ID, returned jobId, target and arguments. Matching retries can refer to the original operation; changing the request while keeping the key is a conflict. A new key represents a new operation and bypasses the protection associated with the old one.",
            "修改类请求携带幂等键。应把它与调用 ID、返回的 jobId、目标和参数一起保留。匹配的重试可以指向原操作；使用同一键却改变请求，会产生冲突。新键代表新操作，会绕开原键对应的保护。"
          ),
          text(
            "The device compares the key and normalized request identity, not a natural-language description of intent. If the agent rewrites a command or changes an execution budget, do not assume it remains the same request. Keep the original request for recovery, then make a separate, deliberate decision about any corrective action.",
            "设备比较的是幂等键与规范化请求身份，不是自然语言表达的意图。Agent 改写命令或改变执行预算后，不能假设它仍是同一请求。恢复时保留原请求，再单独决定是否需要修正操作。"
          )
        ]
      },
      {
        id: "ledger",
        title: text("The device records before and after execution", "设备在执行前后分别记录"),
        paragraphs: [
          text(
            "Before starting a side effect, the Connector durably reserves its identity in a local ledger. The started record is persisted with fsync and an atomic file operation. After the executor returns, the Connector persists the completed receipt before reporting it to the service. A lost completion response can therefore be reconciled from local evidence.",
            "副作用开始前，Connector 会在本地账本中持久预留请求身份。started 记录通过 fsync 与原子文件操作保存。执行器返回后，Connector 先保存 completed 回执，再向服务上报。因此，完成响应丢失时，可以根据设备本地证据核对。"
          ),
          text(
            "A matching completed record can replay the recorded result without executing the side effect again. A started record without a reliable completion record is different: it proves the operation was reserved, but cannot prove how far it got. This is why the ledger stores both phases rather than just caching successful responses.",
            "匹配的 completed 记录可以重放已记录结果，不必再次执行副作用。只有 started、没有可靠完成记录时则不同：它证明操作曾被预留，却不能证明执行到了哪一步。这也是账本需要保存两个阶段，而不只缓存成功响应的原因。"
          ),
          text(
            "The receipt describes what the executor observed. It is not a transaction with every filesystem, database or external API touched by the command, and it cannot undo those effects. Programs with their own transaction or idempotency support provide stronger resource-level recovery.",
            "回执描述的是执行器观察到的结果。它不会与命令触及的所有文件系统、数据库或外部 API 组成同一事务，也无法撤回这些副作用。目标程序自身具备事务或幂等支持时，可以提供更强的资源级恢复能力。"
          )
        ]
      },
      {
        id: "unknown",
        title: text("Handle unknown_outcome explicitly", "显式处理 unknown_outcome"),
        paragraphs: [
          text(
            "If there is no trustworthy terminal receipt and execution cannot be ruled out, the safe answer is unknown_outcome. Stop automatic retries. Inspect the existing task and the target resource: does the published version exist, was the expected file written, or does the external service have a matching transaction?",
            "没有可信终态回执、又无法排除已执行时，应返回 unknown_outcome。停止自动重试，检查原任务与目标资源：发布版本是否已存在、目标文件是否已写入、外部服务是否存在对应事务？"
          ),
          text(
            "Only after reconciliation should the operator or agent choose the next action. If the effect exists, continue from it. If absence can be established, a new operation may be appropriate. If the evidence stays uncertain, preserve that uncertainty instead of inventing an exactly-once guarantee or retrying under a fresh key.",
            "核对后，操作员或 Agent 才应选择下一步。效果已存在时，从已有结果继续；能够确定未发生时，再考虑新操作；证据仍不确定时，应保留这种不确定性。不要虚构「精确一次」保证，也不要换新键盲目执行。"
          )
        ],
        links: [link("/docs/troubleshooting", "Investigate execution and result failures", "排查执行与结果故障")]
      }
    ]
  },
  {
    path: "/articles/ai-agent-behind-nat",
    kind: "Engineering",
    title: text("How an AI agent reaches a computer behind NAT", "AI Agent 如何访问 NAT 后的电脑"),
    summary: text("Trace a cloud request to a local file through outbound connections, durable task delivery and device-side checks, including sleep and network failure.", "沿一次云端读取请求，说明出站连接、持久任务投递与设备本地校验怎样配合，以及休眠和断网时会发生什么。"),
    publishedAt: "2026-09-29",
    updatedAt: "2026-11-03",
    readingMinutes: 5,
    keywords: ["AI agent behind NAT", "remote AI agent", "outbound WebSocket", "device connectivity"],
    listed: true,
    relatedPaths: ["/articles/cloud-agent-local-devices", "/updates/websocket-task-wakeups", "/articles/durable-receipts-for-agent-side-effects"],
    sections: [
      {
        id: "problem",
        title: text("The cloud agent cannot simply dial your laptop", "云端 Agent 无法直接拨通你的笔记本"),
        paragraphs: [
          text(
            "Home routers, office firewalls and mobile networks commonly prevent unsolicited inbound connections. A cloud agent may have a shell in its own environment, but that shell cannot read a file on your private laptop merely because both machines are online. Some connection mechanism must bridge the two environments.",
            "家庭路由器、办公室防火墙与移动网络通常阻止未经请求的入站连接。云端 Agent 即便有自己的 Shell，也不能仅因为双方在线就读取私人笔记本上的文件。两个环境之间仍需要一种连接机制。"
          ),
          text(
            "Options include a VPN, an SSH entry point, a local agent or an outbound connector. ADC chooses the last approach: the target device starts TLS connections to a known service, and the agent submits authorized tool requests to that service. No public inbound port is required on the target device.",
            "可选方式包括 VPN、SSH 入口、本地 Agent 或出站连接器。ADC 采用出站连接器：目标设备主动向已知服务建立 TLS 连接，Agent 向服务提交已授权的工具请求。目标设备不需要开放公网入站端口。"
          ),
          text(
            "Outbound access is still a real requirement. A network that blocks the service, TLS or WebSocket upgrades can prevent or delay delivery. This architecture is not a way around every firewall and does not expose a general network tunnel.",
            "出站访问仍是真实前提。网络阻断服务地址、TLS 或 WebSocket 升级时，投递会受阻或延迟。这种架构不能绕过所有防火墙，也不会开放通用网络隧道。"
          )
        ]
      },
      {
        id: "separate-signal-state",
        title: text("Trace one file read", "沿一次文件读取追踪"),
        paragraphs: [
          text(
            "The agent submits file.read with a target and path. The service checks the caller's access and stores a durable invocation. An authenticated outbound WebSocket can notify the Connector that work is available. The signal is dispatch.available; it contains no command, file path or authorization decision.",
            "Agent 提交包含目标与路径的 file.read。服务检查调用方授权，并持久保存调用。经过认证的出站 WebSocket 可以通知 Connector 有任务可领取。信号是 dispatch.available，不包含命令、文件路径或授权结论。"
          ),
          text(
            "The Connector then uses signed HTTPS polling to claim the task. In PostgreSQL deployments, dispatch claiming is atomic. The device validates the request and reads the file locally, then reports the result. The caller follows the same jobId. Duplicate wake signals do not mean duplicate tool requests.",
            "随后，Connector 通过签名 HTTPS 轮询领取任务。PostgreSQL 部署中的任务领取具有原子性。设备校验请求，在本地读取文件，再上报结果。调用方跟踪同一 jobId；重复唤醒信号不代表重复工具请求。"
          ),
          text(
            "Separating the notification from stored task state lets a missed wake be recovered without losing the invocation. It also keeps an open WebSocket from becoming the authority for execution: the signed request path and durable task state still decide what work is available.",
            "把通知与已保存的任务状态分开，就能在唤醒丢失后恢复调用。开放的 WebSocket 也不会因此成为执行授权来源；实际可领取的工作仍由签名请求链路与持久任务状态决定。"
          )
        ],
        links: [link("/updates/websocket-task-wakeups", "How wakeups and fallback polling work", "唤醒与兜底轮询怎样工作")]
      },
      {
        id: "authorization",
        title: text("Reachability and authority are separate", "可达性与操作权限分别处理"),
        paragraphs: [
          text(
            "Connectivity only makes delivery possible. The account must own the device or hold valid shared access; the Agent grant, device policy, selected folders and live capabilities must all allow the request. The Connector validates local scope again before execution. A broad cloud grant cannot open a locally unexposed folder.",
            "连接只让投递成为可能。账号必须拥有设备或获得有效共享访问；Agent 授权、设备策略、所选目录与实时能力都必须允许请求。Connector 执行前再次校验本地范围。宽泛的云端授权不能开放设备本地未公开的目录。"
          ),
          text(
            "The device private key stays local, but requested arguments and results pass through the control plane. TLS protects transport; it does not make tool data end-to-end encrypted between the agent and device. Choose an official or self-hosted service according to who may process those requests and results.",
            "设备私钥保留在本地，但请求参数与返回结果经过控制面。TLS 保护传输，不代表 Agent 与设备之间的工具数据实现了端到端加密。应根据允许谁处理请求与结果，选择官方托管或自托管服务。"
          )
        ],
        links: [link("/articles/least-privilege-for-ai-agents", "Permission evaluation", "权限检查"), link("/privacy", "Data processed by the service", "服务处理的数据")]
      },
      {
        id: "recovery",
        title: text("Expect sleep, restart and packet loss", "预期休眠、重启与丢包"),
        paragraphs: [
          text(
            "A sleeping laptop cannot execute tasks. After connectivity returns, the Connector reconnects with backoff, polls immediately, and uses a slower 30-second fallback poll when wake delivery is unavailable. Pending work must still satisfy its original deadline and current authorization; reconnecting does not renew the task's lifetime.",
            "休眠中的笔记本无法执行任务。网络恢复后，Connector 按退避策略重连并立即轮询；唤醒不可用时，还有较慢的 30 秒兜底轮询。待处理任务仍需满足原有截止时间与当前授权；重连不会延长任务寿命。"
          ),
          text(
            "If a command ran before the connection dropped, follow the original task and inspect its receipt. A missing response can mean unknown outcome, not a command that never ran. ADC's current tool path uses the service for dispatch and results; this article does not describe an implemented peer-to-peer data path.",
            "命令若在断网前已经运行，应跟踪原任务并检查回执。缺失响应可能意味着结果未知，不能据此认定命令从未执行。ADC 当前工具链路通过服务完成调度与结果传递；本文没有描述已经实现的点对点数据通道。"
          )
        ],
        links: [link("/docs/troubleshooting", "Connection and task recovery", "连接与任务恢复")]
      }
    ]
  },
  {
    path: "/use-cases/remote-local-development",
    kind: "Use case",
    title: text("Continue local development from a remote AI agent", "让远程 AI Agent 继续本地开发工作"),
    summary: text("An example workflow for inspecting a real repository, making a focused change and running its configured test command on the existing computer.", "通过检查真实仓库、小范围修改和运行已配置测试，说明怎样复用电脑上的现有开发环境。"),
    publishedAt: "2026-09-29",
    updatedAt: "2026-11-03",
    readingMinutes: 5,
    keywords: ["remote coding agent", "local repository", "ADC command template", "MCP local files"],
    listed: true,
    relatedPaths: ["/guides/first-device-to-first-tool-call", "/articles/cloud-agent-local-devices", "/articles/least-privilege-for-ai-agents"],
    sections: [
      {
        id: "scenario",
        title: text("Reuse the environment where the problem occurs", "复用问题实际发生的环境"),
        paragraphs: [
          text(
            "Suppose a Node.js repository builds on your Mac or Linux workstation but one test is failing. Its dependencies, caches, test data and local services are already configured. You want a remote agent to inspect the failure and propose a small fix. This is an illustrative workflow, not a claim that ADC independently diagnoses code.",
            "假设一个 Node.js 仓库在你的 Mac 或 Linux 工作站上可以构建，但某个测试失败。依赖、缓存、测试数据和本地服务已经配置完成。你希望远程 Agent 检查故障并提出小范围修复。这是一条说明用途的示例流程，不代表 ADC 会独立诊断代码。"
          ),
          text(
            "The agent reasons in its own environment; the Connector uses the real repository on the target. You avoid recreating that environment solely for this task. A separate cloud sandbox can still be preferable for untrusted code, parallel experiments or tasks that do not need device-specific resources.",
            "Agent 在自己的环境中分析，Connector 则操作目标设备上的真实仓库。你不必仅为这项任务重建环境。执行不可信代码、并行实验，或不依赖设备专属资源时，独立云端沙箱仍可能更合适。"
          ),
          text(
            "Before starting, identify the repository's current uncommitted changes, the test command and any services the test affects. The walkthrough uses npm test as an example; choose the project's actual command. Windows Node and Android Node remain in testing, and Android does not expose this desktop toolset.",
            "开始前，确认仓库现有未提交修改、实际测试命令，以及测试会影响的服务。本例用 npm test 示意，应该替换成项目真实命令。Windows Node 与 Android Node 仍在测试阶段；Android 不开放这套桌面工具集。"
          )
        ],
        links: [link("/guides/first-device-to-first-tool-call", "Pair a device and verify a read", "配对设备并验证读取")]
      },
      {
        id: "workflow",
        title: text("Read, patch and run the configured test", "读取、修改并运行配置好的测试"),
        paragraphs: [
          text(
            "Expose the project folder on the target device and create Agent access for the tools the task needs. For editing and tests, both local and account-side policy must permit writes and execution. On the device, register a fixed test template against the project's ROOT_ID from adc-node roots list.",
            "在目标设备开放项目目录，并为任务所需工具创建 Agent 授权。编辑与测试需要本地和账号侧策略都允许相应写入与执行。在设备上，通过 adc-node roots list 取得项目的 ROOT_ID，再为它注册固定测试模板。"
          ),
          text(
            "command.template.list only shows the configured commands. test.run defaults to the template named test; it does not infer your framework or discover a test script. Templates let the owner choose the command without granting arbitrary shell access. They are not a sandbox: npm test and its dependencies still run with the device process's operating-system authority.",
            "command.template.list 只列出配置好的命令。test.run 默认使用名为 test 的模板，不会推断测试框架或自动发现脚本。模板让所有者选择命令，无需开放任意 Shell；但它不是沙箱，npm test 与依赖程序仍使用设备进程的操作系统权限。"
          )
        ],
        code: `adc-node roots list
adc-node templates add test --root ROOT_ID --command "npm test" --timeout 300000
adc-node templates list`
      },
      {
        id: "call-from-agent",
        title: text("Call from the agent's environment", "从 Agent 所在环境调用"),
        paragraphs: [
          text(
            "Create project-review access in the console for this device and root. Include file.list, file.read, file.search, file.edit or file.patch, command.template.list, test.run, task.status and task.wait as needed, with approvals for side effects. The following calls assume this access already exists. Replace NODE_ID, ROOT_ID and the absolute path with the target's values.",
            "在控制台创建 project-review 授权，选择该设备与根目录。按需包含 file.list、file.read、file.search、file.edit 或 file.patch、command.template.list、test.run、task.status 与 task.wait，并为副作用选择审批规则。以下调用假设授权已创建；请替换 NODE_ID、ROOT_ID 与目标绝对路径。"
          ),
          text(
            "First read the README and relevant source, then review the proposed patch and apply only the intended change. The exact edit depends on the bug, so there is no universal patch to copy. Run the configured test and inspect its terminal output and exit status. Wait again on the returned jobId if the response is still queued or running.",
            "先读取 README 与相关源码，再检查补丁并仅应用预期修改。具体编辑取决于缺陷，没有可以通用照抄的补丁。运行配置好的测试，检查终态输出与退出状态。若仍返回 queued 或 running，则继续等待返回的 jobId。"
          )
        ],
        code: `adc login --url https://adc.zioon.tech
adc connect project-review --json
adc invoke file.read --node NODE_ID \\
  --args '{"path":"/Users/me/work/project/README.md"}' --wait 4000 --json
adc invoke command.template.list --node NODE_ID \\
  --args '{}' --wait 4000 --json
adc invoke test.run --node NODE_ID \\
  --args '{"rootId":"ROOT_ID","timeoutMs":300000}' \\
  --idempotency-key project-review-test-001 --wait 4000 --json
adc task wait JOB_ID --wait 4000 --json`,
        links: [link("/docs/tools", "Template and shell semantics", "模板与 Shell 语义")]
      },
      {
        id: "controls",
        title: text("Know what the workflow verifies", "明确这条流程验证了什么"),
        paragraphs: [
          text(
            "The result should include the intended diff, test output and corresponding task records. A zero exit code supports the selected test's conclusion; it does not prove every behavior is correct. ADC records and routes the calls, while the agent and developer decide whether the change solves the problem.",
            "结果应包含预期 diff、测试输出与对应任务记录。退出码为零支持该项测试的结论，不代表所有行为都正确。ADC 记录与路由调用，Agent 和开发者判断修改是否解决问题。"
          ),
          text(
            "Revoke or narrow the access when the task is finished. Doing so cannot undo completed edits or external effects. Review the diff before committing; when a test's result is uncertain, follow its original task and reconcile instead of submitting a duplicate under a new key. Requested file contents and command output pass through the chosen service.",
            "任务结束后，可以撤销或收紧授权；这无法撤回已完成编辑或外部副作用。提交代码前应检查 diff；测试结果不确定时，跟踪原任务并核对，不要换新键重复执行。请求读取的文件内容与命令输出会经过所选服务。"
          )
        ],
        links: [link("/articles/durable-receipts-for-agent-side-effects", "Recover uncertain execution", "恢复不确定执行"), link("/privacy", "Understand the data path", "理解数据链路")]
      }
    ]
  },
  {
    path: "/updates/websocket-task-wakeups",
    kind: "Product update",
    title: text("Faster task delivery with outbound WebSocket wakeups", "使用出站 WebSocket 唤醒加快任务领取"),
    summary: text("Why the Connector now receives a small wake signal, how tasks are still claimed durably, and what operators should check when delivery slows down.", "Connector 为什么改为接收小型唤醒信号、任务怎样继续持久领取，以及投递变慢时应该检查什么。"),
    publishedAt: "2026-09-29",
    updatedAt: "2026-11-03",
    readingMinutes: 4,
    keywords: ["AI agent WebSocket", "durable task queue", "device connector", "outbound connection"],
    listed: true,
    relatedPaths: ["/articles/ai-agent-behind-nat", "/updates/connector-0-1-3", "/articles/durable-receipts-for-agent-side-effects"],
    sections: [
      {
        id: "what-changed",
        title: text("Notify an idle device when work arrives", "任务到达时通知空闲设备"),
        paragraphs: [
          text(
            "A polling Connector has to ask for work even when there is none. Frequent polling shortens the delay before a tool starts, but creates idle traffic and repeated server work. This update replaces reliance on one-second idle polling with an authenticated outbound WebSocket that can wake the device when a task is available.",
            "轮询式 Connector 即使没有任务，也需要不断查询。频繁轮询能缩短工具启动前的等待，却产生空闲请求与重复服务开销。本次更新通过经过认证的出站 WebSocket，在任务可领取时唤醒设备，减少对每秒空闲轮询的依赖。"
          ),
          text(
            "For example, an agent submits a read while the connected device is idle. The service stores the invocation, then emits dispatch.available. The Connector receives the signal and polls promptly rather than waiting for the next scheduled idle check. This changes discovery latency, not the file tool or the authorization contract.",
            "例如，Agent 在设备空闲时提交读取。服务先保存调用，再发送 dispatch.available。Connector 收到信号后及时轮询，无需等到下一次空闲检查。这改变的是发现任务的等待时间，不改变文件工具或授权契约。"
          ),
          text(
            "The wake signal carries no invocation body, path, credential or authorization decision. The Connector still uses the signed poll endpoint. The service revalidates policy, and PostgreSQL atomically claims the dispatch. A wake signal alone never authorizes execution.",
            "唤醒信号不携带调用正文、路径、凭据或授权结论。Connector 仍使用签名 poll 接口；服务重新校验策略，由 PostgreSQL 原子领取任务。单独收到唤醒信号不会获得执行授权。"
          )
        ],
        links: [link("/docs/concepts", "How ADC routes a tool call", "ADC 怎样路由工具调用")]
      },
      {
        id: "failure-model",
        title: text("Recover missed signals from stored tasks", "通过已保存任务恢复丢失信号"),
        paragraphs: [
          text(
            "Wake delivery is best effort. A proxy can restart, a laptop can sleep, or a message can be lost. Reconnection triggers an immediate poll; a 30-second fallback poll recovers available work even when no wake arrives. The stored task remains authoritative, so a missed signal does not delete it and repeated signals do not create extra invocations.",
            "唤醒投递按尽力而为处理。代理会重启、笔记本会休眠、消息也可能丢失。重连后立即轮询；即使没有收到唤醒，30 秒兜底轮询仍能发现可领取工作。已保存任务是事实来源，所以信号丢失不会删除任务，重复信号也不会创建额外调用。"
          ),
          text(
            "The device uses reconnect backoff with jitter. In a single control-plane instance it keeps one active wake connection per device. A slower fallback is a recovery mechanism, not a promise that every task starts within 30 seconds: offline devices, approvals, queueing and expired budgets can still prevent execution.",
            "设备使用带抖动的重连退避。单个控制面实例内，每台设备保留一条活跃唤醒连接。低频轮询是恢复机制，不是「所有任务都在 30 秒内启动」的承诺：设备离线、审批、排队与预算到期，仍可能阻止执行。"
          ),
          text(
            "This is a transport change for task notifications. It does not introduce a peer-to-peer tool path or a general tunnel. Results and task reads continue through the existing service, and side-effect recovery still depends on the original task identity and receipt.",
            "这是任务通知的传输改进，没有引入点对点工具通道或通用隧道。结果与任务读取继续使用原服务链路；副作用恢复仍依赖原任务身份与回执。"
          )
        ]
      },
      {
        id: "operations",
        title: text("Check connection, polling and task evidence together", "同时检查连接、轮询与任务证据"),
        paragraphs: [
          text(
            "Older Connectors can continue polling. An operator's reverse proxy must allow the authenticated WebSocket upgrade for the new path to work. Inspect the active wake connection gauge and wake/poll counters together with Connector logs and a real read-only task; an open socket alone does not prove successful dispatch.",
            "旧版 Connector 可以继续轮询。运维者的反向代理需要允许经过认证的 WebSocket 升级，新链路才能工作。应结合活跃连接指标、唤醒与轮询计数、Connector 日志，以及一次真实只读任务来检查；仅有开放连接不能证明调度成功。"
          ),
          text(
            "If wake connections drop but signed polling still dispatches tasks, investigate the proxy and network path. If polling is denied, investigate identity and policy instead. If dispatch succeeds but work never completes, inspect execution and receipt reporting. The metric names below are Prometheus series, not shell commands.",
            "唤醒连接中断、签名轮询仍能领取任务时，应检查代理与网络链路；轮询被拒绝时，应检查身份与策略；领取成功却不完成时，应检查执行与回执上报。下方是 Prometheus 指标名称，不是 Shell 命令。"
          ),
          text(
            "Presence updates are batched rather than rewriting capability data on every signed request. Lease traffic also helps keep long-running work visible. To assess user impact, measure submission, dispatch and completion for representative tasks; this release note does not claim a benchmark improvement without those measurements.",
            "在线状态更新采用批处理，不再在每个签名请求中重复写入能力数据。租约请求也帮助维持长任务在线状态。评估用户效果时，应测量代表性任务的提交、领取与完成时间；没有这些测量，本记录不宣称具体性能提升。"
          )
        ],
        code: `adc_node_wake_connections
adc_node_wake_total{outcome="attempted|offline"}
adc_node_poll_total{outcome="dispatched|idle|denied"}`,
        links: [link("/docs/self-hosting", "Service and proxy setup", "服务与代理配置"), link("/docs/troubleshooting", "Diagnose delayed tasks", "排查任务延迟")]
      }
    ]
  },
  {
    path: "/updates/public-knowledge-base",
    kind: "Product update",
    title: text("A public knowledge base for an open-source device cloud", "为开源设备云建立公开知识库"),
    summary: text("A historical note on making setup, product boundaries and implementation changes publicly inspectable, with links to the current documentation.", "记录接入步骤、产品边界与实现变化如何公开供读者查阅，并指向当前文档。"),
    publishedAt: "2026-09-29",
    updatedAt: "2026-11-03",
    readingMinutes: 4,
    keywords: ["ADC documentation", "open source device access", "public release notes"],
    listed: false,
    relatedPaths: ["/articles/agents-and-execution-devices", "/guides/first-device-to-first-tool-call", "/articles/least-privilege-for-ai-agents"],
    sections: [
      {
        id: "published-surface",
        title: text("Help readers evaluate the product before installing", "让读者在安装前理解产品"),
        paragraphs: [
          text(
            "This historical note records the addition of a public documentation and article surface. A device-access service asks users to connect real computers and authorize actions, so a short slogan is insufficient. Readers need to know where work executes, which data passes through the service, and how to stop or narrow access.",
            "这篇历史记录说明公开文档与文章入口的建立。设备接入服务需要用户连接真实电脑并授权操作，简短口号不足以支持这种决定。读者需要理解工作在哪里执行、哪些数据经过服务，以及怎样停止或收紧访问。"
          ),
          text(
            "The current site separates practical guides, explanations, reference and product changes. New readers can start with why the agent and execution device are separate, then complete the first-device guide. Developers integrating ADC can use the CLI, tool and API references instead of reconstructing behavior from screenshots.",
            "当前站点分别组织操作指南、原理解释、参考与产品变化。新读者可以先理解 Agent 与执行设备为什么分开，再完成首次设备指南。集成 ADC 的开发者可以直接查阅 CLI、工具与 API 参考，无需根据截图推测行为。"
          )
        ],
        links: [link("/articles/agents-and-execution-devices", "Understand the product's role", "理解产品定位"), link("/docs", "Current documentation", "当前文档")]
      },
      {
        id: "discovery",
        title: text("Make useful information discoverable", "让有用信息容易找到"),
        paragraphs: [
          text(
            "Public routes have their own titles, descriptions and canonical URLs. The same route catalog supplies statically rendered pages, a sitemap and a release/article feed. This gives readers stable links and helps crawlers find the pages; it does not guarantee search ranking or prove a technical claim.",
            "公开路由拥有独立标题、说明和规范链接。同一份路由目录提供静态页面、站点地图与动态文章订阅，方便读者使用稳定链接，也帮助爬虫发现内容；它不保证搜索排名，更不能证明技术结论。"
          ),
          text(
            "Machine-readable llms.txt resources summarize the public material for tools that choose to consume them. They do not connect an agent to a device or bypass authorization. An integration still needs an account, a grant and a supported client path.",
            "机器可读的 llms.txt 为选择读取它的工具汇总公开内容。它不会自动把 Agent 连接到设备，也不能绕过授权。实际集成仍需要账号、授权与受支持的客户端链路。"
          )
        ],
        links: [link("/docs/integrations", "Agent integration steps", "Agent 集成步骤"), link("/docs/api", "API behavior", "API 行为参考")]
      },
      {
        id: "privacy",
        title: text("Explain data handling alongside setup", "接入说明同时解释数据处理"),
        paragraphs: [
          text(
            "Local execution means tools run on the selected device; it does not mean requested data never reaches the control plane. The public privacy explanation covers account records, disclosed device metadata, requests and results. Optional website analytics is a separate feature with a small route and onboarding event catalog.",
            "本地执行意味着工具在所选设备运行，不代表请求涉及的数据从不经过控制面。公开隐私说明涵盖账号记录、设备披露元数据、请求与结果。可选网站分析是另一项功能，只使用有限路由与接入事件目录。"
          ),
          text(
            "Source builds do not configure a project analytics destination by default. An operator must explicitly configure the provider to enable it, and the browser checks GPC and Do Not Track first. This default concerns website analytics; it does not disable the task records required to operate the service.",
            "源码构建默认不配置项目分析目的地。管理员必须显式配置服务才能启用，浏览器也会先检查 GPC 与 Do Not Track。这一默认值针对网站分析，不会关闭服务运行所需的任务记录。"
          )
        ],
        links: [link("/privacy", "Privacy explanation", "隐私说明"), link("/telemetry", "Analytics configuration and events", "分析配置与事件")]
      },
      {
        id: "next",
        title: text("Keep explanations tied to shipped behavior", "让公开说明对应真实行为"),
        paragraphs: [
          text(
            "Documentation lives with the implementation so a tool change can update its instructions in the same review. A useful guide states prerequisites, commands, expected results and failure handling. An engineering article explains the mechanism and its limits. A release note describes user impact and upgrade compatibility.",
            "文档与实现同库维护，工具改变时可以在同一次审阅中更新说明。有用的指南需要前提、命令、预期结果与故障处理；原理文章需要机制和边界；版本记录需要用户影响与升级兼容性。"
          ),
          text(
            "This page remains at its historical URL for existing references, but the main article index prioritizes product explanations and current release notes. For today's supported behavior, use the current reference and changelog. Windows Node and Android Node are still marked as testing there; publishing documentation does not change their maturity.",
            "本页保留历史 URL 供旧引用使用，主文章索引优先展示产品解释与当前版本记录。今天的支持行为应以当前参考和变更记录为准。其中仍明确标注 Windows Node 与 Android Node 处于测试阶段；公开文档不会改变它们的成熟度。"
          )
        ],
        links: [link("/docs/changelog", "Current release history", "当前版本历史"), link("/docs/contributing", "Contribute implementation and documentation", "贡献实现与文档")]
      }
    ]
  },
  {
    path: "/privacy",
    kind: "Policy",
    title: text("Privacy", "隐私说明"),
    summary: text("What the service processes during device use, what remains local, and how optional website analytics differs from operational records.", "使用设备时服务处理哪些数据、哪些数据保留在本地，以及可选网站分析与运行记录有什么区别。"),
    publishedAt: "2026-09-29",
    updatedAt: "2026-11-03",
    readingMinutes: 4,
    keywords: ["ADC privacy", "local device data", "self-hosted analytics"],
    listed: false,
    sections: [
      {
        id: "product-data",
        title: text("Data needed to operate device access", "设备接入运行所需的数据"),
        paragraphs: [
          text(
            "ADC processes account and session records, authorizations, disclosed device names and capabilities, selected root metadata, task requests, states, requested results and receipts. The control plane does not automatically crawl or mirror the connected filesystem. However, a file.read request can return file content, and shell output can contain paths or other sensitive information.",
            "ADC 处理账号与会话记录、授权、设备披露的名称与能力、所选根目录元数据、任务请求、状态、请求返回的结果和回执。控制面不会自动抓取或镜像已连接文件系统。但 file.read 可以返回文件内容，Shell 输出也可能包含路径或其他敏感信息。"
          ),
          text(
            "Tools execute on the selected device. Their arguments and returned data pass through the chosen service and can be stored as operational task records. TLS protects network transport; it is not end-to-end encryption that hides tool data from the service operator. The agent or model provider receiving the result has its own data handling rules.",
            "工具在所选设备上执行，参数与返回数据经过所选服务，并可能作为任务运行记录保存。TLS 保护网络传输，但不是向服务运营者隐藏工具数据的端到端加密。接收结果的 Agent 或模型服务，也有自己的数据处理规则。"
          ),
          text(
            "Device private keys and locally configured MCP provider credentials remain on the device in the normal integration path. Unrequested file contents are not uploaded automatically. These boundaries cannot prevent an authorized command or provider from deliberately returning a secret; choose tools and review outputs accordingly.",
            "正常集成链路中，设备私钥与本地配置的 MCP Provider 凭据保留在设备上，未请求文件的内容不会自动上传。这些边界不能阻止已授权命令或 Provider 主动返回秘密；选择工具与检查输出时，应考虑实际任务。"
          )
        ],
        links: [link("/docs/security", "Authorization and local execution boundaries", "授权与本地执行边界")]
      },
      {
        id: "hosted-analytics",
        title: text("Optional website analytics", "可选网站分析"),
        paragraphs: [
          text(
            "A hosted deployment may configure Plausible for page visits and named onboarding events such as pairing-code creation or Agent access creation. The built-in integration uses known route names rather than arbitrary device-detail URLs. Product events do not attach invocation arguments, execution results, account names or device labels.",
            "托管部署可以配置 Plausible，统计页面访问和具名接入事件，例如创建配对码或 Agent 授权。内置集成使用已知路由名称，不使用任意设备详情 URL。产品事件不附加调用参数、执行结果、账号名称或设备标签。"
          ),
          text(
            "Public page views can include allowlisted campaign parameters such as utm_source and ref. Those are supplied by the visiting URL, so do not put private data in campaign links. The configured provider also receives browser requests and applies its own processing rules. This explanation describes ADC's integration, not a guarantee about every possible operator configuration.",
            "公开页面访问可以附带允许的活动参数，例如 utm_source 与 ref。这些值来自访问 URL，请勿在活动链接中放入私人数据。配置的分析服务也会收到浏览器请求，并按自身规则处理。本说明描述 ADC 的集成行为，不能代替对所有管理员配置的保证。"
          )
        ],
        links: [link("/telemetry", "Exact event and configuration policy", "事件与配置策略")]
      },
      {
        id: "self-hosting",
        title: text("Who operates the service matters", "服务由谁运营很重要"),
        paragraphs: [
          text(
            "A source build or self-hosted instance has no project analytics destination configured by default. The operator controls the service database, logs, backups and optional analytics provider. Running an agent, Connector or integration against the official service still sends the requests needed for that service, even when website analytics is disabled.",
            "源码构建与自托管实例默认没有项目分析目的地。管理员控制服务数据库、日志、备份与可选分析服务。即使网站分析关闭，Agent、Connector 或集成连接官方服务时，仍会发送运行该服务所需的请求。"
          ),
          text(
            "Revoking a grant or unpairing a device stops the corresponding future access; it does not automatically erase previous task records or backups. This page does not promise a uniform retention period, automatic deletion job or deletion deadline. For a self-hosted service, verify its operator's retention and backup procedures before sending data.",
            "撤销授权或取消设备配对会停止对应后续访问，不会自动擦除先前任务记录或备份。本页不承诺统一保留期限、自动删除任务或删除时限。使用自托管服务前，应向运营者核对保留与备份流程。"
          )
        ],
        links: [link("/docs/self-hosting", "Self-hosted deployment responsibilities", "自托管部署职责")]
      },
      {
        id: "controls",
        title: text("Controls available to users and operators", "用户与管理员可用的控制"),
        paragraphs: [
          text(
            "Users can select folders and tools, require approval, revoke Agent access and remove device exposure. These controls limit requested operations and data; they do not retroactively remove completed effects. Use a small known file for initial verification and expand permissions for an actual task.",
            "用户可以选择目录与工具、要求审批、撤销 Agent 授权，以及移除设备开放范围。这些控制限制可请求操作与数据，不会追溯消除已完成效果。首次验证可以使用已知小文件，再按实际任务扩展权限。"
          ),
          text(
            "Operators can disable analytics by removing both ADC_ANALYTICS_SCRIPT_URL and ADC_ANALYTICS_DOMAIN. The built-in browser integration checks Global Privacy Control and Do Not Track before loading the configured script or emitting events. Authentication cookies and required service requests serve a separate purpose and are not disabled by this analytics choice.",
            "管理员移除 ADC_ANALYTICS_SCRIPT_URL 与 ADC_ANALYTICS_DOMAIN 后，可以关闭分析。内置浏览器集成在加载配置脚本或发送事件前检查 Global Privacy Control 与 Do Not Track。身份认证 Cookie 与必要服务请求有独立用途，不会随分析选项一起关闭。"
          )
        ]
      }
    ]
  },
  {
    path: "/telemetry",
    kind: "Policy",
    title: text("Telemetry policy", "遥测策略"),
    summary: text("The default analytics behavior, the configured event catalog, and the boundary between website measurement and operational task data.", "默认分析行为、配置后的事件目录，以及网站统计与任务运行数据之间的边界。"),
    publishedAt: "2026-09-29",
    updatedAt: "2026-11-03",
    readingMinutes: 4,
    keywords: ["ADC telemetry", "analytics configuration", "Plausible", "GPC"],
    listed: false,
    sections: [
      {
        id: "default",
        title: text("Analytics requires explicit configuration", "分析需要显式配置"),
        paragraphs: [
          text(
            "The source project does not configure an ADC analytics endpoint or site identifier by default. Its browser integration is inactive unless the deployment injects configuration for Plausible. This concerns optional website measurement; authentication, device heartbeats and authorized tool requests still contact whichever service you chose.",
            "源码项目默认不配置 ADC 分析端点或站点标识。只有部署注入 Plausible 配置后，浏览器集成才会启用。这针对可选网站统计；身份认证、设备心跳与已授权工具请求，仍会联系你选择的服务。"
          ),
          text(
            "The operator must set ADC_ANALYTICS_SCRIPT_URL and ADC_ANALYTICS_DOMAIN together. The script URL must use HTTPS and the domain must be a hostname. Remove both values to disable injection. GPC or Do Not Track prevents the built-in integration from loading its script or calling the provider, even when the deployment is configured.",
            "管理员必须同时设置 ADC_ANALYTICS_SCRIPT_URL 与 ADC_ANALYTICS_DOMAIN。脚本 URL 需要 HTTPS，domain 需要是主机名。移除两项可关闭注入。即使部署已配置，GPC 或 Do Not Track 也会阻止内置集成加载脚本或调用分析服务。"
          )
        ],
        code: `ADC_ANALYTICS_SCRIPT_URL=https://analytics.example.com/script.js
ADC_ANALYTICS_DOMAIN=devices.example.com`,
        links: [link("/docs/self-hosting", "Deployment configuration", "部署配置")]
      },
      {
        id: "hosted-events",
        title: text("Routes and named onboarding events", "路由与具名接入事件"),
        paragraphs: [
          text(
            "Page views are limited to known public routes and a fixed set of account and console routes. Arbitrary nested device URLs are not accepted as analytics paths. Public views may include utm_source, utm_medium, utm_campaign, utm_content, utm_term, ref and source, with bounded string lengths; other query parameters are not copied by this integration.",
            "页面统计限于已知公开路由，以及固定账号与控制台路由。任意嵌套设备 URL 不会被当作分析路径。公开访问可以附带 utm_source、utm_medium、utm_campaign、utm_content、utm_term、ref 与 source，并限制字符串长度；该集成不会复制其他查询参数。"
          ),
          text(
            "The event catalog describes onboarding progress rather than tool execution. GitHub Sign In Started measures the start of the flow, not a completed login. The current names are listed below; a recorded event does not itself prove a device tool is operational.",
            "事件目录描述接入进度，不记录工具执行。GitHub Sign In Started 表示开始流程，不表示已完成登录。当前名称如下；出现事件本身不能证明设备工具已经可用。"
          )
        ],
        bullets: [
          text("Primary CTA Selected — choosing a primary entry point.", "Primary CTA Selected：点击主要入口。"),
          text("Account Registered and Account Signed In — successful account actions.", "Account Registered 与 Account Signed In：成功完成账号操作。"),
          text("GitHub Sign In Started — starting the external sign-in flow.", "GitHub Sign In Started：开始外部登录流程。"),
          text("Pairing Code Created — issuing a device pairing code.", "Pairing Code Created：创建设备配对码。"),
          text("Agent Access Created — creating an authorization.", "Agent Access Created：创建授权。"),
          text("Connection Created — creating a credential or binding.", "Connection Created：创建凭据或绑定。"),
          text("Initial Setup Completed — completing the initial setup flow.", "Initial Setup Completed：完成首次配置流程。")
        ]
      },
      {
        id: "never",
        title: text("What the built-in events omit", "内置事件不附带哪些数据"),
        paragraphs: [
          text(
            "Current product-event callers do not attach tool arguments, file contents, shell commands, results, prompts, credentials, email addresses, account names, device labels or repository names. Invocation submission is not mapped to an onboarding event. Event properties describe coarse context such as the placement of an entry point.",
            "当前产品事件调用方不附加工具参数、文件内容、Shell 命令、结果、Prompt、凭据、邮箱、账号名称、设备标签或仓库名称。提交调用不会映射为接入事件。事件属性描述入口位置等粗粒度上下文。"
          ),
          text(
            "The property helper bounds key format, number of properties and string length; it is not a secret-detection system. Campaign values are user-controlled URL text. Operators and contributors must keep private data out of these inputs, and must review new event callers rather than assuming the helper makes arbitrary text safe.",
            "属性辅助函数限制键名格式、属性数量与字符串长度，但不是秘密检测系统。活动参数是用户控制的 URL 文本。管理员与贡献者应避免把私人数据放入这些输入，并检查新增事件调用，不能假设辅助函数会自动让任意文本安全。"
          )
        ],
        links: [link("/privacy", "Broader product data handling", "完整产品数据处理说明")]
      },
      {
        id: "audit-separation",
        title: text("Disabling analytics does not disable task records", "关闭分析不会关闭任务记录"),
        paragraphs: [
          text(
            "Website analytics measures visits and onboarding. Operational task records hold the requests, states, results and receipts needed to route work and review effects. Service health metrics describe connections, dispatch and failures. They have different purposes; the analytics switch only controls the optional browser integration.",
            "网站分析衡量访问与接入进度。任务运行记录保存路由与效果复核所需的请求、状态、结果和回执。服务健康指标描述连接、调度与故障。它们用途不同；分析开关只控制可选浏览器集成。"
          ),
          text(
            "Self-hosted operators must separately manage database access, logs, backups and retention. This policy does not establish a universal automatic deletion schedule for any of them. Custom analytics scripts or additional monitoring integrations are operator choices and require their own review.",
            "自托管管理员需要分别管理数据库访问、日志、备份与保留。本策略不为它们设定统一自动删除周期。自定义分析脚本或额外监控集成属于管理员选择，需要独立检查。"
          )
        ]
      }
    ]
  }
];
