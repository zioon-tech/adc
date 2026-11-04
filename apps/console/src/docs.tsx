import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Code2,
  GitPullRequest,
  History,
  Laptop,
  Lightbulb,
  Milestone,
  Network,
  Plug,
  Rocket,
  Search,
  Server,
  ShieldCheck,
  SquareTerminal,
  Users,
  Wrench
} from "lucide-react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useI18n, type Message } from "./i18n.tsx";
import { PublicFooter, PublicHeader, repositoryUrl } from "./public-header.tsx";
import { HarnessPlugins } from "./harness-plugins.tsx";
import { CodeBlock, PageIntro, Section, docsOrigin, useDocCopy } from "./docs-code.tsx";
import { CollaborationDocs } from "./collaboration-docs.tsx";
import { isConsoleToolVisible } from "./file-transfer-visibility.ts";
import { NodePlatforms, PlatformTestingNotice } from "./platform-support.tsx";

type Text = [string, string];

export type DocsPageId =
  | "overview"
  | "quickstart"
  | "use-cases"
  | "integrations"
  | "connector"
  | "collaboration"
  | "self-hosting"
  | "troubleshooting"
  | "concepts"
  | "security"
  | "cli"
  | "tools"
  | "api"
  | "changelog"
  | "roadmap"
  | "contributing";

export type DocsGroup = "start" | "guides" | "concepts" | "reference" | "project";

export const docsGroups: Array<{ id: DocsGroup; title: Text }> = [
  { id: "start", title: ["Get started", "入门"] },
  { id: "guides", title: ["Guides", "使用指南"] },
  { id: "concepts", title: ["Concepts", "原理"] },
  { id: "reference", title: ["Reference", "参考"] },
  { id: "project", title: ["Project", "项目"] }
];

export const docsPages: Array<{
  id: DocsPageId;
  title: Text;
  summary: Text;
  icon: typeof BookOpen;
  group: DocsGroup;
}> = [
  {
    id: "overview",
    title: ["Introduction", "简介"],
    summary: ["What ADC is and where to start", "ADC 是什么，从哪里开始"],
    icon: BookOpen,
    group: "start"
  },
  {
    id: "quickstart",
    title: ["Quickstart", "快速上手"],
    summary: ["From sign-up to a first call in five steps", "五步完成从注册到首次调用"],
    icon: Rocket,
    group: "start"
  },
  {
    id: "use-cases",
    title: ["Examples", "示例"],
    summary: ["What to ask and what to grant", "可以怎么问、需要授权什么"],
    icon: Lightbulb,
    group: "start"
  },
  {
    id: "integrations",
    title: ["Connect your agent", "接入 Agent"],
    summary: ["Plugins, Skill, MCP and CLI", "插件、Skill、MCP 与 CLI"],
    icon: Plug,
    group: "guides"
  },
  {
    id: "connector",
    title: ["Manage devices", "管理设备"],
    summary: [
      "Folders, access modes, command templates and local MCP",
      "目录、访问模式、命令模板与本地 MCP"
    ],
    icon: Laptop,
    group: "guides"
  },
  {
    id: "collaboration",
    title: ["Teams and sharing", "团队与共享"],
    summary: ["Share a device with members or named users", "与团队成员或指定用户共享设备"],
    icon: Users,
    group: "guides"
  },
  {
    id: "self-hosting",
    title: ["Self-hosting", "自部署"],
    summary: ["Deploy, monitor, back up and upgrade", "部署、监控、备份与升级"],
    icon: Server,
    group: "guides"
  },
  {
    id: "troubleshooting",
    title: ["Troubleshooting", "故障排查"],
    summary: ["Offline devices, denials and unknown outcomes", "设备离线、调用被拒与未知结果"],
    icon: CircleHelp,
    group: "guides"
  },
  {
    id: "concepts",
    title: ["How ADC works", "ADC 如何工作"],
    summary: ["Components, permissions and the life of a call", "组件、权限与一次调用的全过程"],
    icon: Network,
    group: "concepts"
  },
  {
    id: "security",
    title: ["Security", "安全"],
    summary: ["Trust model, limits and verification status", "信任模型、限制与验证状态"],
    icon: ShieldCheck,
    group: "concepts"
  },
  {
    id: "cli",
    title: ["CLI", "命令行"],
    summary: ["adc and adc-node commands", "adc 与 adc-node 命令"],
    icon: SquareTerminal,
    group: "reference"
  },
  {
    id: "tools",
    title: ["Tools", "工具"],
    summary: ["Built-in tools and their risk level", "内置工具及其风险级别"],
    icon: Wrench,
    group: "reference"
  },
  {
    id: "api",
    title: ["HTTP API and errors", "HTTP API 与错误"],
    summary: ["Endpoints, invocation format and error codes", "接口、调用格式与错误码"],
    icon: Code2,
    group: "reference"
  },
  {
    id: "changelog",
    title: ["Changelog", "更新日志"],
    summary: ["Release history and upgrade notes", "版本记录与升级说明"],
    icon: History,
    group: "project"
  },
  {
    id: "roadmap",
    title: ["Roadmap", "路线图"],
    summary: ["What is available and what is planned", "已提供与计划中的能力"],
    icon: Milestone,
    group: "project"
  },
  {
    id: "contributing",
    title: ["Contributing", "参与贡献"],
    summary: ["Develop, test and submit changes", "开发、测试与提交变更"],
    icon: GitPullRequest,
    group: "project"
  }
];

// Pages merged in the 2026-11 restructure keep their old addresses working.
export const legacyDocsRedirects: Record<string, string> = {
  architecture: "/docs/concepts",
  operations: "/docs/self-hosting#operations"
};

export const documentedTools = [
  "device.list",
  "device.status",
  "device.battery.get",
  "device.info.get",
  "device.network.get",
  "device.storage.get",
  "device.vibrate",
  "device.navigation",
  "app.open",
  "display.status",
  "audio.status",
  "audio.volume.set",
  "flashlight.status",
  "flashlight.set",
  "location.get",
  "notification.show",
  "screen.capture",
  "ui.inspect",
  "ui.wait",
  "ui.action",
  "ui.gesture",
  "file.list",
  "file.read",
  "file.search",
  "file.write",
  "file.edit",
  "file.patch",
  "file.transfer",
  "shell.exec",
  "command.template.list",
  "command.template.run",
  "test.run",
  "task.status",
  "task.result",
  "task.wait",
  "task.cancel"
] as const;

export function docsPageId(pathname: string): DocsPageId | undefined {
  if (pathname === "/docs" || pathname === "/docs/") return "overview";
  const id = pathname.match(/^\/docs\/([^/]+)\/?$/)?.[1];
  return docsPages.some((page) => page.id === id) ? (id as DocsPageId) : undefined;
}

function docsPath(id: DocsPageId): string {
  return id === "overview" ? "/docs" : `/docs/${id}`;
}

