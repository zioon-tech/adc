import { useEffect, useState, type CSSProperties } from "react";
import { ArrowRight, Check, ShieldCheck, X } from "lucide-react";
import { Link } from "react-router-dom";
import { trackAnalytics } from "./analytics.tsx";
import { CodeBlock, docsOrigin, useDocCopy } from "./docs-code.tsx";
import { pluginHosts } from "./harness-plugins.tsx";
import { PublicFooter, PublicHeader } from "./public-header.tsx";
import { PlatformTestingNotice } from "./platform-support.tsx";

type SessionLine =
  | { kind: "prompt" | "reply"; text: [string, string] }
  | {
      kind: "call";
      tool: string;
      target: string;
      status: "ok" | "failed" | "approved";
      detail: [string, string];
    };

const session: SessionLine[] = [
  {
    kind: "prompt",
    text: [
      "Run the tests in ~/work/api and fix whatever fails.",
      "跑一下 ~/work/api 的测试，失败的地方帮我修好。"
    ]
  },
  {
    kind: "call",
    tool: "file.search",
    target: "~/work/api",
    status: "ok",
    detail: ["12 matches", "12 处匹配"]
  },
  {
    kind: "call",
    tool: "test.run",
    target: "~/work/api",
    status: "failed",
    detail: ["2 failed", "2 个失败"]
  },
  {
    kind: "call",
    tool: "file.patch",
    target: "src/auth.ts",
    status: "approved",
    detail: ["Approved by you", "你已批准"]
  },
  {
    kind: "call",
    tool: "test.run",
    target: "~/work/api",
    status: "ok",
    detail: ["48 passed", "48 个通过"]
  },
  {
    kind: "reply",
    text: [
      "Fixed the expiry check in src/auth.ts. All 48 tests pass.",
      "已修复 src/auth.ts 中的过期判断，48 个测试全部通过。"
    ]
  }
];

const examples: Array<{ prompt: [string, string]; tools: string; device: [string, string] }> = [
  {
    prompt: [
      "Run the tests in my repo and fix what fails.",
      "跑一下仓库里的测试，把失败的修好。"
    ],
    tools: "file.search · test.run · file.patch",
    device: ["Mac or Linux workstation", "Mac 或 Linux 工作机"]
  },
  {
    prompt: [
      "Find yesterday's 500 errors in the logs on my home server.",
      "在家里服务器的日志中找出昨天的 500 错误。"
    ],
    tools: "file.search · file.read",
    device: ["Linux server or NAS", "Linux 服务器或 NAS"]
  },
  {
    prompt: [
      "List my open pull requests with the GitHub MCP on my laptop.",
      "用笔记本上的 GitHub MCP 列出我未合并的 PR。"
    ],
    tools: "adc-node mcp add github",
    device: ["Token stays on the device", "令牌只保存在设备上"]
  },
  {
    prompt: [
      "Take a screenshot of my phone and open Settings.",
      "截一张手机屏幕，然后打开设置。"
    ],
    tools: "screen.capture · app.open",
    device: ["Android Node · in testing", "Android Node · 测试阶段"]
  }
];

const safety: Array<{ title: [string, string]; text: [string, string] }> = [
  {
    title: ["You choose the folders", "目录由你选择"],
    text: [
      "Agents see only the folders and tools you grant, on the devices you pick.",
      "Agent 只能使用你授权的设备、目录和工具。"
    ]
  },
  {
    title: ["No open ports", "无需开放端口"],
    text: [
      "The connector only dials out. No inbound port, VPN or SSH key on the device.",
      "连接器只向外连接，设备上无需开放端口、配置 VPN 或 SSH 密钥。"
    ]
  },
  {
    title: ["Approve before it acts", "执行前先审批"],
    text: [
      "Require your approval for file changes, commands or every operation.",
      "可以要求修改文件、运行命令或每一次操作前都由你批准。"
    ]
  },
  {
    title: ["Every action recorded", "每次操作都有记录"],
    text: [
      "Activity shows which agent asked, what ran where, and the device's receipt.",
      "活动记录会写明哪个 Agent 发起、在哪台设备执行了什么，以及设备回执。"
    ]
  }
];

