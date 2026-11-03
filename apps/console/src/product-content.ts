import type { LocalizedText, PublicContentEntry } from "./public-content.ts";

const text = (en: string, zh: string): LocalizedText => ({ en, "zh-CN": zh });

export const adcPositioningArticle: PublicContentEntry = {
  path: "/articles/agents-and-execution-devices",
  kind: "Engineering",
  title: text(
    "Why separate an agent from the devices it works on?",
    "为什么要把 Agent 和它干活的设备分开？"
  ),
  summary: text(
    "An agent can plan in one place and use tools on several devices. Where ADC fits, what it provides, and what remains the responsibility of the agent and device.",
    "Agent 可以在一个地方规划任务，再调用多台设备上的工具。本文用一个完整任务说明 ADC 负责什么，以及哪些工作仍由 Agent 和设备完成。"
  ),
  publishedAt: "2026-11-03",
  updatedAt: "2026-11-03",
  readingMinutes: 6,
  keywords: ["Agent Device Cloud", "agent infrastructure", "remote execution", "multi-device agents"],
  listed: true,
  relatedPaths: [
    "/articles/cloud-agent-local-devices",
    "/articles/not-remote-ssh",
    "/guides/first-device-to-first-tool-call",
    "/articles/ai-agent-behind-nat"
  ],
  sections: [
    {
      id: "a-task-across-devices",
      title: text("A task that spans several devices", "一个需要多台设备的任务"),
      paragraphs: [
        text(
          "Consider a developer with source code on a Mac, a Linux machine with a configured build environment, and a GPU server with training data. The developer asks an agent: inspect the code, run the build on Linux, then check the training logs. This is an illustrative workflow, not a published benchmark or a claim that ADC has completed it automatically.",
          "设想你有一台存着源码的 Mac、一台已经配置好构建环境的 Linux 开发机，以及一台保存训练数据的 GPU 服务器。你对 Agent 说：检查代码，在 Linux 上构建，再看看 GPU 服务器上的训练日志。这是一条说明分工的示例流程，不是性能测试，也不代表 ADC 会自行完成整项任务。"
        ),
        text(
          "The agent already knows how to read files and run commands. The missing piece is access to the machine where each step belongs. Copying every repository, dependency, credential and dataset into the agent's own environment may be unnecessary, expensive or prohibited. Installing a separate agent on every target is another possible approach, but it adds agent instances to manage when all the task needs is access to those devices' tools.",
          "Agent 本身已经会读文件、写命令，缺少的是到正确设备上调用工具的方式。为了每次任务复制仓库、依赖、凭据和数据，可能没有必要，也可能代价很高或不被允许。给每台目标机器再安装一个 Agent 也是一种方案，但如果只需要使用这些机器的工具，就增加了不必要的 Agent 实例管理。"
        ),
        text(
          "The agent and the execution environment do not have to be the same machine. One agent can request a file read on the Mac, a build on Linux and a log read on the GPU server. Conversely, different authorized agents can use the same device. Shared access still depends on the device owner and the grant assigned to each caller.",
          "Agent 所在的位置与执行环境不必是同一台机器。一个 Agent 可以请求在 Mac 上读文件、在 Linux 上构建、在 GPU 服务器上读日志；不同的已授权 Agent 也可以复用同一台设备。设备是否可用，仍取决于设备所有者开放了什么，以及每个调用方获得了什么授权。"
        )
      ]
    },
    {
      id: "the-three-responsibilities",
      title: text("The agent plans, ADC routes, the device executes", "Agent 规划，ADC 路由，设备执行"),
      paragraphs: [
        text(
          "The agent or its Runtime calls the model, interprets the request, chooses a tool and target, writes the command, and decides what to do with the result. ADC does not run another model to rewrite commands, plan steps or summarize the user's task. Model usage belongs to the agent service you selected.",
          "Agent 或它的 Runtime 负责调用模型、理解需求、选择工具和目标设备、生成命令，并根据结果决定下一步。ADC 不会再调用一个模型来改写命令、规划步骤或总结你的任务；模型使用属于你选择的 Agent 服务。"
        ),
        text(
          "ADC provides the common entry point: device discovery, current capabilities, authentication, authorization, optional approvals, routing, task state and activity records. Calling it a router describes its place in the architecture, but does not mean it is a stateless byte forwarder. It also keeps the records needed to operate the service.",
          "ADC 提供统一入口：发现设备和当前能力、身份认证、授权、可选审批、调用路由、任务状态与活动记录。说它是“路由层”，是在描述它的架构职责，不意味着它只是一个无状态字节转发器；服务运行需要的记录也会保存在控制面。"
        ),
        text(
          "A connector on the target device exposes local tools, validates the request and executes it. The target computer needs the connector and the programs required by the task, but does not need its own conversational agent or model API key merely to serve as an execution device.",
          "目标设备上的 Connector 开放本地工具、校验请求并执行。作为执行设备，电脑需要连接器和任务所需的程序，但不需要仅仅为了被调用而再安装一个对话 Agent 或配置模型 API Key。"
        )
      ],
      code: `Agent / Runtime
  chooses: shell.exec on Build Linux
  supplies: npm run build
          |
          v
ADC
  checks access and approvals
  routes the call and tracks its state
          |
          v
Connector on Build Linux
  executes with the configured local permissions
  returns stdout, stderr, exit code and receipt`
    },
    {
      id: "an-interface-not-a-model",
      title: text("MCP, CLI, Skill and plugins are ways to use the same service", "MCP、CLI、Skill 和插件接入的是同一个服务"),
      paragraphs: [
        text(
          "MCP exposes tools and their input schemas to a compatible client. The CLI makes the same service accessible to an agent with a shell tool, to a script, or to a person. The Skill describes how to discover devices, invoke tools and follow tasks through the CLI. Host plugins can provide guided setup and device context, depending on the capabilities of that host.",
          "MCP 向兼容客户端暴露工具及输入格式；CLI 让有 shell 工具的 Agent、脚本或人直接调用同一个服务；Skill 说明怎样发现设备、调用工具、跟踪任务；宿主插件则可以提供接入引导和设备上下文，具体能力取决于宿主。"
        ),
        text(
          "These are not separate execution backends. Changing from MCP to CLI does not move the work onto the ADC server or remove the grant. The important decision is which agent will request work, which device should execute it, and which authorization connects them.",
          "这些方式不是几套独立的执行后端。从 MCP 换成 CLI，不会让任务改到 ADC 服务器执行，也不会绕过授权。真正需要确定的是：由哪个 Agent 发起工作、在哪台设备执行，以及用哪份授权连接两者。"
        )
      ],
      code: `adc connect my-agent
adc node list --json
adc tool show shell.exec --json
adc invoke shell.exec --node node_build_linux \\
  --args '{"cwd":"/work/project","command":"npm run build","timeoutMs":120000}' \\
  --idempotency-key build-project-001 --wait 4000 --json`,
      bullets: [
        text(
          "Use a real device ID and an authorized directory from discovery, not the example values.",
          "用设备发现结果中的真实设备 ID 和已授权目录替换示例值。"
        ),
        text(
          "The directory must permit execution and be writable; npm and the project dependencies must already exist on the target.",
          "目录必须允许执行且可写；目标设备上需要已经安装 npm 和项目依赖。"
        ),
        text(
          "Use Bash syntax on macOS/Linux and PowerShell syntax on Windows. ADC does not translate commands between operating systems.",
          "macOS/Linux 使用 Bash 语法，Windows 使用 PowerShell 语法。ADC 不负责跨操作系统翻译命令。"
        )
      ]
    },
    {
      id: "devices-and-people",
      title: text("From personal devices to shared execution environments", "从个人设备到共享执行环境"),
      paragraphs: [
        text(
          "For an individual, the value may be using a home computer or server from an agent running somewhere else. For a team, several engineers' devices can hold distinct dependencies, private services or hardware. Sharing lets the owner make specific capabilities available to named people rather than requiring every collaborator to rebuild the same environment.",
          "对个人来说，价值可能是让运行在其他地方的 Agent 使用家里的电脑或服务器。对团队来说，不同工程师的设备可能有不同的依赖、内部服务或硬件。共享让所有者把选定能力开放给指定的人，而不要求每个协作者都重新搭建同一套环境。"
        ),
        text(
          "This is why permissions belong in the product. They make a shared environment usable without treating registration as blanket access. An administrator can define team device access; each person still connects their agent through its own grant. Approval and revocation remain operational controls, not a promise that arbitrary shell execution becomes harmless.",
          "权限能力因此是产品的一部分：它让共享环境可用，同时不把“注册了设备”当成“所有人都能访问”。管理员可以设置团队的设备策略，每个人仍通过自己的授权接入 Agent。审批和撤销是实际控制手段，不代表任意 shell 命令从此没有风险。"
        )
      ]
    },
    {
      id: "what-it-is-not",
      title: text("The boundary of this infrastructure", "这层基础设施的边界"),
      paragraphs: [
        text(
          "ADC supplies device access, not the intelligence or business logic of a workflow. A knowledge base decides how information is stored and retrieved; a business integration defines its own operations; the agent coordinates the task. ADC makes an authorized device or local tool reachable when that task needs it.",
          "ADC 提供设备接入，不提供整条工作流的智能或业务逻辑。知识库负责信息组织与检索，业务集成定义自己的操作，Agent 串联任务；当任务需要某台设备或某个本地工具时，ADC 让它在授权范围内可被调用。"
        ),
        text(
          "ADC can be used independently through supported clients or as the device service in Zioon. Using ADC does not require migrating to Zioon's Runtime or memory service. Self-hosting runs the same application and protocol under the operator's control; it does not create a second product with fewer authorization checks.",
          "ADC 可以通过支持的客户端独立使用，也可以作为 Zioon 中的设备服务。使用 ADC 不要求你迁移到 Zioon 的 Runtime 或记忆服务。自部署是在自己的基础设施上运行同一套应用和协议，不是另一个删去授权检查的产品。"
        ),
        text(
          "The wider idea is to expose more real-world execution environments to agents. macOS and Linux provide the available desktop paths; Windows Node and Android Node are in testing, and registered local MCP providers add further tools. A watch, television or printer needs an implementation, advertised capabilities and an access model before it can become a usable Node.",
          "更长远的方向是让 Agent 接触更多真实的执行环境。macOS 与 Linux 提供当前可用的桌面路径，Windows Node 和 Android Node 仍在测试阶段，已注册的本地 MCP Provider 可以补充更多工具。手表、电视或打印机需要相应实现、能力声明与访问模型，才能成为可用 Node。"
        )
      ]
    },
    {
      id: "evaluate-with-your-task",
      title: text("Evaluate it with a real task", "用一件真实任务判断是否需要它"),
      paragraphs: [
        text(
          "If your agent already runs on the only computer it needs and has suitable local tools, ADC may add little. If you already operate SSH with a maintained task system, that may be the right solution. ADC is worth trying when device discovery, multi-device access, local tools and shared permissions are work you would otherwise have to assemble yourself.",
          "如果 Agent 已经运行在唯一需要的电脑上，并且本地工具齐全，ADC 带来的增益可能不大。如果已经有维护成熟的 SSH 和任务系统，也可能继续使用现有方案更合适。需要自己拼装设备发现、多设备调用、本地工具接入与共享权限时，ADC 才更值得尝试。"
        ),
        text(
          "Start by naming the device and environment the task really needs. Then check that you can discover it, call its tools, inspect a result and revoke access. This tests a concrete benefit; it is more informative than counting supported interfaces or claiming that every agent needs another platform.",
          "先明确这件事真正需要哪台设备、哪种环境，再检查能否发现它、调用工具、查看结果并撤销访问。这样验证的是具体收益，比统计支持多少种接口，或者宣称每个 Agent 都需要一个新平台，更能帮助你判断。"
        )
      ],
      links: [
        { href: "/guides/first-device-to-first-tool-call", label: text("Verify the device access path", "验证设备接入链路") },
        { href: "/docs/concepts", label: text("Request lifecycle and ownership", "请求生命周期与数据归属") }
      ]
    }
  ]
};

