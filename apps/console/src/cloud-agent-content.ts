import type { LocalizedText, PublicContentEntry } from "./public-content.ts";

const text = (en: string, zh: string): LocalizedText => ({ en, "zh-CN": zh });

export const cloudAgentArticle: PublicContentEntry = {
  path: "/articles/cloud-agent-local-devices",
  kind: "Engineering",
  title: text(
    "When a cloud agent needs your computer: the device access layer",
    "云端 Agent 想在你的电脑上干活，中间还缺什么？"
  ),
  summary: text(
    "Personal agents can reason and use cloud tools, but your files, programs and hardware may live elsewhere. Why device access becomes necessary, how ADC supplies it, and what cross-platform Nodes make possible.",
    "Personal agent 已经能理解需求、使用云端工具，但你的文件、软件和硬件可能在另一台设备上。本文解释设备接入层为什么必要，ADC 怎样提供它，以及跨平台 Node 可以组合出什么能力。"
  ),
  publishedAt: "2026-11-03",
  updatedAt: "2026-11-03",
  readingMinutes: 6,
  keywords: ["personal agent", "cloud agent", "ADC", "local device access", "cross-platform Node"],
  listed: true,
  relatedPaths: [
    "/articles/agents-and-execution-devices",
    "/articles/not-remote-ssh",
    "/use-cases/remote-local-development"
  ],
  sections: [
    {
      id: "personal-and-cloud",
      title: text("Personal describes who it serves; cloud describes where it runs", "Personal 说的是服务对象，云端说的是运行位置"),
      paragraphs: [
        text(
          "A personal agent is an assistant working on behalf of a person, often across ongoing tasks and services. It can run locally or in the cloud. A cloud agent runs its agent loop and some tools on remote infrastructure. These descriptions overlap, but do not imply the same access to the person's devices.",
          "Personal agent 是围绕一个人提供服务的助手，可以持续处理不同任务、调用不同服务；它既可以在本地运行，也可以在云端运行。云端 Agent 则把 Agent 循环和部分工具放在远端基础设施上。这两个描述可以重叠，但不能据此推定它已经能操作这个人的设备。"
        ),
        text(
          "You might talk to such an agent from a phone while its actual runtime is in the cloud. It can search websites or use connected online services, yet still be unable to open a file on your work computer. The chat interface is not the execution environment.",
          "你可能在手机上与它对话，但它的 Runtime 实际在云端。它会搜网页、会用已经接入的线上服务，却可能打不开你工作电脑上的一个文件。对话界面在哪里，与任务能在哪里执行，是两回事。"
        )
      ]
    },
    {
      id: "why-access-is-necessary",
      title: text("Reasoning cannot substitute for access to a real device", "理解能力不能替代真实设备的访问通道"),
      paragraphs: [
        text(
          "Some tasks depend on a particular machine: editing a local repository, using installed engineering software, checking a home computer, reading logs on a GPU server, or operating an Android app. A cloud agent's own shell runs on its cloud machine. It does not gain these capabilities by reasoning better or by receiving a description of the target.",
          "有些任务依赖某台具体机器：修改本地仓库、使用已安装的工程软件、检查家里的电脑、读取 GPU 服务器上的日志，或者操作 Android 应用。云端 Agent 自己的 shell 运行在云机器上，不会因为模型更聪明、或者你告诉了它目标设备的名字，就获得这些能力。"
        ),
        text(
          "To act on the real device, there must be a reachable execution path. That path needs to know which device is meant, what tools it offers, who has access and how to return the result. A connector must actually perform the operation there. Without this path, the agent can suggest commands, ask you to execute them, or work on a copy in its own environment, but cannot complete the requested operation on the original device.",
          "要操作真实设备，必然需要一条可到达的执行通道。这条通道要知道目标是哪台设备、有哪些工具、谁有权调用、结果怎样返回，并且需要设备上的连接器真正执行。没有它，Agent 只能给建议、让你手工执行，或者在自己的环境里操作一份副本，无法完成你要求的原设备操作。"
        ),
        text(
          "ADC is a service for this layer. An agent vendor can also build equivalent connectivity into its product, and existing networking plus remote execution can provide it. The necessary capability is device access; ADC packages discovery, authorization, tool routing and task records so different agents can reuse it.",
          "ADC 就是提供这一层的服务。Agent 厂商也可以把类似连接能力内置到产品里，已有网络加远程执行工具也能提供这条通道。真正必需的是设备接入能力；ADC 把发现设备、授权、工具路由与任务记录组织起来，供不同 Agent 复用。"
        )
      ]
    },
    {
      id: "one-request",
      title: text("Follow one request from your phone to a workstation", "从手机上的一句话，到工作电脑上的一次操作"),
      paragraphs: [
        text(
          "Consider an illustrative request sent from your phone: read the project logs on my Linux workstation, identify yesterday's error and run the existing check command. The cloud agent discovers authorized devices through ADC, selects the Linux workstation and sees its available folders and tools.",
          "以一条说明流程的请求为例：你在手机上说，读一下 Linux 工作机里的项目日志，找出昨天的报错，再运行现有检查命令。云端 Agent 通过 ADC 发现已授权设备，选择 Linux 工作机，看到它可用的目录和工具。"
        ),
        text(
          "The agent chooses file.search and file.read to inspect logs, then a configured command template or shell.exec if the grant permits it. ADC checks the request and any required approvals, and routes it to the connector. The device runs the tool and returns output and task state; the agent interprets them and decides its next step.",
          "Agent 先选择 file.search、file.read 检索日志，再在授权允许时选择预设命令模板或 shell.exec。ADC 校验请求和所需审批，路由给连接器；设备执行工具，返回输出和任务状态；Agent 解释结果并决定下一步。"
        ),
        text(
          "The workstation needs the connector, the files and the programs the task requires. It does not need a second conversational agent just to receive the call. ADC does not invoke a model to generate the command, and its platform server is not where the user's command executes.",
          "工作机需要连接器、相关文件和任务用到的程序，不必为了接收调用再装一个对话 Agent。ADC 不会另调模型生成命令，用户命令也不会在 ADC 平台服务器上执行。"
        )
      ],
      code: `Phone: sends a task to your cloud agent
  -> Agent: selects a device and tools
  -> ADC: authorizes and routes each call
  -> Linux Node: reads logs and runs the configured check
  -> ADC: returns results and task state
  -> Agent: explains the result and continues`
    },
    {
      id: "different-nodes",
      title: text("Different systems contribute different capabilities", "不同系统成为 Node，贡献的是不同能力"),
      paragraphs: [
        text(
          "A Node is a device identity with advertised capabilities, not another copy of the model. A Mac can contribute a repository and local development tools; Linux can contribute a build environment, installed inference programs or access to a GPU; Windows can contribute desktop files and PowerShell tools; Android can contribute device state and supported app or interface actions.",
          "Node 是一份带能力声明的设备身份，不是又一份大模型。Mac 可以提供仓库和本地开发工具；Linux 可以提供构建环境、已安装的推理程序或 GPU 资源；Windows 可以提供桌面文件和 PowerShell 工具；Android 可以提供设备状态，以及支持的应用或界面操作。"
        ),
        text(
          "Windows Node and Android Node are currently in testing. Windows installation and execution behavior continue to be validated; Android behavior depends on the phone model, OS and local permissions. macOS and Linux provide the available desktop connector paths. None of these labels promises that every installed application automatically becomes an ADC tool.",
          "Windows Node 和 Android Node 目前仍在测试阶段。Windows 的安装与执行行为还在验证，Android 行为取决于机型、系统和本地权限；macOS 与 Linux 提供当前可用的桌面连接器路径。这些状态也不意味着设备上的每个应用都会自动变成 ADC 工具。"
        ),
        text(
          "The agent must select the correct tool and syntax for the target. Bash on a Linux machine and PowerShell on Windows are different command environments. A GPU server is useful only if the local programs and permissions needed to use its hardware are present. Registering a Node supplies a route to capabilities, not missing software or drivers.",
          "Agent 要为目标选择正确工具和语法：Linux 上的 Bash 与 Windows 上的 PowerShell 是不同命令环境；GPU 服务器也只有在本地程序和权限齐全时，才能提供相应硬件能力。注册 Node 解决的是能力的接入，不会补齐缺少的软件或驱动。"
        )
      ]
    },
    {
      id: "composed-workflows",
      title: text("The opportunity is in combinations of devices", "想象空间来自设备之间的组合"),
      paragraphs: [
        text(
          "Once several devices are callable, an agent can place each step where its dependencies already exist. For example, inspect source on a Mac, invoke a build template on Linux, and read a check result from a Windows machine. This still needs an agent to coordinate the steps, compatible tools and suitable permissions; ADC supplies the device calls.",
          "多台设备可被调用后，Agent 可以把每一步放到依赖已经就绪的地方。例如在 Mac 上检查源码、在 Linux 上调用构建模板、再从 Windows 机器读取检查结果。这仍需要 Agent 串联步骤、工具适配和合适的权限；ADC 提供的是设备调用。"
        ),
        text(
          "A shared laboratory or engineering team can expose selected test commands and results from equipment-connected computers. A personal assistant can inspect an authorized home machine when asked for help. An Android Node can add a supported screenshot or app action to a workflow whose reasoning runs elsewhere. These are directions and illustrative tasks, not a claim of an automatically implemented workflow for every application.",
          "实验室或工程团队可以从连接仪器的电脑开放特定测试命令和结果；个人助手可以在收到求助时检查已授权的家庭电脑；Android Node 可以把支持的截图或应用操作加入一条在其他地方进行推理的流程。这些是方向和示例任务，不代表已经为每种应用自动实现了完整工作流。"
        ),
        text(
          "A locally registered MCP server can expose another service through a Node: a database, an internal system, or a hardware-control API. Credentials remain on that device. Supporting a television, printer, watch or instrument would require an actual connector or tool integration, an observable result and an access model. Calling it a future Node is a design direction, not a present compatibility claim.",
          "Node 上注册的本地 MCP 服务，还可以把数据库、内部系统或硬件控制 API 接入进来，凭据留在设备本地。将电视、打印机、手表或仪器接入，需要真实的连接器或工具适配、可观察的执行结果和访问模型。把它们视为未来 Node 是一种设计方向，不是当前的兼容性承诺。"
        )
      ]
    },
    {
      id: "start-with-a-device",
      title: text("Start with the task that your cloud agent cannot reach", "从云端 Agent 目前够不到的那件事开始"),
      paragraphs: [
        text(
          "Choose one task that truly needs a particular device, then identify its files, installed program or local service. Connect the device, create the access the agent needs and complete one call. Only then extend the workflow across additional Nodes. If a task lives entirely in an online service or the agent's existing sandbox, it may not need a physical device at all.",
          "先选择一件确实需要某台设备的任务，明确依赖的是哪些文件、已安装程序或本地服务。接入设备，为 Agent 配置所需授权，完成一次调用，再把流程扩展到其他 Node。如果任务完全发生在线上服务或 Agent 已有的沙箱里，可能根本不需要实体设备。"
        ),
        text(
          "The Quickstart walks through device pairing and a first read. The integration guide explains how a cloud agent reaches ADC through MCP, CLI, Skill or a host plugin. The device guide covers local tools and platform status. Together, these turn the architectural idea into a request that actually reaches your machine.",
          "「快速上手」讲设备配对与首次读取；「接入 Agent」讲云端 Agent 怎样通过 MCP、CLI、Skill 或宿主插件连接 ADC；「管理设备」讲本地工具和平台阶段。三者一起，才能把架构想法变成真正到达你机器的一次请求。"
        )
      ],
      links: [
        { href: "/docs/quickstart", label: text("Pair a device and make a first call", "配对设备并完成首次调用") },
        { href: "/docs/integrations#cloud-agent", label: text("Connect a cloud agent", "接入云端 Agent") },
        { href: "/docs/connector#platforms", label: text("Node platforms and status", "Node 平台与阶段") }
      ]
    }
  ]
};