const faq: Array<[[string, string], [string, string]]> = [
  [
    ["Hosted or self-hosted?", "托管还是自部署？"],
    [
      "Use the official hosted service at adc.zioon.tech, or run the same open-source application on your own server with Docker Compose. Both share the same permissions, approvals and device software.",
      "可以直接使用 adc.zioon.tech 官方托管服务，也可以用 Docker Compose 在自己的服务器上部署同一套开源应用。两者的权限、审批与设备端软件完全一致。"
    ]
  ],
  [
    ["Which devices are supported?", "支持哪些设备？"],
    [
      "macOS 13.5+ and glibc Linux (arm64/x64) provide available desktop connectors. Windows 10/11 x64 and the manually installed Android Mobile Node are in testing.",
      "macOS 13.5+ 与 glibc Linux（arm64/x64）提供当前可用的桌面连接器。Windows 10/11 x64 和手动安装的 Android Mobile Node 仍在测试阶段。"
    ]
  ],
  [
    ["Does ADC copy my files to the cloud?", "ADC 会把我的文件同步到云端吗？"],
    [
      "No. It never crawls or mirrors your disk. Only the result of a call you authorized passes through the service, where it is recorded for audit.",
      "不会。ADC 不会扫描或镜像你的磁盘，只有你授权的调用结果会经过服务端，并记录在审计中。"
    ]
  ],
  [
    ["How is this different from SSH or remote desktop?", "和 SSH、远程桌面有什么不同？"],
    [
      "Remote desktop is useful for visual assistance, and SSH is a mature way to run remote commands. ADC packages device discovery, tool calls, per-agent permissions, sharing and task records into one service for agents and applications. It can coexist with your existing remote access.",
      "远程桌面适合看着界面协助操作，SSH 是成熟的远程命令执行方式。ADC 则把设备发现、工具调用、每个 Agent 的权限、共享与任务记录组织成面向 Agent 和应用的统一服务，可以与现有远程访问方式共存。"
    ]
  ],
  [
    ["What happens when my laptop sleeps?", "电脑休眠时会怎样？"],
    [
      "New calls report the device as offline. The connector reconnects on its own when the device wakes.",
      "新的调用会提示设备离线。设备唤醒后，连接器会自动重新连接。"
    ]
  ]
];

function CallStatus({ status, detail }: { status: "ok" | "failed" | "approved"; detail: string }) {
  const Icon = status === "ok" ? Check : status === "failed" ? X : ShieldCheck;
  return (
    <span className={`session-status is-${status}`}>
      <Icon size={13} strokeWidth={2} aria-hidden="true" />
      {detail}
    </span>
  );
}