function Success({ children }: { children: ReactNode }) {
  return (
    <p className="docs-success">
      <Check size={14} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function NextLinks({ links }: { links: Array<[DocsPageId, Text]> }) {
  const copy = useDocCopy();
  return (
    <nav className="docs-inline-links" aria-label={copy("Next steps", "后续步骤")}>
      {links.map(([id, label]) => (
        <Link key={id} to={docsPath(id)}>
          {copy(...label)}
        </Link>
      ))}
    </nav>
  );
}

function Introduction() {
  const copy = useDocCopy();
  const flow: Array<{ title: Text; text: Text }> = [
    {
      title: ["Your agent", "你的 Agent"],
      text: [
        "Calls the model, plans the steps, selects a device and supplies tool arguments. This is where the intelligence lives.",
        "调用模型、规划步骤、选择设备并提供工具参数。理解需求和决策发生在这里。"
      ]
    },
    {
      title: ["ADC service", "ADC 服务"],
      text: [
        "Discovers devices and tools, checks access and any required approval, routes the call and tracks its result. It does not call a model.",
        "发现设备与工具，检查授权和所需审批，路由调用并跟踪结果。这里不调用大模型。"
      ]
    },
    {
      title: ["Your device", "你的设备"],
      text: [
        "The connector validates the request, runs the local tool and returns its result. A target device does not need another conversational agent.",
        "连接器校验请求、运行本地工具并返回结果。目标设备不需要再安装一个对话 Agent。"
      ]
    }
  ];
  const routes: Array<[DocsPageId, Text]> = [
    ["quickstart", ["Connect one device and make your first call", "连接一台设备并完成首次调用"]],
    [
      "integrations",
      [
        "Connect Claude Code, Codex, Cursor or another agent",
        "接入 Claude Code、Codex、Cursor 或其他 Agent"
      ]
    ],
    [
      "connector",
      ["Add folders, command templates or local MCP servers", "添加目录、命令模板或本地 MCP 服务"]
    ],
    ["collaboration", ["Share a device with your team", "与团队共享设备"]],
    ["self-hosting", ["Run ADC on your own server", "在自己的服务器上运行 ADC"]],
    ["troubleshooting", ["Fix a device or call that is not working", "排查设备或调用问题"]]
  ];
  const terms: Array<[Text, Text]> = [
    [
      ["Device", "设备"],
      [
        "A computer or phone running the ADC connector. It connects out to ADC and never needs an open port.",
        "运行 ADC 连接器的电脑或手机。它主动连接 ADC，不需要开放任何端口。"
      ]
    ],
    [
      ["Agent access", "Agent 授权"],
      [
        "A revocable permission for one agent: which devices, folders and tools it may use.",
        "给某个 Agent 的可撤销权限：可以使用哪些设备、目录和工具。"
      ]
    ],
    [
      ["Approval", "审批"],
      [
        "An optional rule that makes writes, commands or every call wait for you.",
        "可选规则：写入、运行命令或每次调用前都要等你批准。"
      ]
    ],
    [
      ["Activity", "活动记录"],
      [
        "The record of every call: which agent, which device, the decision and the device's receipt.",
        "每次调用的记录：哪个 Agent、哪台设备、策略决定与设备回执。"
      ]
    ]
  ];
  return (
    <>
      <PageIntro
        eyebrow={copy("Documentation", "文档")}
        title="Agent Device Cloud"
        description={copy(
          "ADC is device connectivity and tool-routing infrastructure for agents. It lets an agent running in one place discover and use authorized tools on several computers, servers or phones. The agent plans the task; ADC routes the calls; each selected device executes.",
          "ADC 是为 Agent 设计的设备连接与工具路由基础设施。它让运行在一个地方的 Agent，发现并调用多台电脑、服务器或手机上已授权的工具。Agent 负责规划，ADC 负责路由，所选设备负责执行。"
        )}
      />
      <Section
        id="why"
        title={copy("Why separate the agent from its devices?", "为什么要把 Agent 和设备分开？")}
      >
        <p>
          {copy(
            "Your agent may run in a cloud service, an IDE or another computer, while the work requires a repository on your Mac, dependencies on a Linux server or an app on your phone. Those environments already exist. You should be able to use them without first moving every file and dependency to the agent's own machine.",
            "你的 Agent 可能在云端服务、IDE 或另一台电脑上运行，而任务需要用到 Mac 上的仓库、Linux 服务器上的依赖，或者手机里的应用。这些环境本来就存在，不应该每次都先把文件和依赖搬到 Agent 所在的机器。"
          )}
        </p>
        <p>
          {copy(
            "ADC turns those devices into tool targets. One agent can use several authorized devices, and several agents can reuse one device with separate grants. The target needs a connector and the local programs the task requires, not another model account or agent loop.",
            "ADC 把这些设备开放为工具目标。一个 Agent 可以使用多台已授权设备，不同 Agent 也可以通过各自授权复用同一台设备。目标设备需要连接器和任务所需的本地程序，不需要额外的模型账号或 Agent 循环。"
          )}
        </p>
        <p>
          <Link className="docs-text-link" to="/articles/agents-and-execution-devices">
            {copy("Read the design motivation and its limits", "阅读设计动机与适用边界")}
          </Link>
        </p>
      </Section>
      <Section
        id="cloud-agent"
        title={copy("When a personal agent runs in the cloud", "当 Personal agent 在云端运行")}
      >
        <p>
          {copy(
            "A personal agent may work on your behalf from a cloud runtime while you talk to it from a phone. Its cloud tools can reach online services, but your computer's files, installed programs and phone apps require a separate device execution path.",
            "Personal agent 可以在云端 Runtime 中为你工作，你则在手机上与它对话。它的云端工具能访问线上服务，但你的电脑文件、已安装程序和手机应用，需要另一条真正通向设备的执行通道。"
          )}
        </p>
        <p>
          {copy(
            "When a task must happen on the original device, that access layer is necessary. ADC supplies it as a reusable service: discover the device, expose its actual tools, authorize the caller, execute there and return results. An agent vendor can also provide this layer internally.",
            "如果任务必须发生在原设备上，设备接入层就是必需的。ADC 把它做成可复用服务：发现设备、开放真实工具、授权调用方、在设备上执行并返回结果。Agent 厂商也可以内置这层能力。"
          )}
        </p>
        <p>
          <Link className="docs-text-link" to="/articles/cloud-agent-local-devices">
            {copy(
              "Read why cloud agents need a device access layer",
              "阅读云端 Agent 为什么需要设备接入层"
            )}
          </Link>
        </p>
      </Section>
      <Section
        id="how-it-works"
        title={copy("What happens when an agent calls a tool", "Agent 调用工具时发生了什么")}
      >
        <ol className="docs-flow">
          {flow.map((item, index) => (
            <li key={item.title[0]}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{copy(...item.title)}</strong>
              <p>{copy(...item.text)}</p>
            </li>
          ))}
        </ol>
      </Section>
      <Section
        id="example"
        title={copy(
          "Example: an agent builds on your Linux machine",
          "例子：让 Agent 在 Linux 开发机上构建"
        )}
      >
        <p>
          {copy(
            "After setup, the agent discovers a device called Build Linux and its authorized /work/project folder. It sees that the device runs Linux and offers shell.exec. The agent writes a Bash command, selects that device and submits a call such as this:",
            "完成接入后，Agent 发现一台名为 Build Linux 的设备和其已授权目录 /work/project，知道它运行 Linux 并提供 shell.exec。Agent 自己写出 Bash 命令，选择这台设备，提交类似下面的调用："
          )}
        </p>
        <CodeBlock label={copy("Illustrative tool call", "工具调用示例")}>
          {JSON.stringify(
            {
              target: { nodeId: "node_build_linux" },
              tool: "shell.exec",
              args: { cwd: "/work/project", command: "npm run build", timeoutMs: 120000 }
            },
            null,
            2
          )}
        </CodeBlock>
        <p>
          {copy(
            "This is the relevant part of the request; clients also attach identity, authorization and idempotency fields. ADC checks the call, waits for approval if configured, and dispatches it. The connector runs npm on the Linux machine, where npm and the dependencies must already be installed. It returns output, exit status and a receipt. Your agent reads those results and decides whether to fix the code or continue.",
            "这里展示的是请求的核心部分；客户端还会附加身份、授权和幂等字段。ADC 校验调用、按配置等待审批，再派发给设备。连接器在 Linux 开发机上运行 npm，这台机器需要已经安装 npm 与项目依赖。输出、退出状态和回执返回后，由你的 Agent 判断要不要改代码或继续下一步。"
          )}
        </p>
        <p>
          {copy(
            "ADC does not translate Bash into PowerShell, generate a command with another model, or run the build on its platform server. Naming a working directory also does not sandbox a shell process: execution uses the connector's configured operating-system permissions.",
            "ADC 不会把 Bash 翻译成 PowerShell，不会另调模型生成命令，也不会在平台服务器上完成构建。指定工作目录也不会把 shell 进程变成沙箱：执行使用的是连接器所配置的操作系统权限。"
          )}
        </p>
      </Section>
      <Section
        id="interfaces"
        title={copy("Choose how to call the service", "选择怎样调用这个服务")}
      >
        <p>
          {copy(
            "MCP exposes callable tools and schemas. CLI offers commands to agents, scripts and people. The Skill teaches an agent how to use those commands. Plugins add host-specific setup and context. They all reach the same ADC service and device authorization; they are not separate products or execution locations.",
            "MCP 暴露可调用工具与输入格式；CLI 提供给 Agent、脚本和人使用的命令；Skill 告诉 Agent 怎样使用这些命令；插件提供宿主内的引导和上下文。它们接入的是同一个 ADC 服务和设备授权，不是几套独立产品或执行地点。"
          )}
        </p>
        <p>
          {copy(
            "You can use ADC with your existing agent without adopting Zioon's Runtime or memory service. A developer can also use the HTTP API or SDK to put device capability into an application.",
            "你可以继续使用现有 Agent，不必改用 Zioon 的 Runtime 或记忆服务。开发者也可以通过 HTTP API 或 SDK，把设备能力接入自己的应用。"
          )}
        </p>
      </Section>
      <Section id="scope" title={copy("When it helps, and where it stops", "适合什么，边界在哪里")}>
        <p>
          {copy(
            "ADC is useful when execution environments are spread across devices or shared with other people: development and training machines, private services, home devices, and team-owned tools. It does not supply the reasoning or business logic of the workflow. A knowledge base still needs its own retrieval service; the agent still coordinates the steps.",
            "执行环境分散在多台设备上，或者需要共享给他人时，ADC 更容易体现价值，例如开发与训练机器、内部服务、家庭设备和团队工具。它不提供工作流的推理或业务逻辑：知识库仍需要自己的检索服务，步骤仍由 Agent 串联。"
          )}
        </p>
        <p>
          {copy(
            "If the agent already has all it needs on one local computer, you may not need another service. SSH and remote desktop can remain appropriate for their own workflows. Today, ADC supports desktop connectors, Android and registered local MCP providers; other devices need an explicit integration before they can become usable targets.",
            "如果 Agent 在一台本地电脑上已经拥有所需的一切，你可能不需要再接一个服务。SSH 和远程桌面也可以继续服务于适合它们的工作流。目前 ADC 支持桌面连接器、Android 和已注册的本地 MCP Provider；其他设备需要具体适配，才能成为可用目标。"
          )}
        </p>
      </Section>
      <Section
        id="platforms"
        title={copy("Different systems, different Nodes", "不同系统，都可以成为 Node")}
      >
        <NodePlatforms />
        <p>
          {copy(
            "The opportunity is to combine their capabilities: a repository on a Mac, a build or inference environment on Linux, a local Windows tool, or a supported Android app action. A Node supplies the execution environment and interfaces; the agent still coordinates the workflow.",
            "有价值的是组合它们的能力：Mac 上的仓库、Linux 上的构建或推理环境、Windows 上的本地工具，或者 Android 支持的应用操作。Node 提供执行环境和接口，工作流仍由 Agent 串联。"
          )}
        </p>
      </Section>
      <Section id="start" title={copy("Start here", "从这里开始")}>
        <div className="docs-routes">
          {routes.map(([id, label]) => (
            <Link key={id} to={docsPath(id)}>
              <span>{copy(...label)}</span>
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          ))}
        </div>
      </Section>
      <Section id="terms" title={copy("Four terms to know", "需要了解的四个概念")}>
        <dl className="docs-definitions docs-terms">
          {terms.map(([term, definition]) => (
            <div key={term[0]}>
              <dt>{copy(...term)}</dt>
              <dd>{copy(...definition)}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}

function Quickstart() {
  const copy = useDocCopy();
  const origin = docsOrigin();
  return (
    <>
      <PageIntro
        eyebrow={copy("Quickstart", "快速上手")}
        title={copy("Your first call in five steps", "五步完成第一次调用")}
        description={copy(
          "Pair one device, share one folder read-only and let an agent list it. Add write access or commands later, once this works.",
          "配对一台设备，只读共享一个目录，让 Agent 列出其中的文件。跑通后再按需增加写入或命令权限。"
        )}
      />
      <Section id="requirements" title={copy("Before you begin", "开始之前")}>
        <ul className="docs-checklist">
          <li>
            {copy(
              "A computer running macOS 13.5+ or glibc 2.28+ Linux (arm64/x64), or Windows 10/11 x64. The installer brings its own runtime.",
              "一台 macOS 13.5+ 或 glibc 2.28+ Linux（arm64/x64）电脑，或 Windows 10/11 x64 电脑。安装器自带运行时。"
            )}
          </li>
          <li>
            {copy(
              "Permission to install user-level background services on it. No admin rights or open ports are needed.",
              "可以在这台电脑上安装用户级后台服务。不需要管理员权限，也不需要开放端口。"
            )}
          </li>
          <li>
            {copy(
              "An account on the official service or your own deployment.",
              "官方服务或你自己部署的 ADC 上的一个账号。"
            )}
          </li>
        </ul>
        <PlatformTestingNotice />
      </Section>
      <ol className="docs-steps">
        <li>
          <span>01</span>
          <div>
            <h2>{copy("Create an account", "创建账号")}</h2>
            <p>
              {copy(
                "Register with email or GitHub. The console opens on an overview with your setup progress.",
                "使用邮箱或 GitHub 注册。登录后控制台会显示概览和接入进度。"
              )}
            </p>
            <Link className="docs-text-link" to="/register">
              {copy("Create an account", "创建账号")}
            </Link>
          </div>
        </li>
        <li>
          <span>02</span>
          <div>
            <h2>{copy("Pair a device", "配对设备")}</h2>
            <p>
              {copy(
                "Open Devices → Pair device, choose the platform and run the generated command on that computer. The pairing code is single-use and short-lived. On Windows, choose Windows PowerShell to get a PowerShell command.",
                "打开「设备 → 配对设备」，选择平台，在那台电脑上运行生成的命令。配对码一次性且短时有效。Windows 请选择 Windows PowerShell，获取对应的 PowerShell 命令。"
              )}
            </p>
            <CodeBlock label="macOS / Linux">
              {`curl -fsSL ${origin}/install.sh | sh -s -- \\
  --url ${origin} --code 'PAIRING_CODE'`}
            </CodeBlock>
            <Success>
              {copy(
                "The device shows Online in Devices. adc-node status reports it as connected.",
                "设备在「设备」页显示在线，adc-node status 显示已连接。"
              )}
            </Success>
          </div>
        </li>
        <li>
          <span>03</span>
          <div>
            <h2>{copy("Share a folder", "开放一个目录")}</h2>
            <p>
              {copy(
                "The installer asks which folders to expose. To add one later, run this on the device. Agents can never see folders you have not exposed.",
                "安装器会询问要开放哪些目录。之后也可以在设备上运行下面的命令添加。未开放的目录，Agent 永远看不到。"
              )}
            </p>
            <CodeBlock label={copy("On the device", "在设备上")}>
              {`adc-node roots add ~/work --label Work --read-only
adc-node roots list`}
            </CodeBlock>
          </div>
        </li>
        <li>
          <span>04</span>
          <div>
            <h2>{copy("Authorize your agent", "授权 Agent")}</h2>
            <p>
              {copy(
                "Open Agent access → Authorize agent. Name it my-agent, select the device and folder, choose Read only and No approval for now.",
                "打开「Agent 授权 → 授权 Agent」，命名为 my-agent，选择设备和目录，权限选「只读」，审批暂时选「无需审批」。"
              )}
            </p>
            <Success>
              {copy(
                "my-agent lists exactly one device, one folder and read tools only.",
                "my-agent 只包含一台设备、一个目录，且只有读取类工具。"
              )}
            </Success>
          </div>
        </li>
        <li>
          <span>05</span>
          <div>
            <h2>{copy("Make the first call", "发起第一次调用")}</h2>
            <p>
              {copy(
                "With a plugin or the Skill installed, just tell your agent:",
                "如果已经安装插件或 Skill，直接对 Agent 说："
              )}
            </p>
            <CodeBlock label={copy("Say to your agent", "对 Agent 说")}>
              {copy(
                "Help me start using ADC, then list the files in my Work folder.",
                "帮我开始使用 ADC，然后列出 Work 目录里的文件。"
              )}
            </CodeBlock>
            <p>
              {copy(
                "Or use the CLI, which the installer already put on the device:",
                "也可以直接使用 CLI，安装器已经在设备上装好了："
              )}
            </p>
            <CodeBlock label={copy("Terminal", "终端")}>
              {`adc login --url ${origin}
adc connect my-agent
adc invoke file.list --args '{"path":"/Users/me/work"}' --wait --json`}
            </CodeBlock>
            <Success>
              {copy(
                'The result has "status": "succeeded", and the call appears in Activity with its receipt.',
                '结果中 "status" 为 "succeeded"，并且「活动记录」中出现这次调用及其回执。'
              )}
            </Success>
          </div>
        </li>
      </ol>
      <Section
        id="android"
        title={copy("Using Android Node (in testing)", "使用 Android Node（测试阶段）")}
      >
        <p>
          {copy(
            "Download the Android APK, sign in with email or approve browser / GitHub authorization in a Custom Tab, then open This phone to connect it to your account and start the Node. Registration, recovery requests, profile/password settings and help are native screens. Devices lists your computers and phones and supports renaming, access settings and removing connections. A pairing code and HTTPS service address also work for self-hosting.",
            "下载 Android APK，通过邮箱登录，或在应用内授权窗口完成浏览器 / GitHub 授权；在「此手机」接入账号并启动 Node。注册、找回密码请求、账号资料和密码设置、使用指南均在 App 内完成。「设备」展示账号下的电脑与手机，支持重命名、访问策略和移除连接。自托管服务也可以使用 HTTPS 服务地址和配对码。"
          )}
        </p>
        <p>
          <a
            className="docs-text-link"
            href={`${docsOrigin()}/downloads/android/preview.apk`}
            download
          >
            {copy("Download Android APK (in testing)", "下载 Android APK（测试阶段）")}
          </a>
        </p>
        <p>
          {copy(
            "Device status, location, notifications, volume, vibration, app launch, flashlight, screen sharing, interface reading and interface actions have separate local controls. Android permissions and account / agent policies still apply. Screen sharing needs fresh system consent; location is available only while the app is visible. Signing out leaves the phone Node connected; stop it in This phone. Updates are checked from Account and verified before Android asks you to install. This test channel retains its development signing certificate for in-place upgrades.",
            "设备状态、位置、通知、音量、振动、打开应用、手电筒、屏幕共享、界面读取与界面操作分别由本地开关控制，系统权限和账号 / Agent 策略仍然生效。屏幕共享每次需要系统确认，位置仅限 App 前台。退出账号不会停止手机 Node，请在「此手机」停止；可在「我的」检查更新，校验通过后由系统确认安装。测试渠道沿用开发签名证书，以支持保留身份的覆盖升级。"
          )}
        </p>
      </Section>
      <NextLinks
        links={[
          ["use-cases", ["See what else agents can do", "看看 Agent 还能做什么"]],
          ["integrations", ["Connect another agent", "接入其他 Agent"]],
          ["connector", ["Add write access or commands", "增加写入或命令权限"]]
        ]}
      />
    </>
  );
}

function Examples() {
  const copy = useDocCopy();
  const examples: Array<{ title: Text; prompt: Text; grant: Text; setup?: string }> = [
    {
      title: [
        "A cloud personal agent uses your home computer",
        "云端 Personal agent 使用你的家庭电脑"
      ],
      prompt: [
        "Check the logs on my home computer and explain why the app stopped.",
        "检查家里电脑上的日志，解释应用为什么停止运行。"
      ],
      grant: [
        "Read access to the log folder on that Node, through an ADC integration supported by the agent. This is a file-inspection workflow; command execution needs separate authorization.",
        "通过 Agent 支持的 ADC 接入方式，授予该 Node 日志目录的读取权限。这是文件检查流程；运行命令需要另行授权。"
      ]
    },
    {
      title: ["Fix failing tests in a repository", "修复仓库中失败的测试"],
      prompt: [
        "Run the tests in ~/work/api and fix what fails.",
        "跑一下 ~/work/api 的测试，把失败的修好。"
      ],
      grant: [
        "Read & write on the repository folder, then also tick test.run. Choose Before changes or execution approval while you evaluate the agent.",
        "对仓库目录选择「读写」，再额外勾选 test.run。评估 Agent 期间，审批建议选「修改或执行前审批」。"
      ],
      setup: `adc-node roots list
adc-node templates add test --root ROOT_ID --command "npm test"`
    },
    {
      title: ["Search logs on a home server", "检索家里服务器上的日志"],
      prompt: [
        "Find yesterday's 500 errors in the app logs and summarize the causes.",
        "找出应用日志里昨天的 500 错误，总结原因。"
      ],
      grant: ["Read only on the log folder.", "对日志目录授予「只读」。"],
      setup: `adc-node roots add /var/log/myapp --label Logs --read-only`
    },
    {
      title: ["Use an MCP server that lives on your laptop", "使用笔记本上的 MCP 服务"],
      prompt: [
        "List my open pull requests with GitHub on my laptop.",
        "用笔记本上的 GitHub 工具列出我未合并的 PR。"
      ],
      grant: [
        "Select the GitHub provider tools in Agent access. The GitHub token stays in the device's local file.",
        "在 Agent 授权中勾选 GitHub 提供的工具。GitHub 令牌只保存在设备本地文件中。"
      ],
      setup: `adc-node mcp add github --name GitHub --stdio npx \\
  --args '["-y","@modelcontextprotocol/server-github"]' \\
  --env-file ~/.config/adc/github-mcp-env.json`
    },
    {
      title: ["Operate an Android phone (in testing)", "操作 Android 手机（测试阶段）"],
      prompt: [
        "Take a screenshot of my phone, then open Settings.",
        "截一张手机屏幕，然后打开设置。"
      ],
      grant: [
        "screen.capture, ui.inspect, app.open and ui.action. Enable Accessibility and screen capture in ADC Mobile Node first.",
        "screen.capture、ui.inspect、app.open 和 ui.action。需要先在 ADC Mobile Node 中开启无障碍和屏幕截图权限。"
      ]
    },
    {
      title: ["Work across several machines", "在多台机器之间协作"],
      prompt: [
        "Compare the nginx config on my Mac with the one on the build server.",
        "对比 Mac 上和构建服务器上的 nginx 配置。"
      ],
      grant: [
        "Read only on both devices. The agent sees each device as a target and names it in every call.",
        "对两台设备授予「只读」。Agent 会看到两个目标设备，并在每次调用时指定设备。"
      ]
    },
    {
      title: ["Let a teammate's agent use your device", "让同事的 Agent 使用你的设备"],
      prompt: [
        "Read the design notes in the shared Research folder.",
        "读一下共享的 Research 目录里的设计笔记。"
      ],
      grant: [
        "Share the device with your team or a named account, then each person authorizes their own agent.",
        "把设备共享给团队或指定账号，再由每个人为自己的 Agent 授权。"
      ]
    }
  ];
  return (
    <>
      <PageIntro
        eyebrow={copy("Examples", "示例")}
        title={copy("What you can ask, and what to grant", "可以怎么问，需要授权什么")}
        description={copy(
          "Each example lists a request you can give your agent and the smallest access that makes it work.",
          "每个示例都给出一句可以直接对 Agent 说的话，以及让它跑通所需的最小授权。"
        )}
      />
      <PlatformTestingNotice />
      <p>
        <Link className="docs-text-link" to="/articles/cloud-agent-local-devices">
          {copy("How cloud-agent tasks reach real devices", "云端 Agent 的任务怎样到达真实设备")}
        </Link>
      </p>
      <div className="docs-examples">
        {examples.map((example, index) => (
          <section key={example.title[0]} id={`example-${index + 1}`}>
            <h2>{copy(...example.title)}</h2>
            <blockquote>“{copy(...example.prompt)}”</blockquote>
            <p>
              <strong>{copy("Grant", "授权")}</strong> {copy(...example.grant)}
            </p>
            {example.setup ? (
              <CodeBlock label={copy("On the device", "在设备上")}>{example.setup}</CodeBlock>
            ) : null}
          </section>
        ))}
      </div>
      <p className="docs-callout">
        {copy(
          "ADC is not remote desktop, a hosted shell or public compute. Agents act only through tools you authorize, on devices you own or were explicitly shared.",
          "ADC 不是远程桌面、托管 Shell 或公共算力。Agent 只能通过你授权的工具，在你自己的或明确共享给你的设备上操作。"
        )}
      </p>
      <NextLinks
        links={[
          ["collaboration", ["Share a device", "共享设备"]],
          ["tools", ["Browse every tool", "查看全部工具"]]
        ]}
      />
    </>
  );
}

function Integrations() {
  const copy = useDocCopy();
  const origin = docsOrigin();
  const options: Array<[string, Text]> = [
    [
      copy("Plugin", "插件"),
      [
        "Claude Code, Codex, Cursor, Gemini CLI and other listed agents. Guided setup inside the agent.",
        "Claude Code、Codex、Cursor、Gemini CLI 等已列出的 Agent，在 Agent 内引导完成接入。"
      ]
    ],
    [
      "Skill",
      [
        "Any agent that supports Skills. One install command.",
        "任何支持 Skill 的 Agent，一条命令安装。"
      ]
    ],
    [
      "MCP",
      ["Any MCP client with OAuth. Nothing to install.", "任何支持 OAuth 的 MCP 客户端，无需安装。"]
    ],
    ["CLI", ["Terminals, scripts and CI.", "终端、脚本与 CI。"]]
  ];
  return (
    <>
      <PageIntro
        eyebrow={copy("Connect your agent", "接入 Agent")}
        title={copy("Connect ADC to your agent", "把 ADC 接入你的 Agent")}
        description={copy(
          "Every method uses the same Agent access, approvals and Activity. Pick the one your agent supports.",
          "所有接入方式共用同一套 Agent 授权、审批与活动记录，按你的 Agent 支持的方式选择即可。"
        )}
      />
      <Section
        id="cloud-agent"
        title={copy("Connecting a cloud or personal agent", "接入云端 Agent 或 Personal agent")}
      >
        <p>
          {copy(
            "The connection belongs in the environment where your agent runs. An OAuth MCP client can call ADC over HTTPS; an agent with shell access can use the CLI and Skill in its runtime; supported hosts can use their plugin. Your target device separately runs the Node connector.",
            "接入要发生在 Agent 所在的环境。支持 OAuth 的 MCP 客户端可以通过 HTTPS 调用 ADC；具备 shell 能力的 Agent 可以在自己的 Runtime 中使用 CLI 与 Skill；支持的宿主可以使用插件。目标设备则单独运行 Node 连接器。"
          )}
        </p>
        <p>
          {copy(
            "A cloud agent that allows no external tools cannot use ADC merely because you paired a device. Pick a supported integration and grant it access. This connects the agent's decisions to the device's tools without moving the model loop onto every Node.",
            "如果云端 Agent 不开放外部工具接入，仅仅配对设备并不能让它使用 ADC。需要选择它支持的接入方式，并授予权限；这样才能把 Agent 的决策连接到设备工具，而不把模型循环复制到每个 Node 上。"
          )}
        </p>
      </Section>
      <div className="table-wrap docs-table">
        <table>
          <thead>
            <tr>
              <th>{copy("Method", "方式")}</th>
              <th>{copy("Best for", "适用场景")}</th>
            </tr>
          </thead>
          <tbody>
            {options.map(([method, text]) => (
              <tr key={method}>
                <td>
                  <strong>{method}</strong>
                </td>
                <td>{copy(...text)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav className="integration-nav" aria-label={copy("Connection methods", "接入方式")}>
        <a href="#plugins">{copy("Plugins", "插件")}</a>
        <a href="#skill">Skill</a>
        <a href="#oauth-mcp">MCP</a>
        <a href="#cli">CLI</a>
      </nav>
      <HarnessPlugins origin={origin} />
      <Section id="skill" title={copy("Official Skill", "官方 Skill")}>
        <p>
          {copy(
            "Install from this site with the open-source skills installer and pick your agent when prompted. Requires Node.js 22.20+ and npm. Add --global to use it in every project.",
            "通过开源 skills 安装器直接从本站安装，按提示选择你的 Agent。需要 Node.js 22.20+ 与 npm；加上 --global 可在所有项目中使用。"
          )}
        </p>
        <CodeBlock label={copy("Install Skill", "安装 Skill")}>
          {`npx skills@latest add ${origin} --skill agent-device-cloud`}
        </CodeBlock>
        <p>
          {copy(
            "Then ask your agent to get started. It checks the CLI, guides sign-in, reuses or pairs a device, creates the access you choose and verifies a first call. You confirm sign-in in your browser.",
            "然后让 Agent 帮你开始使用。它会检查 CLI、引导登录、复用或配对设备、创建你选择的授权，并验证首次调用。浏览器登录由你本人确认。"
          )}
        </p>
        <CodeBlock label={copy("First message", "首次使用提示")}>
          {copy(
            "Help me get started with ADC. Check my setup and guide me through connecting my device and authorizing this Agent.",
            "帮我开始使用 ADC，检查当前配置，引导我连接设备并为这个 Agent 配置授权。"
          )}
        </CodeBlock>
        <p>
          {copy(
            "For hosts with a manual Skill importer, extract the ZIP into an agent-device-cloud folder and import it, including references/.",
            "如果宿主只支持手动导入 Skill，请把 ZIP 解压到 agent-device-cloud 文件夹后导入，保留 references/ 目录。"
          )}{" "}
          <a
            className="docs-text-link"
            href={`${origin}/downloads/skills/agent-device-cloud.zip`}
            download
          >
            {copy("Download Skill ZIP", "下载 Skill ZIP")}
          </a>
        </p>
      </Section>
      <Section id="oauth-mcp" title="MCP">
        <p>
          {copy(
            "Add this URL to an MCP client that supports OAuth. Sign in and choose which Agent access the client uses. Each tool appears once and lists the devices it can run on.",
            "把这个地址添加到支持 OAuth 的 MCP 客户端，登录后选择客户端使用哪份 Agent 授权。每个工具只出现一次，并列出可执行的设备。"
          )}
        </p>
        <CodeBlock label="MCP URL">{`${origin}/mcp`}</CodeBlock>
        <p>
          {copy(
            "Clients without OAuth can send an access key created under Agent access → Advanced access keys:",
            "不支持 OAuth 的客户端，可以使用在「Agent 授权 → 高级访问密钥」中创建的访问密钥："
          )}
        </p>
        <CodeBlock label="mcp.json">
          {JSON.stringify(
            {
              mcpServers: {
                adc: { url: `${origin}/mcp`, headers: { Authorization: "Bearer <ACCESS_KEY>" } }
              }
            },
            null,
            2
          )}
        </CodeBlock>
      </Section>
      <Section id="cli" title="CLI">
        <p>
          {copy(
            "Sign in once and confirm the code in your browser. adc connect stores a credential scoped to one Agent access; you never copy a token.",
            "登录一次并在浏览器中确认验证码。adc connect 会保存只属于某份 Agent 授权的凭据，无需手动复制令牌。"
          )}
        </p>
        <CodeBlock label={copy("Terminal", "终端")}>
          {`adc login --url ${origin}
adc connect my-agent
adc tool list --json
adc invoke file.read --args '{"path":"/Users/me/work/README.md"}' --wait --json`}
        </CodeBlock>
        <p>
          {copy("All commands are in the ", "全部命令见")}
          <Link className="docs-text-link" to="/docs/cli">
            {copy("CLI reference", "命令行参考")}
          </Link>
          {copy(".", "。")}
        </p>
      </Section>
    </>
  );
}

export const windowsInstallExample = [
  "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12",
  "$p=Join-Path $env:TEMP 'adc-install.ps1'",
  "Invoke-WebRequest -UseBasicParsing -Uri 'https://devices.example.com/install.ps1' -OutFile $p",
  '& "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $p `',
  "  -Url 'https://devices.example.com' -Code 'PAIRING_CODE'"
].join("\n");

function ManageDevices() {
  const copy = useDocCopy();
  const modes: Array<[string, Text]> = [
    [
      "none",
      ["Nothing is exposed. Use this to pause a device.", "不开放任何目录，可用于暂停设备。"]
    ],
    [
      "selected",
      [
        "Only folders you add with adc-node roots add.",
        "只开放通过 adc-node roots add 添加的目录。"
      ]
    ],
    ["home", ["The connector user's home folder.", "连接器所属用户的主目录。"]],
    [
      "full",
      [
        "The whole filesystem with your OS user's permissions. On Windows, the system drive. Not a sandbox.",
        "以当前系统用户权限开放整个文件系统，Windows 上为系统盘。这不是沙箱。"
      ]
    ]
  ];
  return (
    <>
      <PageIntro
        eyebrow={copy("Manage devices", "管理设备")}
        title={copy("Install, configure and update devices", "安装、配置与更新设备")}
        description={copy(
          "Everything here runs on the device with adc-node. Changes reload automatically; there is no need to pair again.",
          "以下命令都在设备上通过 adc-node 运行。修改会自动生效，无需重新配对。"
        )}
      />
      <Section
        id="platforms"
        title={copy("Node platforms and release stage", "Node 平台与当前阶段")}
      >
        <NodePlatforms />
      </Section>
      <Section id="install" title={copy("Install and pair", "安装与配对")}>
        <p>
          {copy(
            "Copy the command from Devices → Pair device. The installer verifies the release checksum, creates a device key locally and starts a user service (launchd, systemd --user or a Windows Scheduled Task). The private key never leaves the device.",
            "从「设备 → 配对设备」复制命令。安装器会校验发布包摘要、在本地生成设备密钥，并启动用户级服务（launchd、systemd --user 或 Windows 计划任务）。私钥不会离开设备。"
          )}
        </p>
        <CodeBlock label="macOS / Linux">
          {`curl -fsSL https://devices.example.com/install.sh | sh -s -- \\
  --url https://devices.example.com --code 'PAIRING_CODE'`}
        </CodeBlock>
        <CodeBlock label="Windows PowerShell">{windowsInstallExample}</CodeBlock>
      </Section>
      <Section id="folders" title={copy("Choose what agents can reach", "选择 Agent 能访问的范围")}>
        <CodeBlock label="adc-node">
          {`adc-node access selected
adc-node roots add ~/work --label Work
adc-node roots add ~/datasets --label Data --read-only
adc-node roots list
adc-node roots remove ROOT_ID`}
        </CodeBlock>
        <ul className="docs-list">
          {modes.map(([mode, text]) => (
            <li key={mode}>
              <code>{mode}</code>
              <span>{copy(...text)}</span>
            </li>
          ))}
        </ul>
        <p>
          {copy(
            "The console can narrow this further per device (read-only folders, execution off), and each Agent access narrows it again. Removing a folder cancels running work that used it.",
            "控制台还可以按设备进一步收窄（只读目录、关闭执行），每份 Agent 授权会再次收窄。移除目录会取消正在使用它的任务。"
          )}
        </p>
      </Section>
      <Section id="templates" title={copy("Allow specific commands", "只允许特定命令")}>
        <p>
          {copy(
            "A command template lets an agent run one fixed command without general shell access. test.run defaults to the template named test; it does not discover your test command automatically. Get ROOT_ID from adc-node roots list.",
            "命令模板让 Agent 只能运行一条固定命令，而不必开放通用 Shell。test.run 默认运行名为 test 的模板，不会自动发现项目的测试命令。ROOT_ID 可通过 adc-node roots list 查看。"
          )}
        </p>
        <CodeBlock label="adc-node">
          {`adc-node templates add test --root ROOT_ID --command "npm test"
adc-node templates add lint --root ROOT_ID --command "npm run lint" --timeout 120000
adc-node templates list`}
        </CodeBlock>
      </Section>
      <Section id="local-mcp-providers" title={copy("Add local MCP servers", "添加本地 MCP 服务")}>
        <p>
          {copy(
            "Expose a stdio or Streamable HTTP MCP server running on the device. Its credentials stay in local files. Its tools appear only after you select them in Agent access.",
            "把设备上运行的 stdio 或 Streamable HTTP MCP 服务开放给 Agent。凭据只保存在本地文件中，只有在 Agent 授权中勾选后，其工具才会出现。"
          )}
        </p>
        <CodeBlock label="adc-node">
          {`adc-node mcp add github --name GitHub --stdio npx \\
  --args '["-y","@modelcontextprotocol/server-github"]' \\
  --env-file ~/.config/adc/github-mcp-env.json

adc-node mcp add internal --name Internal \\
  --http https://mcp.internal.example/api \\
  --headers-file ~/.config/adc/internal-mcp-headers.json

adc-node mcp list
adc-node mcp remove github`}
        </CodeBlock>
        <p>
          {copy(
            "Using the same provider ID on several devices shows one tool with several targets. A schema change creates a new tool ID that needs authorization again.",
            "在多台设备上使用相同的 provider ID，会合并为一个工具、多个目标设备。工具 Schema 变化会生成新的工具 ID，需要重新授权。"
          )}
        </p>
      </Section>
      <Section id="lifecycle" title={copy("Status, updates and removal", "状态、更新与移除")}>
        <CodeBlock label="adc-node">
          {`adc-node status
adc-node logs
adc-node restart
adc update --check
adc update
adc-node rotate-key
adc-node unpair --confirm NODE_ID
adc-node uninstall`}
        </CodeBlock>
        <p>
          {copy(
            "The connector keeps an outbound connection, pauses while the device sleeps and reconnects on wake. Updates keep the device identity, folders and receipts. The console shows when a newer connector is available, including for offline devices.",
            "连接器保持一条出站连接，设备休眠时暂停，唤醒后自动重连。更新会保留设备身份、目录与回执。控制台会提示可用的新版本，离线设备也会显示。"
          )}
        </p>
        <p>
          {copy(
            "Deleting a device in the console revokes it on the server. Run adc-node unpair before enrolling the same machine again.",
            "在控制台删除设备会在服务端撤销其身份。同一台机器重新接入前，请先运行 adc-node unpair。"
          )}
        </p>
      </Section>
    </>
  );
}

function HowItWorks() {
  const copy = useDocCopy();
  const parts: Array<[Text, Text]> = [
    [
      ["Agent interface", "Agent 接入层"],
      [
        "Plugins, the Skill, MCP, CLI and SDK. They all submit the same typed invocation, for example file.read with a path.",
        "插件、Skill、MCP、CLI 与 SDK。它们提交的都是同一种类型化调用，例如带路径的 file.read。"
      ]
    ],
    [
      ["ADC service", "ADC 服务"],
      [
        "Authenticates the caller, evaluates permissions and approvals, queues work for the device and keeps the audit record. It never runs your tools.",
        "认证调用方、计算权限与审批、为设备排队任务并保存审计记录。它从不运行你的工具。"
      ]
    ],
    [
      ["Device connector", "设备连接器"],
      [
        "Holds an outbound connection, advertises the tools it offers, re-checks every path locally, runs the tool and stores a receipt before reporting back.",
        "保持出站连接，声明自己提供的工具，在本地再次校验路径，运行工具，并在回报前保存回执。"
      ]
    ]
  ];
  const layers: Array<[Text, Text]> = [
    [
      ["Device scope", "设备本地范围"],
      ["What the device owner exposed with adc-node.", "设备所有者通过 adc-node 开放的内容。"]
    ],
    [
      ["Device policy", "设备策略"],
      [
        "Console settings for that device: usable folders, read-only folders, execution on or off.",
        "控制台中该设备的设置：可用目录、只读目录、是否允许执行。"
      ]
    ],
    [
      ["Agent access", "Agent 授权"],
      [
        "The devices, folders and tools granted to this agent.",
        "授予这个 Agent 的设备、目录与工具。"
      ]
    ],
    [
      ["Approval", "审批"],
      [
        "Whether writes, commands or every call wait for a person.",
        "写入、命令或每次调用是否需要人工批准。"
      ]
    ]
  ];
  const lifecycle: Array<[string, Text]> = [
    ["requested", ["The agent submits a call with its credential.", "Agent 携带凭据提交调用。"]],
    [
      "authorized",
      ["ADC resolves the device and checks every layer.", "ADC 确定目标设备并检查每一层权限。"]
    ],
    [
      "approval",
      [
        "If required, the call waits for you without holding the device.",
        "如需审批，调用会等待你处理，期间不占用设备。"
      ]
    ],
    [
      "leased",
      [
        "The device claims the work and renews a short lease while it runs.",
        "设备领取任务，运行期间持续续期短租约。"
      ]
    ],
    [
      "running",
      ["The connector checks the path again and runs the tool.", "连接器再次校验路径并运行工具。"]
    ],
    [
      "done",
      [
        "The result and receipt return; Activity records the outcome.",
        "结果与回执返回，活动记录写入最终结果。"
      ]
    ]
  ];
  return (
    <>
      <PageIntro
        eyebrow={copy("How ADC works", "ADC 如何工作")}
        title={copy(
          "The agent plans, ADC routes, the device executes",
          "Agent 规划，ADC 路由，设备执行"
        )}
        description={copy(
          "An agent loop and an execution environment are separate parts. ADC connects them through device discovery, authorization and tool routing; it does not introduce another model loop. Permissions and task receipts make this connection manageable.",
          "Agent 循环与执行环境是两个独立部分。ADC 通过设备发现、授权和工具路由把它们连接起来，不增加另一个模型循环。权限和任务回执让这条连接可管理、可追踪。"
        )}
      />
      <Section id="components" title={copy("Three parts", "三个组成部分")}>
        <dl className="docs-definitions docs-terms">
          {parts.map(([term, text]) => (
            <div key={term[0]}>
              <dt>{copy(...term)}</dt>
              <dd>{copy(...text)}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section
        id="cloud-runtime"
        title={copy(
          "A cloud runtime can use local execution environments",
          "云端 Runtime 可以使用本地执行环境"
        )}
      >
        <p>
          {copy(
            "The runtime's own shell acts on its own machine. ADC adds tools targeted at other Nodes so the agent can use their files, programs or hardware. The route must return an observable result; registering a device without usable tools does not create the ability to operate it.",
            "Runtime 自己的 shell 操作的是它所在的机器。ADC 增加面向其他 Node 的工具，让 Agent 使用那些设备上的文件、程序或硬件。这条路径必须能够返回可观察结果；只有设备注册、没有可用工具，并不会产生操作能力。"
          )}
        </p>
        <p>
          <Link className="docs-text-link" to="/articles/cloud-agent-local-devices">
            {copy("From cloud reasoning to device actions", "从云端推理到设备操作的完整过程")}
          </Link>
        </p>
      </Section>
      <Section
        id="authorization"
        title={copy("What decides whether a call is allowed", "调用是否被允许由什么决定")}
      >
        <p>
          {copy(
            "A call runs only if every layer allows it. No layer can widen another, and changes apply to new calls immediately.",
            "只有每一层都允许，调用才会执行。任何一层都不能放宽其他层，修改会立即作用于新的调用。"
          )}
        </p>
        <ol className="docs-flow docs-flow-four">
          {layers.map(([term, text], index) => (
            <li key={term[0]}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{copy(...term)}</strong>
              <p>{copy(...text)}</p>
            </li>
          ))}
        </ol>
      </Section>
      <Section id="request-lifecycle" title={copy("The life of a call", "一次调用的全过程")}>
        <ol className="docs-lifecycle">
          {lifecycle.map(([state, text], index) => (
            <li key={state}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <code>{state}</code>
              <p>{copy(...text)}</p>
            </li>
          ))}
        </ol>
        <p>
          {copy(
            "Permissions are checked again when the device claims work and on every lease renewal, so revoking access stops running work too.",
            "设备领取任务和每次续租时都会重新检查权限，因此撤销授权也会停止正在运行的任务。"
          )}
        </p>
      </Section>
      <Section id="delivery" title={copy("Retries and unknown outcomes", "重试与未知结果")}>
        <p>
          {copy(
            "Calls that change something need an idempotency key, and the device writes a durable receipt before reporting. Retrying with the same key returns the original result instead of running twice.",
            "会产生修改的调用需要幂等键，设备在回报前会写入持久回执。使用相同幂等键重试会返回原结果，而不会执行两次。"
          )}
        </p>
        <p>
          {copy(
            "If a call may have run but no receipt can be proven, it ends as unknown_outcome. ADC never retries it automatically; check the target first.",
            "如果调用可能已经执行、但无法证明存在回执，结果为 unknown_outcome。ADC 不会自动重试，请先检查目标资源。"
          )}
        </p>
      </Section>
      <Section id="ownership" title={copy("What is stored where", "数据存放在哪里")}>
        <div className="docs-boundary-grid">
          <div>
            <strong>{copy("ADC service", "ADC 服务")}</strong>
            <p>
              {copy(
                "Accounts, exposed folder names, Agent access, call arguments, returned results and receipts.",
                "账号、开放目录名、Agent 授权、调用参数、返回结果与回执。"
              )}
            </p>
          </div>
          <div>
            <strong>{copy("Your device", "你的设备")}</strong>
            <p>
              {copy(
                "The device private key, local MCP credentials and every file that was not explicitly requested.",
                "设备私钥、本地 MCP 凭据，以及所有未被明确请求的文件。"
              )}
            </p>
          </div>
        </div>
        <p className="docs-callout">
          {copy(
            "Projects are optional groups of folders across devices. They are not a security boundary.",
            "项目只是跨设备的目录分组，可选使用，不构成安全边界。"
          )}
        </p>
      </Section>
    </>
  );
}

function Security() {
  const { t } = useI18n();
  const copy = useDocCopy();
  const controls: Array<[Message, Message, Message]> = [
    [
      "Stolen access key",
      "Access keys are hashed, expire and bind to one revocable authorization.",
      "A copied access key remains usable until it expires or is revoked."
    ],
    [
      "Compromised device key",
      "Every device request uses an Ed25519 or Android Keystore P-256 signature, timestamp and one-time nonce.",
      "A stolen private key remains valid until the device is revoked."
    ],
    [
      "Path escape",
      "Canonical paths, realpath, no-follow opens and descriptor identity checks are enforced locally.",
      "Portable APIs cannot eliminate every hostile parent-directory race or hard-link alias."
    ],
    [
      "Duplicate side effect",
      "Stable idempotency keys and a fsynced local ledger prevent automatic duplicate execution.",
      "A crash after the effect but before its receipt is reported as unknown_outcome."
    ],
    [
      "Sensitive output",
      "Protected paths, bounded output and common secret patterns are filtered in restricted mode.",
      "Redaction is best effort and cannot prove arbitrary authorized content is safe."
    ]
  ];
  return (
    <>
      <PageIntro
        eyebrow={copy("Security", "安全")}
        title={t("Trust model")}
        description={copy(
          "Separate identities for people, agents and devices; permissions that only narrow; and a device that re-checks everything. Known limits are listed plainly below.",
          "人、Agent 与设备身份分离；权限只会收窄；设备会再次校验一切。已知限制在下文如实列出。"
        )}
      />
      <PlatformTestingNotice />
      <ul className="docs-principles">
        <li>
          <ShieldCheck />
          <span>
            {t(
              "Management sessions administer an account. Agent credentials can only use their bound authorization."
            )}
          </span>
        </li>
        <li>
          <ShieldCheck />
          <span>
            {t(
              "Every device request uses an Ed25519 or Android Keystore P-256 signature, timestamp and one-time nonce."
            )}
          </span>
        </li>
        <li>
          <ShieldCheck />
          <span>
            {t(
              "Filesystem operations validate canonical paths and symlink boundaries again on the device."
            )}
          </span>
        </li>
      </ul>
      <Section id="limitations" title={t("Important limitation")}>
        <p className="docs-warning">
          {t(
            "Restricted process mode is a guardrail, not a sandbox. Full device trust disables command and protected-path filters."
          )}
        </p>
      </Section>
      <Section id="visibility" title={t("What the control plane can see")}>
        <p>
          {t(
            "The control plane stores exposed path names, invocation arguments, returned results, artifacts and audit metadata."
          )}{" "}
          {t(
            "It does not hold the device private key or proactively crawl the filesystem. An authorized result may still contain sensitive data."
          )}
        </p>
      </Section>
      <Section id="credentials" title={t("Credential storage")}>
        <p>
          {copy(
            "Desktop device keys are stored in local configuration files (mode 0600 on Unix); desktop Keychain and keyring support is not implemented. Android Mobile Node keeps its P-256 private key in Android Keystore.",
            "桌面设备密钥保存在本地配置文件中（Unix 权限为 0600）；桌面 Keychain 和 keyring 支持尚未实现。Android Mobile Node 的 P-256 私钥保存在 Android Keystore 中。"
          )}
        </p>
      </Section>
      <Section id="threats" title={t("Threats and controls")}>
        <div className="table-wrap docs-table">
          <table>
            <thead>
              <tr>
                <th>{t("Threat")}</th>
                <th>{t("Control")}</th>
                <th>{t("Residual risk")}</th>
              </tr>
            </thead>
            <tbody>
              {controls.map(([threat, control, residual]) => (
                <tr key={threat}>
                  <td>
                    <strong>{t(threat)}</strong>
                  </td>
                  <td>{t(control)}</td>
                  <td>{t(residual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section id="assurance" title={t("Current assurance")}>
        <div className="docs-assurance">
          <div>
            <strong>{t("Verified in automation and deployment")}</strong>
            <ul>
              <li>{t("Protocol schemas, policy decisions and adapter parity")}</li>
              <li>{t("Real PostgreSQL migrations, locking, restart and account isolation")}</li>
              <li>{t("Path traversal, symlink escape, cancellation and idempotency recovery")}</li>
              <li>{t("macOS arm64 installation, upgrade, reconnect and uninstall")}</li>
              <li>{t("Public HTTPS deployment, database readiness and restart recovery")}</li>
              <li>
                {t("Hosted email verification and password recovery with real inbox delivery")}
              </li>
              <li>
                {t(
                  "Selected Xiaomi/MIUI mobile capabilities; other Android models require validation"
                )}
              </li>
            </ul>
          </div>
          <div>
            <strong>{t("Not yet certified")}</strong>
            <ul>
              <li>{t("External penetration testing and signed release provenance")}</li>
              <li>{t("Real GitHub consent round trip")}</li>
              <li>{t("Linux systemd and every generated cross-platform archive")}</li>
              <li>{t("Hard filesystem, network and process isolation")}</li>
            </ul>
          </div>
        </div>
      </Section>
      <p>
        {copy("Report vulnerabilities privately through the ", "请通过")}
        <a
          className="docs-text-link"
          href={`${repositoryUrl}/security`}
          target="_blank"
          rel="noreferrer"
        >
          {copy("repository security policy", "仓库安全策略")}
        </a>
        {copy(".", "私下报告漏洞。")}
      </p>
    </>
  );
}

function SelfHosting() {
  const copy = useDocCopy();
  const variables: Array<[string, Text]> = [
    ["ADC_PUBLIC_URL", ["The public HTTPS origin.", "对外访问的 HTTPS 地址。"]],
    [
      "ADC_AUTH_SECRET",
      ["A stable secret of 32+ characters. Back it up.", "32 位以上的稳定密钥，务必备份。"]
    ],
    [
      "ADC_DATABASE_PASSWORD",
      ["PostgreSQL password (URL-safe).", "PostgreSQL 密码（需 URL 安全）。"]
    ],
    ["ADC_SMTP_URL", ["Required when email verification is on.", "开启邮箱验证时必填。"]],
    [
      "ADC_TRUSTED_PROXIES",
      [
        "Only the proxies allowed to set client IP headers.",
        "仅填写允许设置客户端 IP 请求头的代理。"
      ]
    ],
    [
      "ADC_ANALYTICS_*",
      [
        "Leave unset to send no external analytics (the default).",
        "保持未设置即不发送任何外部分析数据（默认）。"
      ]
    ]
  ];
  const metrics: Array<[string, Text]> = [
    ["adc_node_wake_connections", ["Connected devices right now.", "当前已连接的设备数。"]],
    [
      "adc_node_poll_total",
      ["Device polls: dispatched, idle or denied.", "设备轮询：已派发、空闲或被拒。"]
    ],
    ["adc_invocation_total", ["Calls by tool and outcome.", "按工具与结果统计的调用数。"]]
  ];
  return (
    <>
      <PageIntro
        eyebrow={copy("Self-hosting", "自部署")}
        title={copy("Run ADC on your own server", "在自己的服务器上运行 ADC")}
        description={copy(
          "The self-hosted app is the same one that runs the official service. You need Docker Compose 2.24.4+, a hostname, ports 80/443 and persistent storage.",
          "自部署版本与官方服务是同一套应用。你需要 Docker Compose 2.24.4+、一个域名、开放 80/443 端口以及持久存储。"
        )}
      />
      <Section id="deploy" title={copy("Deploy", "部署")}>
        <CodeBlock label={copy("Terminal", "终端")}>
          {`cp .env.example .env
openssl rand -hex 48   # ADC_AUTH_SECRET
openssl rand -hex 32   # ADC_DATABASE_PASSWORD
docker compose --env-file .env -f deploy/compose.yaml up -d --build`}
        </CodeBlock>
        <dl className="docs-definitions">
          {variables.map(([name, text]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{copy(...text)}</dd>
            </div>
          ))}
        </dl>
        <p>
          {copy(
            "Caddy obtains TLS certificates automatically. Set ADC_REGISTRATION_ENABLED=false once the intended accounts exist.",
            "Caddy 会自动申请 TLS 证书。创建好需要的账号后，设置 ADC_REGISTRATION_ENABLED=false 关闭注册。"
          )}
        </p>
      </Section>
      <Section id="verify" title={copy("Verify", "验证")}>
        <CodeBlock label={copy("Terminal", "终端")}>
          {`curl -fsS https://devices.example.com/health
# {"ok":true,"schemaVersion":"0.1"}
docker compose --env-file .env -f deploy/compose.yaml logs --tail=100 control-plane`}
        </CodeBlock>
        <p>
          {copy(
            "Then follow the Quickstart once: pair a device and complete one read-only call. A healthy /health alone does not prove sign-in, WebSocket upgrades and dispatch all work.",
            "然后按快速上手完整走一遍：配对一台设备并完成一次只读调用。仅 /health 正常，并不能证明登录、WebSocket 升级和任务派发都可用。"
          )}
        </p>
      </Section>
      <Section id="operations" title={copy("Operate", "日常运维")}>
        <ul className="docs-checklist">
          <li>
            {copy(
              "Probe /health from outside the host and alert on anything but 200.",
              "从主机外部探测 /health，非 200 即告警。"
            )}
          </li>
          <li>
            {copy(
              "Scrape the authenticated /metrics endpoint; never expose it publicly.",
              "采集需要认证的 /metrics，不要暴露到公网。"
            )}
          </li>
          <li>
            {copy(
              "Alert on disk space and PostgreSQL availability. There is no automatic quota or retention yet.",
              "为磁盘空间和 PostgreSQL 可用性配置告警。目前还没有自动配额或数据保留策略。"
            )}
          </li>
        </ul>
        <div className="table-wrap docs-table">
          <table>
            <thead>
              <tr>
                <th>{copy("Metric", "指标")}</th>
                <th>{copy("Meaning", "含义")}</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map(([name, text]) => (
                <tr key={name}>
                  <td>
                    <code>{name}</code>
                  </td>
                  <td>{copy(...text)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section id="backup" title={copy("Back up and restore", "备份与恢复")}>
        <CodeBlock label={copy("Terminal", "终端")}>
          {`docker compose --env-file .env -f deploy/compose.yaml exec -T postgres \\
  pg_dump -U adc -d adc -Fc > adc-backup.dump
docker compose --env-file .env -f deploy/compose.yaml exec -T postgres \\
  pg_restore --list < adc-backup.dump`}
        </CodeBlock>
        <p>
          {copy(
            "Keep the dump together with .env in encrypted storage, and test a restore into a separate database. Restoring can bring back credentials revoked after the backup, so rotate them after an incident.",
            "把备份与 .env 一起存放在加密位置，并定期恢复到独立数据库验证。恢复可能让备份之后已撤销的凭据重新生效，安全事件后请轮换凭据。"
          )}
        </p>
      </Section>
      <Section id="upgrade" title={copy("Upgrade", "升级")}>
        <ol className="docs-numbered">
          <li>
            {copy(
              "Record the running version and take a verified backup.",
              "记录当前版本，并完成一次经过验证的备份。"
            )}
          </li>
          <li>
            {copy(
              "Rebuild and recreate the control plane. Migrations run before HTTP starts.",
              "重新构建并重建控制面。数据库迁移会在 HTTP 服务启动前完成。"
            )}
          </li>
          <li>
            {copy(
              "Check /health, sign-in, device presence and one read-only call.",
              "检查 /health、登录、设备在线状态和一次只读调用。"
            )}
          </li>
          <li>
            {copy(
              "Keep the previous image and backup until you are satisfied; a schema rollback may need the backup.",
              "确认无误前保留旧镜像与备份，数据库结构回滚可能需要用到备份。"
            )}
          </li>
        </ol>
      </Section>
    </>
  );
}

function Troubleshooting() {
  const copy = useDocCopy();
  const items: Array<[Text, Text, string]> = [
    [
      ["Device is offline", "设备离线"],
      [
        "Check that the service is running and can reach the ADC address. A sleeping laptop is offline by design and reconnects on wake.",
        "检查服务是否运行、能否访问 ADC 地址。笔记本休眠时离线属于正常现象，唤醒后会自动重连。"
      ],
      "adc-node status\nadc-node logs\nadc-node restart"
    ],
    [
      ["The agent sees no folders", "Agent 看不到目录"],
      [
        "Check the local access mode first, then the device policy in the console, then the Agent access. Each layer can only narrow the one before it.",
        "先检查本地访问模式，再看控制台中的设备策略，最后看 Agent 授权。每一层只会收窄上一层。"
      ],
      "adc-node status\nadc-node roots list\nadc-node roots add ~/work --label Work"
    ],
    [
      ["A call is denied", "调用被拒绝"],
      [
        "Read the returned reason before widening access. Check the tool list in Agent access, the device's execution switch and read-only folders.",
        "扩大权限前先看返回的原因。检查 Agent 授权中的工具列表、设备的执行开关与只读目录。"
      ],
      "adc access show my-agent --json\nadc device show DEVICE --json"
    ],
    [
      ["A call is waiting for approval", "调用在等待审批"],
      [
        "Open Approvals before it expires and check the agent, device, tool and path.",
        "在过期前打开「审批」，核对 Agent、设备、工具与路径。"
      ],
      "adc approval list --json\nadc approval approve APPROVAL_ID --json"
    ],
    [
      ["unknown_outcome", "unknown_outcome（未知结果）"],
      [
        "The change may have happened, but no receipt can be proven. Check the target and Activity first; retry only with the original idempotency key.",
        "修改可能已经发生，但无法证明存在回执。先检查目标资源和活动记录，只能使用原幂等键重试。"
      ],
      "adc audit show INVOCATION_ID --json\nadc task result JOB_ID --json"
    ],
    [
      ["Self-hosted: /health returns 503", "自部署：/health 返回 503"],
      [
        "Check PostgreSQL availability and disk space, restore the database connection, then restart the app.",
        "检查 PostgreSQL 可用性与磁盘空间，恢复数据库连接后再重启应用。"
      ],
      "docker compose --env-file .env -f deploy/compose.yaml ps"
    ]
  ];
  return (
    <>
      <PageIntro
        eyebrow={copy("Troubleshooting", "故障排查")}
        title={copy("Fix common problems", "解决常见问题")}
        description={copy(
          "Find the symptom, run the commands, and read the reason before widening any access.",
          "找到对应症状，运行命令，在扩大任何权限之前先读懂原因。"
        )}
      />
      <div className="troubleshooting-list">
        {items.map(([title, text, command]) => (
          <section key={title[0]}>
            <h2>{copy(...title)}</h2>
            <p>{copy(...text)}</p>
            <pre>
              <code>{command}</code>
            </pre>
          </section>
        ))}
      </div>
      <p className="docs-warning">
        {copy(
          "When asking for help, include the error code, invocation ID and connector logs. Never paste access keys, cookies, device keys or file contents into a public issue.",
          "寻求帮助时请附上错误码、调用 ID 和连接器日志。不要把访问密钥、Cookie、设备密钥或文件内容贴到公开 Issue。"
        )}
      </p>
    </>
  );
}

function CliReference() {
  const copy = useDocCopy();
  const origin = docsOrigin();
  const groups: Array<{ id: string; title: Text; note?: Text; code: string }> = [
    {
      id: "sign-in",
      title: ["Sign in and connect", "登录与连接"],
      note: [
        "adc login manages your account. adc connect creates the credential an agent uses for tools.",
        "adc login 用于管理账号；adc connect 创建 Agent 调用工具时使用的凭据。"
      ],
      code: `adc login --url ${origin}
adc status
adc connect ACCESS [--name NAME] [--expires DAYS]
adc connection list
adc logout`
    },
    {
      id: "devices",
      title: ["Devices", "设备"],
      code: `adc device add [--name NAME] [--platform unix|windows|wsl]
adc device list
adc device show DEVICE
adc device update DEVICE [--folders all|none|LIST] [--read-only LIST] [--execution on|off]
adc device wait DEVICE [--timeout SECONDS]
adc device remove DEVICE --yes`
    },
    {
      id: "access",
      title: ["Agent access", "Agent 授权"],
      code: `adc access create --name NAME --devices LIST [--folders all|none|LIST]
                  [--capabilities read|write|run|templates]
                  [--approval never|writes|execute|always]
adc access list
adc access show ACCESS
adc access update ACCESS [same options as create]
adc access revoke ACCESS --yes`
    },
    {
      id: "tools",
      title: ["Tools and tasks", "工具与任务"],
      note: [
        "Calls that change something need --idempotency-key. --wait waits up to 30000 ms for a result.",
        "会产生修改的调用必须带 --idempotency-key。--wait 最多等待 30000 毫秒返回结果。"
      ],
      code: `adc tool list
adc tool show TOOL
adc invoke TOOL --args JSON [--node DEVICE] [--wait [MS]] [--idempotency-key KEY]
adc invocation status INVOCATION
adc task wait JOB [--wait MS]
adc task status|result|cancel JOB`
    },
    {
      id: "approvals",
      title: ["Approvals and activity", "审批与活动记录"],
      code: `adc approval list
adc approval approve|deny APPROVAL
adc audit list
adc audit show INVOCATION`
    },
    {
      id: "teams",
      title: ["Teams and sharing", "团队与共享"],
      code: `adc team list | create --name NAME
adc team invite TEAM --email EMAIL [--role member|admin]
adc share create DEVICE --email EMAIL --scope SCOPE.json [--days 30]
adc invitation accept INVITATION --yes`
    },
    {
      id: "adc-node",
      title: ["On the device: adc-node", "设备端：adc-node"],
      code: `adc-node status | logs | restart
adc-node access none|selected|home|full
adc-node roots add FOLDER [--label NAME] [--read-only]
adc-node roots list | remove ROOT_ID
adc-node templates add ID --root ROOT_ID --command COMMAND
adc-node mcp add ID --stdio COMMAND | --http URL
adc-node sharing on|off
adc-node unpair --confirm NODE_ID
adc-node uninstall`
    }
  ];
  return (
    <>
      <PageIntro
        eyebrow={copy("Reference", "参考")}
        title={copy("CLI", "命令行")}
        description={copy(
          "adc manages your account and calls tools from anywhere. adc-node configures the device it runs on. Both ship with the connector installer.",
          "adc 用于管理账号，并可在任何地方调用工具；adc-node 用于配置它所在的设备。两者都随连接器安装器一起提供。"
        )}
      />
      <Section id="install" title={copy("Install the CLI only", "只安装 CLI")}>
        <p>
          {copy(
            "On a machine that should call tools but not be a device, install without pairing:",
            "如果某台机器只需要调用工具、不作为设备，可以只安装 CLI："
          )}
        </p>
        <CodeBlock label="macOS / Linux">
          {`curl -fsSL ${origin}/install.sh | sh -s -- --cli-only
adc --version`}
        </CodeBlock>
        <p>
          {copy(
            "Add --json to any command for machine-readable output. Exit code 1 means the service returned an error (JSON on stderr); 2 means a usage or local error. Run adc --help or adc-node --help for every option.",
            "任意命令加 --json 可输出机器可读结果。退出码 1 表示服务端返回错误（JSON 输出到 stderr），2 表示用法或本地错误。运行 adc --help 或 adc-node --help 查看全部选项。"
          )}
        </p>
      </Section>
      {groups.map((group) => (
        <Section key={group.id} id={group.id} title={copy(...group.title)}>
          {group.note ? <p>{copy(...group.note)}</p> : null}
          <CodeBlock label={group.id === "adc-node" ? "adc-node" : "adc"}>{group.code}</CodeBlock>
        </Section>
      ))}
      <p>
        {copy(
          "DEVICE, ACCESS and FOLDER accept an exact ID or an unambiguous name or path.",
          "DEVICE、ACCESS 与 FOLDER 可以使用精确 ID，或不产生歧义的名称、路径。"
        )}
      </p>
    </>
  );
}

function ToolReference() {
  const { t } = useI18n();
  const copy = useDocCopy();
  const groups: Array<{ tools: string[]; risk: Message; purpose: Message | Text }> = [
    {
      tools: ["device.list", "device.status"],
      risk: "Read",
      purpose: "Discover devices and inspect their current capability."
    },
    {
      tools: ["file.list", "file.read", "file.search"],
      risk: "Read",
      purpose: "List, read and search files inside authorized folders."
    },
    {
      tools: ["file.write", "file.edit", "file.patch", "file.transfer"],
      risk: "Write",
      purpose: "Create, replace, edit or patch files atomically."
    },
    {
      tools: ["shell.exec"],
      risk: "Execute",
      purpose: [
        "Run a command supplied by the agent in an authorized working directory.",
        "在已授权的工作目录中，运行 Agent 提供的 shell 命令。"
      ]
    },
    {
      tools: ["command.template.list"],
      risk: "Read",
      purpose: [
        "List locally configured command templates and their metadata; runs no command.",
        "列出本地预设命令的 ID、目录与超时等信息，不执行命令。"
      ]
    },
    {
      tools: ["command.template.run"],
      risk: "Execute",
      purpose: [
        "Run a command preset on the device, selected by templateId; the agent cannot replace the command.",
        "按 templateId 运行设备本地预设的命令，Agent 不能替换命令内容。"
      ]
    },
    {
      tools: ["test.run"],
      risk: "Execute",
      purpose: [
        "Run a preset through the same template executor; defaults to templateId=test and accepts timeoutMs.",
        "通过同一个模板执行器运行预设命令，默认 templateId=test，可指定 timeoutMs。"
      ]
    },
    {
      tools: ["task.status", "task.result", "task.wait", "task.cancel"],
      risk: "Varies",
      purpose: "Inspect or cancel asynchronous work."
    },
    {
      tools: [
        "device.battery.get",
        "device.info.get",
        "device.network.get",
        "device.storage.get",
        "display.status",
        "audio.status",
        "flashlight.status",
        "location.get",
        "screen.capture",
        "ui.inspect",
        "ui.wait"
      ],
      risk: "Read",
      purpose: "Read live state exposed by an authorized mobile device."
    },
    {
      tools: ["notification.show"],
      risk: "Write",
      purpose: "Present an authorized notification on a mobile device."
    },
    {
      tools: [
        "device.navigation",
        "device.vibrate",
        "app.open",
        "audio.volume.set",
        "flashlight.set",
        "ui.action",
        "ui.gesture"
      ],
      risk: "Execute",
      purpose: "Operate the visible Android interface within local Accessibility permission."
    }
  ];
  return (
    <>
      <PageIntro
        eyebrow={copy("Reference", "参考")}
        title={t("{count} built-in tools", {
          count: documentedTools.filter(isConsoleToolVisible).length
        })}
        description={copy(
          "Every interface — plugin, Skill, MCP, CLI and SDK — exposes the same tools with the same schemas. Run adc tool show TOOL for the exact input schema.",
          "插件、Skill、MCP、CLI 与 SDK 暴露的是同一组工具和同一套 Schema。运行 adc tool show TOOL 可查看准确的输入格式。"
        )}
      />
      <PlatformTestingNotice />
      <div className="table-wrap docs-table">
        <table>
          <thead>
            <tr>
              <th>{t("Tool")}</th>
              <th>{t("Risk")}</th>
              <th>{t("Purpose")}</th>
            </tr>
          </thead>
          <tbody>
            {groups.flatMap((group) =>
              group.tools.filter(isConsoleToolVisible).map((tool) => (
                <tr key={tool}>
                  <td>
                    <code>{tool}</code>
                  </td>
                  <td>{t(group.risk)}</td>
                  <td>
                    {typeof group.purpose === "string" ? t(group.purpose) : copy(...group.purpose)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Section
        id="command-tools"
        title={copy("Shell, templates and tests", "Shell、命令模板与测试")}
      >
        <p>
          {copy(
            "With shell.exec, the agent supplies the command. With a template, the device owner presets it and the agent selects its ID. For example:",
            "shell.exec 的命令内容由 Agent 提供；命令模板的内容由设备所有者预先配置，Agent 只选择模板 ID。例如："
          )}
        </p>
        <CodeBlock label="adc-node">
          {`adc-node templates add lint --root ROOT_ID --command "npm run lint"
adc-node templates add test --root ROOT_ID --command "npm test"`}
        </CodeBlock>
        <p>
          {copy(
            "command.template.list only lists these presets. command.template.run with templateId=lint runs npm run lint; test.run without a templateId runs npm test. test.run can also select a different templateId. Its timeoutMs defaults to five minutes and cannot exceed the template's configured timeout.",
            "command.template.list 只列出这些模板。command.template.run 指定 templateId=lint 时运行 npm run lint；test.run 不指定 templateId 时运行 npm test，也可以指定其他模板 ID。test.run 的 timeoutMs 默认 5 分钟，实际运行时间不能超过模板配置的超时。"
          )}
        </p>
        <p>
          {copy(
            "All three execution tools ultimately run a shell process. Templates limit which command the agent may choose; they do not provide a separate sandbox. The current executor rejects non-empty template parameters.",
            "三个执行工具最终都运行 shell 进程。模板限制的是 Agent 可以选择的命令，不提供额外沙箱。当前执行器不接受非空的模板 parameters。"
          )}
        </p>
      </Section>
      <Section id="rules" title={copy("Rules that apply to every tool", "适用于所有工具的规则")}>
        <ul className="docs-checklist">
          <li>
            {copy(
              "Write and Execute tools need an idempotency key. Reuse it only to retry the exact same call.",
              "写入和执行类工具需要幂等键，只在重试完全相同的调用时复用。"
            )}
          </li>
          <li>
            {copy(
              "Paths must be absolute and inside an authorized folder on the target device.",
              "路径必须是目标设备上已授权目录内的绝对路径。"
            )}
          </li>
          <li>
            {copy(
              "Local MCP server tools appear namespaced, default to Execute risk and need explicit authorization.",
              "本地 MCP 服务的工具会带命名空间，默认按执行风险处理，并需要明确授权。"
            )}
          </li>
        </ul>
      </Section>
      <Section id="task-wait" title={copy("Wait for a running task", "等待运行中的任务")}>
        <p>
          {copy(
            "task.wait takes jobId and waitMs (0–30000, default 4000) and returns when the task finishes or the wait ends. If it is still running, wait again with the same jobId instead of resubmitting.",
            "task.wait 接收 jobId 与 waitMs（0–30000，默认 4000），任务结束或等待到期时返回。如果仍在运行，用同一个 jobId 继续等待，不要重新提交。"
          )}
        </p>
        <CodeBlock label="CLI">
          {`adc invoke task.wait --args '{"jobId":"job_example","waitMs":4000}' --json`}
        </CodeBlock>
      </Section>
    </>
  );
}

function ApiReference() {
  const copy = useDocCopy();
  const endpoints: Array<[string, string, Text, Text]> = [
    [
      "GET",
      "/api/v1/me",
      ["Owner or Agent", "账号用户或 Agent"],
      ["Current identity and scope.", "当前身份与权限范围。"]
    ],
    [
      "GET",
      "/api/v1/nodes",
      ["Owner", "账号用户"],
      ["Paired devices and capabilities.", "已配对设备与能力。"]
    ],
    [
      "POST",
      "/api/v1/pairing-codes",
      ["Owner", "账号用户"],
      ["Create a one-time pairing code.", "创建一次性配对码。"]
    ],
    [
      "GET · POST",
      "/api/v1/grants",
      ["Owner", "账号用户"],
      ["List or create Agent access.", "列出或创建 Agent 授权。"]
    ],
    [
      "PATCH · DELETE",
      "/api/v1/grants/:grantId",
      ["Owner", "账号用户"],
      ["Update (with revision) or delete Agent access.", "更新（需版本号）或删除 Agent 授权。"]
    ],
    ["POST", "/api/v1/invocations", ["Agent", "Agent"], ["Submit a tool call.", "提交工具调用。"]],
    [
      "GET",
      "/api/v1/invocations/:invocationId",
      ["Owner or Agent", "账号用户或 Agent"],
      ["Follow a call through approval and dispatch.", "跟踪调用的审批与派发状态。"]
    ],
    [
      "GET",
      "/api/v1/tasks/:jobId",
      ["Agent", "Agent"],
      ["Task state or final result.", "任务状态或最终结果。"]
    ],
    [
      "POST",
      "/api/v1/tasks/:jobId/cancel",
      ["Agent", "Agent"],
      ["Cancel a running task.", "取消运行中的任务。"]
    ],
    [
      "GET",
      "/api/v1/approvals",
      ["Owner", "账号用户"],
      ["Pending or resolved approvals (cursor paging).", "待处理或已处理审批（游标分页）。"]
    ],
    [
      "GET",
      "/api/v1/audit",
      ["Owner", "账号用户"],
      ["Activity records (cursor paging).", "活动记录（游标分页）。"]
    ]
  ];
  const errors: Array<[string, Text, Text]> = [
    ["invalid_request", ["No", "否"], ["Fix the arguments.", "修正参数。"]],
    [
      "expired",
      ["No", "否"],
      ["Submit a new call with a new deadline.", "以新的截止时间重新提交。"]
    ],
    [
      "denied",
      ["No", "否"],
      [
        "Review Agent access, device policy and local scope.",
        "检查 Agent 授权、设备策略与本地范围。"
      ]
    ],
    [
      "approval_required",
      ["After approval", "审批后"],
      ["Approve before it expires.", "在过期前完成审批。"]
    ],
    ["offline", ["Yes", "是"], ["Wait for the device to reconnect.", "等待设备重新连接。"]],
    [
      "conflict",
      ["Conditionally", "视情况"],
      ["Refresh; never overwrite a newer revision.", "刷新后再处理，不要覆盖更新的版本。"]
    ],
    [
      "lease_expired",
      ["Conditionally", "视情况"],
      ["Read the task state before creating new work.", "创建新任务前先读取原任务状态。"]
    ],
    [
      "unknown_outcome",
      ["Never automatically", "不可自动重试"],
      ["Check the device and receipt first.", "先核对设备侧结果与回执。"]
    ],
    [
      "internal",
      ["When retryable", "仅 retryable 为真时"],
      ["Back off and keep the same request identity.", "退避重试，并保持相同请求身份。"]
    ]
  ];
  return (
    <>
      <PageIntro
        eyebrow={copy("Reference", "参考")}
        title={copy("HTTP API and errors", "HTTP API 与错误")}
        description={copy(
          "The console, CLI, MCP server and SDK all use this versioned API. Prefer the typed SDK client over hand-written requests.",
          "控制台、CLI、MCP 服务与 SDK 都使用这套版本化 API。建议优先使用类型化 SDK 客户端，而不是手写请求。"
        )}
      />
      <Section id="authentication" title={copy("Authentication", "身份认证")}>
        <dl className="docs-definitions docs-terms">
          <div>
            <dt>{copy("Owner session", "账号会话")}</dt>
            <dd>
              {copy(
                "Browser or CLI management session. Manages devices, Agent access, approvals and settings. Changes must come from the deployment origin.",
                "浏览器或 CLI 管理会话，用于管理设备、Agent 授权、审批与设置。修改请求必须来自部署自身的 Origin。"
              )}
            </dd>
          </div>
          <div>
            <dt>{copy("Agent credential", "Agent 凭据")}</dt>
            <dd>
              {copy(
                "Revocable Bearer token bound to one Agent access. It can only call the tools, folders and devices in that grant.",
                "绑定一份 Agent 授权的可撤销 Bearer 令牌，只能调用该授权内的工具、目录和设备。"
              )}
            </dd>
          </div>
          <div>
            <dt>{copy("Device identity", "设备身份")}</dt>
            <dd>
              {copy(
                "Ed25519 or Android Keystore P-256 signatures with a timestamp and one-time nonce. Not accepted on owner or Agent routes.",
                "使用 Ed25519 或 Android Keystore P-256 签名，附带时间戳与一次性 nonce；不能访问账号或 Agent 路由。"
              )}
            </dd>
          </div>
        </dl>
      </Section>
      <Section id="endpoints" title={copy("Main endpoints", "主要接口")}>
        <div className="table-wrap docs-table docs-api-table">
          <table>
            <thead>
              <tr>
                <th>{copy("Method", "方法")}</th>
                <th>{copy("Path", "路径")}</th>
                <th>{copy("Caller", "调用方")}</th>
                <th>{copy("Purpose", "用途")}</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map(([method, path, identity, purpose]) => (
                <tr key={`${method}-${path}`}>
                  <td>
                    <code>{method}</code>
                  </td>
                  <td>
                    <code>{path}</code>
                  </td>
                  <td>{copy(...identity)}</td>
                  <td>{copy(...purpose)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          {copy(
            "Approvals and audit page newest-first: pass limit (1–100) and the returned nextCursor as cursor.",
            "审批与活动记录按时间倒序分页：传入 limit（1–100），并把返回的 nextCursor 作为下一页的 cursor。"
          )}
        </p>
      </Section>
      <Section id="invocation" title={copy("Invocation", "调用格式")}>
        <p>
          {copy(
            "Official clients fill identity fields from the Agent credential. Paths must stay inside the grant; changing tools also need an idempotency key.",
            "官方客户端会根据 Agent 凭据填写身份字段。路径必须在授权范围内；会产生修改的工具还需要幂等键。"
          )}
        </p>
        <CodeBlock label="JSON">
          {`{
  "schemaVersion": "0.1",
  "invocationId": "inv_example001",
  "attemptId": "att_example001",
  "accountId": "acct_example001",
  "actor": { "type": "agent", "id": "actor_example001" },
  "target": { "nodeId": "node_example001" },
  "authorization": { "grantId": "grant_example001", "rootIds": ["root_workspace001"] },
  "tool": "file.read",
  "args": { "path": "/Users/me/work/README.md" },
  "issuedAt": "2026-09-29T10:00:00.000Z",
  "expiresAt": "2026-09-29T10:05:00.000Z",
  "metadata": { "source": "sdk" }
}`}
        </CodeBlock>
        <p>
          {copy(
            "A 200 response can still carry denied, approval_required or offline in status. queued and running results include a jobId to follow.",
            "HTTP 200 响应中的 status 仍可能是 denied、approval_required 或 offline；queued 与 running 结果会包含可跟踪的 jobId。"
          )}
        </p>
      </Section>
      <Section id="errors" title={copy("Error codes", "错误码")}>
        <div className="table-wrap docs-table docs-error-table">
          <table>
            <thead>
              <tr>
                <th>{copy("Code", "错误码")}</th>
                <th>{copy("Retry", "重试")}</th>
                <th>{copy("What to do", "处理方式")}</th>
              </tr>
            </thead>
            <tbody>
              {errors.map(([code, retry, action]) => (
                <tr key={code}>
                  <td>
                    <code>{code}</code>
                  </td>
                  <td>{copy(...retry)}</td>
                  <td>{copy(...action)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="docs-warning">
          {copy(
            "Never turn unknown_outcome into an automatic retry. The same idempotency key can recover a stored receipt; a new key can repeat the change.",
            "绝不要把 unknown_outcome 变成自动重试。相同幂等键可以取回已保存的回执，新幂等键可能重复执行修改。"
          )}
        </p>
      </Section>
    </>
  );
}

function Changelog() {
  const copy = useDocCopy();
  const releases: Array<{ id: string; title: Text; items: Text[]; note?: Text }> = [
    {
      id: "2026-11-01-0-1-6",
      title: ["2026-11-01 · Connector 0.1.6", "2026-11-01 · Connector 0.1.6"],
      items: [
        [
          "Teams can share a device's exposed / or drive root; member policies and Agent access still narrow it.",
          "团队可以共享设备已开放的 / 或盘符根目录，成员策略与 Agent 授权仍会继续收窄。"
        ],
        [
          "The console shows current and available connector versions for every device, including offline ones.",
          "控制台会显示每台设备当前与可更新的连接器版本，包括离线设备。"
        ]
      ],
      note: [
        "Root sharing needs Connector and CLI 0.1.6, SDK 0.2.2 or the updated plugins. Update with adc update.",
        "根目录共享需要 Connector 与 CLI 0.1.6、SDK 0.2.2 或更新后的插件。使用 adc update 更新。"
      ]
    },
    {
      id: "2026-10-31-0-1-5",
      title: ["2026-10-31 · Connector 0.1.5", "2026-10-31 · Connector 0.1.5"],
      items: [
        [
          "Teams with member device policies, and named device sharing with another account.",
          "新增团队与成员设备策略，以及与指定账号共享设备。"
        ],
        [
          "Shared devices can run read-only, in a temporary Linux container, or with explicit host trust.",
          "共享设备可选择只读、临时 Linux 容器隔离执行，或明确确认的宿主机信任执行。"
        ],
        [
          "Available in the website, CLI, API, SDK, MCP and the Zioon plugin.",
          "网站、CLI、API、SDK、MCP 与 Zioon 插件均已支持。"
        ]
      ]
    },
    {
      id: "2026-10-16-hosted",
      title: [
        "2026-10-16 · Official service at adc.zioon.tech",
        "2026-10-16 · 正式服务 adc.zioon.tech"
      ],
      items: [
        [
          "The official service moved to https://adc.zioon.tech. The root and www domains redirect there with paths preserved.",
          "正式服务迁移到 https://adc.zioon.tech，主域名与 www 域名保留路径跳转到此处。"
        ]
      ]
    },
    {
      id: "2026-10-13-release",
      title: ["2026-10-13 · Connector 0.1.3", "2026-10-13 · Connector 0.1.3"],
      items: [
        [
          "task.wait lets CLI, MCP and SDK callers follow a running task without resubmitting it.",
          "task.wait 让 CLI、MCP 与 SDK 调用方无需重新提交即可跟踪运行中的任务。"
        ]
      ]
    },
    {
      id: "2026-10-11-release",
      title: ["2026-10-11 · Connector 0.1.1", "2026-10-11 · Connector 0.1.1"],
      items: [
        [
          "Faster, more reliable Android UI actions and fresher tool lists in long MCP sessions.",
          "Android UI 操作更快更可靠，长时间 MCP 会话中的工具列表会及时刷新。"
        ],
        [
          "The console, connector logs and CLI show when a desktop update is available.",
          "控制台、连接器日志与 CLI 会提示可用的桌面端更新。"
        ]
      ]
    },
    {
      id: "2026-09-29-wake",
      title: ["2026-09-29 · Instant task wake-ups", "2026-09-29 · 任务即时唤醒"],
      items: [
        [
          "Devices receive work over an outbound WebSocket signal, with a 30-second fallback poll.",
          "设备通过出站 WebSocket 信号即时接收任务，并保留 30 秒兜底轮询。"
        ]
      ],
      note: [
        "Self-hosted: allow WebSocket upgrades on /api/v1/nodes/:nodeId/events.",
        "自部署：需允许 /api/v1/nodes/:nodeId/events 的 WebSocket 升级。"
      ]
    }
  ];
  return (
    <>
      <PageIntro
        eyebrow={copy("Project", "项目")}
        title={copy("Changelog", "更新日志")}
        description={copy(
          "User-visible changes to the official service and self-hosted releases. Update devices with adc update.",
          "官方服务与自部署版本中用户可感知的变化。使用 adc update 更新设备。"
        )}
      />
      {releases.map((release) => (
        <Section key={release.id} id={release.id} title={copy(...release.title)}>
          <ul className="docs-checklist">
            {release.items.map((item) => (
              <li key={item[0]}>{copy(...item)}</li>
            ))}
          </ul>
          {release.note ? <p className="docs-callout">{copy(...release.note)}</p> : null}
        </Section>
      ))}
      <Section id="known-limits" title={copy("Known limits", "已知限制")}>
        <p>
          {copy(
            "Windows Node and Android Node remain in testing. No signed desktop packages, unattended updates, quotas or external artifact storage yet. The Android APK uses development signing and is updated manually.",
            "Windows Node 和 Android Node 仍在测试阶段。目前还没有签名桌面安装包、无人值守更新、配额或外部产物存储。Android APK 使用开发签名，需要手动更新。"
          )}
        </p>
      </Section>
    </>
  );
}

function Roadmap() {
  const copy = useDocCopy();
  const stages: Array<{ state: Text; items: Text[] }> = [
    {
      state: ["Available now", "已提供"],
      items: [
        [
          "macOS and Linux connectors; Windows Node and Android Node in testing",
          "macOS 与 Linux 连接器；Windows Node 和 Android Node 处于测试阶段"
        ],
        [
          "Agent access, approvals, Activity and durable receipts",
          "Agent 授权、审批、活动记录与持久回执"
        ],
        ["Plugins, Skill, MCP OAuth, CLI and SDK", "插件、Skill、MCP OAuth、CLI 与 SDK"],
        ["Teams, member policies and named device sharing", "团队、成员策略与指定账号设备共享"],
        [
          "Official hosted service and the same app for self-hosting",
          "官方托管服务，以及可自部署的同一套应用"
        ]
      ]
    },
    {
      state: ["Next", "下一步"],
      items: [
        [
          "Validate Windows and Android compatibility and runtime reliability",
          "继续验证 Windows 与 Android 的兼容性和运行可靠性"
        ],
        ["Direct device-to-device transfer with a rate-limited relay", "设备间直连传输与限速中继"],
        ["Signed releases and unattended updates", "签名发布包与无人值守更新"],
        ["Keychain and keyring storage for device keys", "使用 Keychain / keyring 保存设备密钥"],
        ["Quotas, retention and external artifact storage", "配额、数据保留与外部产物存储"]
      ]
    },
    {
      state: ["Later", "之后"],
      items: [
        ["Enterprise SSO, SCIM and SIEM export", "企业 SSO、SCIM 与 SIEM 导出"],
        ["More local executors and device integrations", "更多本地执行器与设备集成"],
        ["Community tool plugins and Skills", "社区工具插件与 Skill"]
      ]
    }
  ];
  return (
    <>
      <PageIntro
        eyebrow={copy("Project", "项目")}
        title={copy("Roadmap", "路线图")}
        description={copy(
          "Planned items show direction, not shipped capability. The rest of the docs describe only what works today.",
          "计划中的条目代表方向，不代表已上线能力。其余文档只描述当前可用的功能。"
        )}
      />
      <div className="docs-roadmap">
        {stages.map((stage) => (
          <section key={stage.state[0]}>
            <span>{copy(...stage.state)}</span>
            <ul>
              {stage.items.map((item) => (
                <li key={item[0]}>{copy(...item)}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <Section
        id="device-possibilities"
        title={copy("The opportunity beyond one computer", "从一台电脑到更多设备能力")}
      >
        <p>
          {copy(
            "Different Nodes can contribute different environments to the same agent: code on a Mac, builds and GPU programs on Linux, local Windows tools and Android app actions. This enables device-spanning workflows when the relevant tools, permissions and dependencies exist.",
            "不同 Node 可以为同一个 Agent 提供不同环境：Mac 上的代码、Linux 上的构建与 GPU 程序、Windows 本地工具和 Android 应用操作。相关工具、权限和依赖齐全时，就可以组织跨设备工作流。"
          )}
        </p>
        <p>
          {copy(
            "Directions include shared lab machines, household devices and locally connected instruments. Television, watch, printer or other hardware support needs a concrete connector or local tool integration; these are future possibilities, not current support.",
            "可以继续探索实验室共享机器、家庭设备和本地连接的仪器。电视、手表、打印机等硬件需要具体连接器或本地工具适配，属于未来可能性，不是当前已经支持的功能。"
          )}
        </p>
        <p>
          <Link className="docs-text-link" to="/articles/cloud-agent-local-devices">
            {copy("Read the device-access motivation and examples", "阅读设备接入的需求与场景")}
          </Link>
        </p>
      </Section>
      <Section id="principles" title={copy("What will not change", "不会改变的原则")}>
        <ul className="docs-checklist">
          <li>
            {copy(
              "The device keeps the final say over what runs on it.",
              "设备对在其上运行的内容拥有最终决定权。"
            )}
          </li>
          <li>
            {copy("Hosted and self-hosted run the same product.", "托管与自部署始终是同一个产品。")}
          </li>
          <li>
            {copy(
              "Permissions and receipts stay independent of any single agent vendor.",
              "权限与回执不依赖任何单一 Agent 厂商。"
            )}
          </li>
        </ul>
      </Section>
    </>
  );
}

function Contributing() {
  const copy = useDocCopy();
  const areas: Array<[string, Text]> = [
    [
      "packages/protocol",
      ["Invocation, result and receipt schemas.", "调用、结果与回执的 Schema。"]
    ],
    ["packages/policy", ["Permission intersection and decisions.", "权限交集与策略决策。"]],
    ["apps/control-plane", ["Accounts, APIs, dispatch and audit.", "账号、API、任务派发与审计。"]],
    [
      "apps/node",
      ["Connector: local checks, tools and receipts.", "连接器：本地校验、工具执行与回执。"]
    ],
    ["apps/console", ["Website, docs and console.", "官网、文档与控制台。"]]
  ];
  return (
    <>
      <PageIntro
        eyebrow={copy("Project", "项目")}
        title={copy("Contributing", "参与贡献")}
        description={copy(
          "Focused fixes, tests, docs and integrations are welcome. Open an issue first for behavior changes or new public contracts.",
          "欢迎提交聚焦的修复、测试、文档与集成。行为变更或新增公开契约请先创建 Issue。"
        )}
      />
      <Section id="repository" title={copy("Repository map", "仓库结构")}>
        <dl className="docs-definitions docs-source-map">
          {areas.map(([path, text]) => (
            <div key={path}>
              <dt>{path}</dt>
              <dd>{copy(...text)}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section id="development" title={copy("Develop and verify", "开发与验证")}>
        <p>
          {copy(
            "Use Node.js 22+, pnpm 9+ and PostgreSQL 16+. Set a stable ADC_AUTH_SECRET.",
            "需要 Node.js 22+、pnpm 9+ 与 PostgreSQL 16+，并设置稳定的 ADC_AUTH_SECRET。"
          )}
        </p>
        <CodeBlock label={copy("Terminal", "终端")}>
          {`pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck && pnpm lint && pnpm test && pnpm build`}
        </CodeBlock>
        <ul className="docs-checklist">
          <li>
            {copy(
              "Protocol changes update the committed JSON Schema.",
              "协议变更需同步更新已提交的 JSON Schema。"
            )}
          </li>
          <li>
            {copy(
              "New tools that change things include idempotency and receipt tests.",
              "新增会产生修改的工具需包含幂等与回执测试。"
            )}
          </li>
          <li>
            {copy(
              "User-facing text ships in English and Simplified Chinese.",
              "用户可见文案需同时提供英文与简体中文。"
            )}
          </li>
        </ul>
      </Section>
      <nav className="docs-inline-links" aria-label={copy("Repository links", "仓库链接")}>
        <a href={`${repositoryUrl}/issues`} target="_blank" rel="noreferrer">
          {copy("Browse issues", "查看 Issues")}
        </a>
        <a href={`${repositoryUrl}/security`} target="_blank" rel="noreferrer">
          {copy("Report a vulnerability", "报告安全漏洞")}
        </a>
      </nav>
    </>
  );
}

function DocContent({ page }: { page: DocsPageId }) {
  switch (page) {
    case "overview":
      return <Introduction />;
    case "quickstart":
      return <Quickstart />;
    case "use-cases":
      return <Examples />;
    case "integrations":
      return <Integrations />;
    case "connector":
      return <ManageDevices />;
    case "collaboration":
      return <CollaborationDocs />;
    case "self-hosting":
      return <SelfHosting />;
    case "troubleshooting":
      return <Troubleshooting />;
    case "concepts":
      return <HowItWorks />;
    case "security":
      return <Security />;
    case "cli":
      return <CliReference />;
    case "tools":
      return <ToolReference />;
    case "api":
      return <ApiReference />;
    case "changelog":
      return <Changelog />;
    case "roadmap":
      return <Roadmap />;
    case "contributing":
      return <Contributing />;
  }
}

export function Documentation({ signedIn }: { signedIn: boolean }) {
  const copy = useDocCopy();
  const location = useLocation();
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [location.pathname, location.hash]);
  const page = docsPageId(location.pathname);
  const legacy = location.pathname.match(/^\/docs\/([^/]+)\/?$/)?.[1];
  if (!page && legacy && legacyDocsRedirects[legacy])
    return <Navigate to={legacyDocsRedirects[legacy]!} replace />;
  const currentIndex = page ? docsPages.findIndex((item) => item.id === page) : -1;
  const needle = query.trim().toLowerCase();
  const visiblePages = docsPages.filter((item) =>
    [...item.title, ...item.summary].some((value) => value.toLowerCase().includes(needle))
  );
  const previous = docsPages[currentIndex - 1];
  const next = docsPages[currentIndex + 1];
  return (
    <div className="docs-site">
      <PublicHeader signedIn={signedIn} />
      <div className="docs-layout">
        <aside className="docs-sidebar">
          <strong>{copy("Documentation", "文档")}</strong>
          <label className="docs-search">
            <Search size={14} />
            <input
              aria-label={copy("Search docs", "搜索文档")}
              placeholder={copy("Search docs", "搜索文档")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <nav aria-label={copy("Documentation", "文档")}>
            {docsGroups.map((group) => {
              const pages = visiblePages.filter((item) => item.group === group.id);
              if (!pages.length) return null;
              return (
                <div className="docs-nav-group" key={group.id}>
                  <span>{copy(...group.title)}</span>
                  {pages.map(({ id, title, icon: Icon }) => (
                    <Link
                      key={id}
                      className={page === id ? "active" : ""}
                      to={docsPath(id)}
                      aria-current={page === id ? "page" : undefined}
                    >
                      <Icon size={15} />
                      {copy(...title)}
                    </Link>
                  ))}
                </div>
              );
            })}
            {!visiblePages.length ? (
              <p className="docs-empty">{copy("No matching pages", "没有匹配的页面")}</p>
            ) : null}
          </nav>
        </aside>
        <main className="docs-main">
          {page ? (
            <>
              <article>
                <DocContent page={page} />
              </article>
              <nav
                className="docs-pagination"
                aria-label={copy("Previous and next", "上一页与下一页")}
              >
                {previous ? (
                  <Link to={docsPath(previous.id)}>
                    <ChevronLeft size={16} />
                    <span>
                      <small>{copy("Previous", "上一页")}</small>
                      {copy(...previous.title)}
                    </span>
                  </Link>
                ) : (
                  <span />
                )}
                {next ? (
                  <Link to={docsPath(next.id)}>
                    <span>
                      <small>{copy("Next", "下一页")}</small>
                      {copy(...next.title)}
                    </span>
                    <ChevronRight size={16} />
                  </Link>
                ) : null}
              </nav>
            </>
          ) : (
            <article>
              <PageIntro
                eyebrow="404"
                title={copy("Page not found", "页面不存在")}
                description={copy(
                  "This page may have moved. Start from the introduction.",
                  "该页面可能已移动，请从文档简介重新开始。"
                )}
              />
              <Link className="secondary" to="/docs">
                {copy("Go to the introduction", "前往文档简介")}
              </Link>
            </article>
          )}
        </main>
      </div>
      <PublicFooter />
    </div>
  );
}