export const remoteAccessComparisonArticle: PublicContentEntry = {
  path: "/articles/not-remote-ssh",
  kind: "Guide",
  title: text("Choosing between ADC, SSH and remote desktop", "ADC、SSH 与远程桌面怎么选"),
  summary: text(
    "These approaches overlap. Compare what you need to connect, how commands are invoked and what the caller must manage.",
    "几种方案存在重叠。按连接对象、调用方式和需要自行维护的工作来比较，判断哪一种适合你的任务。"
  ),
  publishedAt: "2026-09-29",
  updatedAt: "2026-11-03",
  readingMinutes: 4,
  keywords: ["ADC SSH comparison", "agent device access", "remote desktop", "MCP"],
  listed: true,
  relatedPaths: [
    "/articles/agents-and-execution-devices",
    "/articles/ai-agent-behind-nat",
    "/guides/first-device-to-first-tool-call"
  ],
  sections: [
    {
      id: "different-contract",
      title: text("First identify who is operating the device", "先看是谁在操作设备"),
      paragraphs: [
        text(
          "Remote desktop gives a person a view of another machine and an interactive way to operate it. When the task is to help somebody through an unfamiliar graphical application, that may be the most direct choice. An agent can also use computer-use tools, but that requires a supported interface and observation loop rather than assuming any remote desktop product is automatically agent-ready.",
          "远程桌面让人看到另一台机器的界面，并交互操作。当任务是帮别人处理一个不熟悉的图形应用时，这可能是最直接的选择。Agent 也可以使用 computer-use 工具，但需要适配的接口和观察循环，不能假设任意远程桌面产品天然就能给 Agent 调用。"
        ),
        text(
          "SSH is a mature way to execute commands on a reachable host. It supports scripted commands as well as interactive sessions, and can be restricted with dedicated users, forced commands, operating-system permissions and other controls. Describing SSH as necessarily unrestricted would be inaccurate.",
          "SSH 是成熟的远程命令执行方式，既支持脚本命令，也支持交互会话。专用账号、强制命令、操作系统权限等机制都可以限制访问，把 SSH 描述成必然交出整台电脑是不准确的。"
        ),
        text(
          "ADC exposes registered devices as discoverable tool targets for agents, scripts and applications. It includes built-in file tools, shell execution, command templates, Android capabilities and registered local MCP tools. Whether an interface is useful depends on the capabilities the selected device actually advertises.",
          "ADC 把已注册设备开放为可发现的工具目标，供 Agent、脚本和应用调用，包括内置文件工具、shell 执行、命令模板、Android 能力和已注册的本地 MCP 工具。某个接口是否可用，取决于所选设备实际声明了什么能力。"
        )
      ]
    },
    {
      id: "policy",
      title: text("Connectivity and the calling contract are separate questions", "连通设备与组织调用是两个问题"),
      paragraphs: [
        text(
          "An existing VPN or Tailscale-style network plus SSH can be a sound implementation. If an agent has credentials and a usable SSH tool, it can operate a remote computer. Adding a task service or MCP adapter can provide discovery, results and other features. ADC is not uniquely capable of remote execution.",
          "已有 VPN 或类似 Tailscale 的网络，再配合 SSH，可以构成有效方案。Agent 有凭据和可用的 SSH 工具，就能操作远程电脑；再加任务服务或 MCP 适配器，也可以实现发现设备、获取结果等功能。远程执行并不是 ADC 独占的能力。"
        ),
        text(
          "The practical comparison is how much of the calling contract you want to maintain: registered device identities, available tools, per-agent and shared access, approvals, task state, cancellation and activity records. ADC packages these into one service. If your existing setup already covers them well, replacing it needs a concrete reason.",
          "真正需要比较的是：设备身份、可用工具、每个 Agent 的权限、共享、审批、任务状态、取消和活动记录，这套调用管理你准备维护多少？ADC 把它们放在同一个服务中。如果现有方案已经覆盖得很好，替换它需要具体理由。"
        )
      ]
    },
    {
      id: "execution-boundary",
      title: text("A structured API does not make a shell into a sandbox", "结构化接口不会把 shell 变成沙箱"),
      paragraphs: [
        text(
          "ADC file operations validate paths against the permitted roots. For shell execution, the working directory is checked, but the command runs as a process with the connector's configured operating-system authority. Full device trust does not confine a process to its working directory. Templates constrain which command a caller selects; they do not supply general process isolation.",
          "ADC 的结构化文件操作会按允许的目录校验路径。shell 执行会校验工作目录，但命令仍是以连接器所配置的操作系统权限运行的进程；完整设备信任不会把进程限制在工作目录内。模板约束的是调用方可以选择哪条命令，不提供通用进程隔离。"
        ),
        text(
          "Approvals and receipts make intent and outcomes visible, and revocation prevents further ADC access. They cannot undo a completed host change or revoke an unrelated channel already created. Isolated shared execution is a distinct Linux-container mode with its own requirements and discarded workspace writes.",
          "审批与回执让请求意图和执行结果可见，撤销会阻止进一步的 ADC 访问，但无法还原已经完成的宿主机修改，也无法撤销此前建立的其他通道。共享设备的隔离执行是另一个有具体前提的 Linux 容器模式，工作区修改不会回写。"
        )
      ]
    },
    {
      id: "when-ssh",
      title: text("Choose for the workflow you actually have", "按真实工作流选择"),
      paragraphs: [
        text(
          "Use remote desktop for a person's visual assistance when that is the task. Keep SSH for established engineering access and emergency administration when its network and account model fit. Consider ADC when an agent or application needs a reusable device service across several machines and callers, especially when local MCP tools or named device sharing are involved.",
          "人需要看着界面帮忙时，远程桌面可能最合适；已有网络和账号体系适配时，工程访问与应急运维可以继续使用 SSH；Agent 或应用需要面向多台设备、多个调用方的可复用设备服务，尤其涉及本地 MCP 工具或指定用户共享时，可以考虑 ADC。"
        ),
        text(
          "These choices can coexist. ADC does not need to replace your SSH management path, and installing it does not establish that every future workflow should move through it. Compare setup effort, ongoing maintenance and the requirements of one real task.",
          "几种方式可以同时存在。ADC 不需要取代你的 SSH 管理通道，安装了它也不代表以后所有工作流都应该迁入其中。用一件真实任务比较接入成本、持续维护成本和所需能力，更容易得出有用结论。"
        )
      ],
      links: [
        { href: "/docs/security#limitations", label: text("Process execution limits", "进程执行边界") },
        { href: "/docs/tools#command-tools", label: text("Shell and template tool reference", "Shell 与模板工具参考") },
        { href: "/docs/collaboration", label: text("Shared execution modes", "共享执行模式") }
      ]
    }
  ]
};
