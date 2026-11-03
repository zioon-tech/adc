import { publicContent, type LocalizedText } from "./public-content.ts";
import type { Locale } from "./i18n.tsx";

export const SITE_NAME = "Agent Device Cloud";
export const PUBLIC_ORIGIN_PLACEHOLDER = "__ADC_PUBLIC_ORIGIN__";

export interface PublicRouteMetadata {
  path: string;
  title: LocalizedText;
  description: LocalizedText;
  kind: "website" | "article" | "documentation";
  keywords: string[];
  publishedAt?: string;
  updatedAt?: string;
  changeFrequency: "daily" | "weekly" | "monthly" | "yearly";
  priority: number;
}

const text = (en: string, zh: string): LocalizedText => ({ en, "zh-CN": zh });

const docs: Array<[string, LocalizedText, LocalizedText]> = [
  [
    "",
    text("Documentation", "文档"),
    text(
      "Connect cloud and personal agents to your real devices. Understand the device access layer, Node capabilities and platform status.",
      "把云端 Agent 和 Personal agent 连接到你的真实设备，了解设备接入层、Node 能力与平台阶段。"
    )
  ],
  [
    "quickstart",
    text("Quickstart", "快速上手"),
    text(
      "Pair a device, share a folder and make a first agent call in five steps.",
      "五步完成设备配对、目录共享与第一次 Agent 调用。"
    )
  ],
  [
    "use-cases",
    text("Examples", "示例"),
    text(
      "Requests you can give an agent and the smallest access each one needs.",
      "可以对 Agent 提出的需求，以及每个需求所需的最小授权。"
    )
  ],
  [
    "integrations",
    text("Connect your agent", "接入 Agent"),
    text(
      "Connect Claude Code, Codex, Cursor and other agents with plugins, Skill, MCP or CLI.",
      "通过插件、Skill、MCP 或 CLI 接入 Claude Code、Codex、Cursor 等 Agent。"
    )
  ],
  [
    "connector",
    text("Manage devices", "管理设备"),
    text(
      "Install macOS/Linux connectors or try Windows/Android Nodes in testing; manage local tools and updates.",
      "安装 macOS/Linux 连接器，或试用测试阶段的 Windows/Android Node，管理本地工具与更新。"
    )
  ],
  [
    "collaboration",
    text("Teams and sharing", "团队与共享"),
    text(
      "Share a device with a team or a named account with exact folders, tools and approvals.",
      "按精确的目录、工具与审批规则，与团队或指定账号共享设备。"
    )
  ],
  [
    "self-hosting",
    text("Self-hosting", "自部署"),
    text(
      "Deploy, verify, monitor, back up and upgrade Agent Device Cloud on your own server.",
      "在自己的服务器上部署、验证、监控、备份与升级 Agent Device Cloud。"
    )
  ],
  [
    "troubleshooting",
    text("Troubleshooting", "故障排查"),
    text(
      "Fix offline devices, missing folders, denied calls and unknown outcomes.",
      "解决设备离线、目录不可见、调用被拒与未知结果等问题。"
    )
  ],
  [
    "concepts",
    text("How ADC works", "ADC 如何工作"),
    text(
      "Components, permission layers and the life of an agent tool call.",
      "组件、权限层级，以及一次 Agent 工具调用的全过程。"
    )
  ],
  [
    "security",
    text("Security", "安全"),
    text(
      "Trust model, threats and controls, and what is verified today.",
      "信任模型、威胁与控制措施，以及当前的验证状态。"
    )
  ],
  [
    "cli",
    text("CLI reference", "命令行参考"),
    text("adc and adc-node commands by task.", "按任务整理的 adc 与 adc-node 命令。")
  ],
  [
    "tools",
    text("Tool reference", "工具参考"),
    text(
      "Built-in desktop, Android, file, command and task tools with their risk level.",
      "内置桌面、Android、文件、命令与任务工具及其风险级别。"
    )
  ],
  [
    "api",
    text("HTTP API and errors", "HTTP API 与错误"),
    text(
      "Authentication, main endpoints, invocation format and error codes.",
      "身份认证、主要接口、调用格式与错误码。"
    )
  ],
  [
    "changelog",
    text("Changelog", "更新日志"),
    text("Release history and upgrade notes.", "版本记录与升级说明。")
  ],
  [
    "roadmap",
    text("Roadmap", "路线图"),
    text("What is available today and what is planned.", "当前已提供与计划中的能力。")
  ],
  [
    "contributing",
    text("Contributing", "参与贡献"),
    text("Repository map, development and verification.", "仓库结构、开发与验证。")
  ]
];