export function Landing({ signedIn }: { signedIn: boolean }) {
  const copy = useDocCopy();
  const [method, setMethod] = useState<"Plugin" | "Skill" | "MCP" | "CLI">("Plugin");
  const start = signedIn ? "/app" : "/login";
  const origin = docsOrigin();
  useEffect(() => {
    const sections = document.querySelectorAll<HTMLElement>(".landing [data-reveal]");
    if (!("IntersectionObserver" in window)) {
      sections.forEach((section) => section.classList.add("is-visible"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 }
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  const steps: Array<{ title: [string, string]; text: [string, string]; code: string }> = [
    {
      title: ["Install the connector", "安装连接器"],
      text: [
        "Run one command on macOS, Linux or Windows, or install the Android app. The console gives you the exact command.",
        "在 macOS、Linux 或 Windows 上运行一条命令，或在 Android 上安装 App。控制台会生成完整命令。"
      ],
      code: `curl -fsSL ${origin}/install.sh | sh -s -- \\\n  --url ${origin} --code PAIRING_CODE`
    },
    {
      title: ["Choose what to share", "选择开放范围"],
      text: [
        "Pick the folders and tools an agent may use, and which actions need your approval.",
        "选择 Agent 可以使用的目录和工具，以及哪些操作需要你批准。"
      ],
      code: copy(
        "~/work/api     Read & write\nApproval       Before changes or execution",
        "~/work/api     读写\n审批           修改或执行前审批"
      )
    },
    {
      title: ["Connect your agent", "接入你的 Agent"],
      text: [
        "Install the plugin or Skill, or add the MCP URL. Then ask in plain language.",
        "安装插件或 Skill，或添加 MCP 地址，然后直接用自然语言提出需求。"
      ],
      code: `npx skills@latest add ${origin} \\\n  --skill agent-device-cloud`
    }
  ];

  const methods: Record<typeof method, { text: [string, string]; label: string; code: string }> = {
    Plugin: {
      text: [
        "Download the plugin for your agent, then send this first message. It walks you through sign-in, device and access.",
        "下载对应 Agent 的插件，然后发送下面这句话。插件会带你完成登录、设备连接和授权。"
      ],
      label: copy("First message", "第一句话"),
      code: copy(
        "Help me start using ADC, connect my device and configure access.",
        "帮我开始使用 ADC，引导我连接设备并配置授权。"
      )
    },
    Skill: {
      text: [
        "Works with any agent that supports Skills. Install it, then ask your agent to get started with ADC.",
        "适用于任何支持 Skill 的 Agent。安装后，让 Agent 帮你开始使用 ADC。"
      ],
      label: copy("Terminal", "终端"),
      code: `npx skills@latest add ${origin} --skill agent-device-cloud`
    },
    MCP: {
      text: [
        "Add this URL to any MCP client with OAuth. Sign in and pick which authorization the client uses.",
        "把这个地址添加到支持 OAuth 的 MCP 客户端，登录后选择客户端使用哪份授权。"
      ],
      label: "MCP URL",
      code: `${origin}/mcp`
    },
    CLI: {
      text: [
        "For terminals, scripts and CI. Sign in once, connect an authorization, then call tools.",
        "适用于终端、脚本和 CI。登录一次、连接授权后即可调用工具。"
      ],
      label: copy("Terminal", "终端"),
      code: `adc login --url ${origin}
adc connect my-agent
adc invoke file.list --args '{"path":"/Users/me/work"}' --wait --json`
    }
  };

  return (
    <div className="landing">
      <PublicHeader signedIn={signedIn} />

      <main>
        <section className="home-hero">
          <div className="home-hero-copy">
            <h1>Agent Device Cloud</h1>
            <p className="home-hero-promise">
              {copy(
                "Connect your agent to the computers, servers and phones where the work happens.",
                "让你的 Agent 连接真正干活的电脑、服务器和手机。"
              )}
            </p>
            <p className="home-hero-detail">
              {copy(
                "Your agent plans the task. ADC connects it to the devices you authorize, routes tool calls and returns results. Use your agent from anywhere; run the work where your code, data and tools already are.",
                "Agent 负责理解和规划，ADC 连接你授权的设备、路由工具调用并返回结果。Agent 可以在任何地方运行，任务留在代码、数据和工具所在的设备上执行。"
              )}
            </p>
            <div className="hero-actions">
              <Link
                className="primary"
                to={start}
                onClick={() => trackAnalytics("primary_cta_selected", { placement: "hero" })}
              >
                {signedIn ? copy("Open console", "打开控制台") : copy("Connect a device", "连接设备")}
                <ArrowRight size={17} />
              </Link>
              <Link className="secondary" to="/docs/quickstart">
                {copy("Read the quickstart", "查看快速上手")}
              </Link>
              <a className="secondary" href={`${origin}/downloads/android/preview.apk`} download>
                {copy("Android APK · in testing", "下载 Android APK · 测试阶段")}
              </a>
            </div>
          </div>

          <figure
            className="home-session"
            aria-label={copy("Example agent session", "Agent 会话示例")}
          >
            <header>
              <span>Claude Code</span>
              <span className="stage-signal">
                <i />
                Work Mac · {copy("online", "在线")}
              </span>
            </header>
            <ol>
              {session.map((line, index) =>
                line.kind === "call" ? (
                  <li key={index} className="session-call" style={{ "--line": index } as CSSProperties}>
                    <code>{line.tool}</code>
                    <span className="session-target">{line.target}</span>
                    <CallStatus status={line.status} detail={copy(...line.detail)} />
                  </li>
                ) : (
                  <li
                    key={index}
                    className={`session-${line.kind}`}
                    style={{ "--line": index } as CSSProperties}
                  >
                    <span aria-hidden="true">{line.kind === "prompt" ? "›" : "✓"}</span>
                    <p>{copy(...line.text)}</p>
                  </li>
                )
              )}
            </ol>
            <figcaption>
              {copy(
                "Each call is checked against your rules, runs on Work Mac and is recorded in Activity.",
                "每次调用都会按你的规则检查，在 Work Mac 上执行，并写入活动记录。"
              )}
            </figcaption>
          </figure>
        </section>

        <section id="how-it-works" className="landing-section home-steps" data-reveal>
          <p className="eyebrow">{copy("How it works", "如何使用")}</p>
          <h2>{copy("Three steps to your first task.", "三步完成第一个任务。")}</h2>
          <ol>
            {steps.map((step, index) => (
              <li key={step.title[0]}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <h3>{copy(...step.title)}</h3>
                <p>{copy(...step.text)}</p>
                <pre>
                  <code>{step.code}</code>
                </pre>
              </li>
            ))}
          </ol>
          <PlatformTestingNotice />
        </section>

        <section id="examples" className="landing-band" data-reveal>
          <div className="landing-band-inner home-examples">
            <div>
              <p className="eyebrow">{copy("What agents can do", "Agent 能做什么")}</p>
              <h2>
                {copy(
                  "Ask in plain language. The work runs where your files already are.",
                  "直接用自然语言提出需求，任务在文件所在的设备上完成。"
                )}
              </h2>
              <Link className="text-link" to="/docs/use-cases">
                {copy("More examples", "更多示例")}
                <ArrowRight size={16} />
              </Link>
              <Link className="text-link" to="/articles/cloud-agent-local-devices">
                {copy("How a cloud agent reaches your devices", "云端 Agent 怎样操作你的设备")}
                <ArrowRight size={16} />
              </Link>
            </div>
            <ul>
              {examples.map((example) => (
                <li key={example.prompt[0]}>
                  <strong>“{copy(...example.prompt)}”</strong>
                  <span>
                    <code>{example.tools}</code>
                    <small>{copy(...example.device)}</small>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="connect" className="landing-section integration-section" data-reveal>
          <div>
            <p className="eyebrow">{copy("Works with your agent", "适配你的 Agent")}</p>
            <h2>{copy("Bring the agent you already use.", "继续用你熟悉的 Agent。")}</h2>
            <p>
              {copy(
                "Plugins with guided setup are available for:",
                "以下 Agent 提供带接入引导的插件："
              )}
            </p>
            <ul className="home-hosts">
              {pluginHosts
                .filter((host) => host.id !== "portable")
                .map((host) => (
                  <li key={host.id}>{host.name}</li>
                ))}
            </ul>
            <Link className="text-link" to="/docs/integrations">
              {copy("Integration guide", "接入指南")}
              <ArrowRight size={16} />
            </Link>
          </div>
          <div className="integration-demo">
            <div
              className="method-tabs"
              role="tablist"
              aria-label={copy("Connection method", "接入方式")}
            >
              {(["Plugin", "Skill", "MCP", "CLI"] as const).map((item) => (
                <button
                  key={item}
                  id={`tab-${item}`}
                  role="tab"
                  aria-selected={item === method}
                  aria-controls="method-panel"
                  onClick={() => setMethod(item)}
                >
                  {item === "Plugin" ? copy("Plugin", "插件") : item}
                </button>
              ))}
            </div>
            <div role="tabpanel" id="method-panel" aria-labelledby={`tab-${method}`} tabIndex={0}>
              <p>{copy(...methods[method].text)}</p>
              <CodeBlock key={method} label={methods[method].label}>
                {methods[method].code}
              </CodeBlock>
            </div>
          </div>
        </section>

        <section id="safety" className="landing-band" data-reveal>
          <div className="landing-band-inner home-safety">
            <p className="eyebrow">{copy("Safe by default", "默认安全")}</p>
            <h2>{copy("Your device keeps the final say.", "最终决定权在你的设备上。")}</h2>
            <ul>
              {safety.map((item) => (
                <li key={item.title[0]}>
                  <strong>{copy(...item.title)}</strong>
                  <p>{copy(...item.text)}</p>
                </li>
              ))}
            </ul>
            <p className="home-safety-note">
              {copy(
                "Full device access is not a sandbox — it runs with your OS user's permissions. Start with one folder.",
                "完整设备访问不是沙箱，它以当前系统用户的权限运行。建议从一个目录开始。"
              )}{" "}
              <Link to="/docs/security">{copy("Security model", "安全模型")}</Link>
            </p>
          </div>
        </section>

        <section className="landing-section faq-section" data-reveal>
          <p className="eyebrow">FAQ</p>
          <h2>{copy("Common questions", "常见问题")}</h2>
          <div>
            {faq.map(([question, answer]) => (
              <details key={question[0]}>
                <summary>{copy(...question)}</summary>
                <p>{copy(...answer)}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="final-cta" data-reveal>
          <h2>{copy("Start with one device and one folder.", "从一台设备、一个目录开始。")}</h2>
          <p>
            {copy(
              "Use the official hosted service, or self-host the same app.",
              "可以直接使用官方托管服务，也可以自行部署同一套应用。"
            )}
          </p>
          <div className="hero-actions">
            <Link
              className="primary"
              to={start}
              onClick={() => trackAnalytics("primary_cta_selected", { placement: "final" })}
            >
              {signedIn ? copy("Open console", "打开控制台") : copy("Connect a device", "连接设备")}
              <ArrowRight size={17} />
            </Link>
            <Link className="secondary" to="/docs">
              {copy("Read the docs", "阅读文档")}
            </Link>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