const baseRoutes: PublicRouteMetadata[] = [
  {
    path: "/",
    title: text(
      "Agent Device Cloud | Let AI agents work on your own devices",
      "Agent Device Cloud | 让 AI Agent 在你自己的设备上干活"
    ),
    description: text(
      "Connect cloud and personal agents to macOS/Linux computers and Windows/Android Nodes in testing. ADC discovers devices, routes authorized calls and returns results; the devices execute.",
      "把云端 Agent 和 Personal agent 连接到 macOS/Linux 电脑，以及测试阶段的 Windows/Android Node。ADC 发现设备、路由已授权调用并返回结果，由设备执行。"
    ),
    kind: "website",
    keywords: [
      "AI agent device access",
      "remote AI agent",
      "MCP device connector",
      "secure agent tools"
    ],
    changeFrequency: "weekly",
    priority: 1
  },
  {
    path: "/updates",
    title: text("Updates and articles | Agent Device Cloud", "动态与文章 | Agent Device Cloud"),
    description: text(
      "Why ADC exists, how agents use distributed devices, and practical guides and release notes.",
      "了解 ADC 为什么存在、Agent 怎样使用分布在各处的设备，以及操作指南与版本变化。"
    ),
    kind: "website",
    keywords: ["Agent Device Cloud updates", "AI agent engineering", "MCP security"],
    changeFrequency: "weekly",
    priority: 0.8
  }
];

const docsRoutes: PublicRouteMetadata[] = docs.map(([slug, title, description]) => ({
  path: slug ? `/docs/${slug}` : "/docs",
  title: {
    en: `${title.en} | Agent Device Cloud`,
    "zh-CN": `${title["zh-CN"]} | Agent Device Cloud`
  },
  description,
  kind: "documentation",
  keywords: ["Agent Device Cloud documentation", "AI agent device access", title.en],
  changeFrequency: "monthly",
  priority: slug ? 0.65 : 0.8
}));

const contentRoutes: PublicRouteMetadata[] = publicContent.map((entry) => ({
  path: entry.path,
  title: {
    en: `${entry.title.en} | Agent Device Cloud`,
    "zh-CN": `${entry.title["zh-CN"]} | Agent Device Cloud`
  },
  description: entry.summary,
  kind: entry.kind === "Policy" ? "website" : "article",
  keywords: entry.keywords,
  publishedAt: entry.publishedAt,
  updatedAt: entry.updatedAt,
  changeFrequency: entry.kind === "Policy" ? "monthly" : "yearly",
  priority: entry.kind === "Policy" ? 0.5 : 0.75
}));

export const publicRoutes = [...baseRoutes, ...docsRoutes, ...contentRoutes];

export function normalizePublicPath(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

export function publicRouteMetadata(pathname: string): PublicRouteMetadata | undefined {
  const normalized = normalizePublicPath(pathname);
  return publicRoutes.find((route) => route.path === normalized);
}

export function localizedMetadata(
  metadata: PublicRouteMetadata,
  locale: Locale
): { title: string; description: string } {
  return {
    title: metadata.title[locale],
    description: metadata.description[locale]
  };
}

export function publicOrigin(): string {
  return typeof window === "undefined" ? PUBLIC_ORIGIN_PLACEHOLDER : window.location.origin;
}
