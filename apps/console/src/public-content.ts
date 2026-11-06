import type { Locale } from "./i18n.tsx";
import { showCloudFileTransfers } from "./file-transfer-visibility.ts";
import { adcPositioningArticle, remoteAccessComparisonArticle } from "./product-content.ts";
import { cloudAgentArticle } from "./cloud-agent-content.ts";
import { articleContent } from "./article-content.ts";

export interface LocalizedText {
  en: string;
  "zh-CN": string;
}

export interface PublicContentSection {
  id: string;
  title: LocalizedText;
  paragraphs: LocalizedText[];
  bullets?: LocalizedText[];
  code?: string;
  links?: Array<{ href: string; label: LocalizedText }>;
}

export type PublicContentKind = "Product update" | "Engineering" | "Guide" | "Use case" | "Policy";

export interface PublicContentEntry {
  path: string;
  kind: PublicContentKind;
  title: LocalizedText;
  summary: LocalizedText;
  publishedAt: string;
  updatedAt: string;
  readingMinutes: number;
  sections: PublicContentSection[];
  keywords: string[];
  listed: boolean;
  relatedPaths?: string[];
}

const text = (en: string, zh: string): LocalizedText => ({ en, "zh-CN": zh });

export function localize(value: LocalizedText, locale: Locale): string {
  return value[locale];
}

const latestRelease: PublicContentEntry = {
  path: "/updates/connector-0-1-8",
  kind: "Product update",
  title: text(
    "Android 0.2.7, CLI 0.1.8 and SDK 0.2.4: steadier screen operations",
    "Android 0.2.7、CLI 0.1.8 与 SDK 0.2.4：更稳定的屏幕操作"
  ),
  summary: text(
    "Reuse the connection, observe the result of each screen action, and recover from stale interface references without replaying uncertain actions.",
    "复用连接、获取屏幕操作后的界面，并在界面引用失效时恢复，避免重复执行结果不确定的操作。"
  ),
  publishedAt: "2026-11-06",
  updatedAt: "2026-11-06",
  readingMinutes: 3,
  keywords: ["ADC Android 0.2.7", "ADC CLI 0.1.8", "ADC SDK 0.2.4", "GUI automation"],
  listed: true,
  relatedPaths: ["/docs/android", "/docs/integrations", "/updates/connector-0-1-7"],
  sections: [
    {
      id: "screen-results",
      title: text("Observe the result of a screen action", "观察屏幕操作的结果"),
      paragraphs: [
        text(
          "Android 0.2.7 can return the resulting interface with a screen action when includeObservation is supported by the current tool catalog. A caller can use the returned snapshot for its next decision and avoid a separate interface-read request.",
          "Android 0.2.7 可在当前工具目录支持 includeObservation 时，随屏幕操作返回操作后的界面。调用方可使用返回的快照决定下一步，减少一次单独读取界面的请求。"
        ),
        text(
          "Each action still uses the current screen-control session and a fresh interface reference. Stale or ambiguous targets require a new observation; an unknown result must not be replayed as a new action.",
          "每个动作仍需使用当前屏幕控制会话与新界面引用。引用失效或目标存在歧义时需要重新观察；结果未知时不能作为新动作重复执行。"
        )
      ]
    },
    {
      id: "connection-recovery",
      title: text("Keep connections and recovery bounded", "复用连接并限制恢复耗时"),
      paragraphs: [
        text(
          "The Android Node reuses HTTP connections and limits DNS and request time. Updates and reconnection restore the Node and Accessibility binding. User takeover and screen-control expiry continue to stop new screen actions.",
          "Android Node 复用 HTTP 连接，并限制 DNS 与请求耗时。升级与重连会恢复 Node 和无障碍绑定。用户接管及屏幕控制到期仍会停止新的屏幕操作。"
        ),
        text(
          "A standalone Python GUI executor example is included in the ADC repository. It reuses one public MCP process, verifies bounded goals and supports supervision when a decision stalls. It keeps model time and tool time separate in its execution records.",
          "ADC 仓库提供独立 Python GUI 执行器示例，复用一个公开 MCP 进程，校验有界目标，并在决策停滞时支持监督。执行记录分别统计模型与工具耗时。"
        )
      ]
    },
    {
      id: "install",
      title: text("Update through the official channels", "通过官方渠道更新"),
      paragraphs: [
        text(
          "Update the CLI and Desktop Connector to 0.1.8. SDK 0.2.4 is distributed as a versioned HTTPS archive. Android uses its separate 0.2.7 APK channel and preserves the existing testing certificate for in-place upgrades. Android installation remains under the device owner's control.",
          "CLI 与 Desktop Connector 更新至 0.1.8。SDK 0.2.4 使用官方版本化 HTTPS 下载包。Android 通过独立的 0.2.7 APK 渠道更新，沿用现有测试签名以支持覆盖升级；安装仍由手机所有者确认。"
        )
      ],
      code: `adc update --check
adc update
adc task wait JOB_ID --wait 4000 --json
adc invoke task.wait --args '{"jobId":"JOB_ID","waitMs":4000}' --json`,
      links: [
        { href: "/downloads/sdk/manifest.json", label: text("SDK manifest", "SDK 下载清单") },
        {
          href: "/downloads/android/manifest.json",
          label: text("Android manifest", "Android 下载清单")
        }
      ]
    }
  ]
};

const invocationContextRelease: PublicContentEntry = {
  path: "/updates/connector-0-1-7",
  kind: "Product update",
  title: text(
    "CLI 0.1.7 and SDK 0.2.3: invocation intent and control sessions",
    "CLI 0.1.7 与 SDK 0.2.3：调用意图与控制会话"
  ),
  summary: text(
    "Describe the purpose of a tool call, keep screen actions in their authorized control session, and install the current CLI and SDK from official downloads.",
    "为工具调用说明用途，让屏幕操作关联已授权的控制会话，并从官方入口安装当前 CLI 与 SDK。"
  ),
  publishedAt: "2026-11-04",
  updatedAt: "2026-11-04",
  readingMinutes: 3,
  keywords: ["ADC CLI 0.1.7", "ADC SDK 0.2.3", "invocation intent", "screen control session"],
  listed: true,
  relatedPaths: ["/docs/integrations", "/docs/connector", "/updates/connector-0-1-6"],
  sections: [
    {
      id: "invocation-context",
      title: text("Keep the purpose with the invocation", "让用途随调用一起记录"),
      paragraphs: [
        text(
          "CLI 0.1.7 accepts --intent and --control-session. SDK 0.2.3 accepts intent and controlSessionId in buildInvocation. These fields follow the common invocation and receipt path used by HTTP, CLI, MCP and SDK.",
          "CLI 0.1.7 支持 --intent 与 --control-session；SDK 0.2.3 的 buildInvocation 支持 intent 与 controlSessionId。这些字段复用 HTTP、CLI、MCP 与 SDK 的统一调用和回执链路。"
        ),
        text(
          "Intent is a short, single-line description of the caller's purpose, not permission or evidence of success. Use the control session identifier returned by the device for actions that require it. Device policy, human approval and local permission still decide whether an action may run.",
          "意图是调用方对用途的一句简短描述，不代表授权，也不代表操作成功。需要控制会话的操作应使用设备返回的会话标识。设备策略、人工审批与本地权限仍决定操作能否执行。"
        )
      ],
      code: `adc invoke file.read --node NODE_ID \\
  --args '{"rootId":"ROOT_ID","path":"README.md"}' \\
  --intent 'Read the project setup instructions' --json`,
      links: [
        { href: "/docs/integrations", label: text("Skills, plugins and MCP", "Skill、插件与 MCP") }
      ]
    },
    {
      id: "install-client-tools",
      title: text("Install the current client packages", "安装当前客户端包"),
      paragraphs: [
        text(
          "Update an existing desktop CLI or Connector with adc update. The five desktop archives include their runtime. SDK downloads include compiled exports, TypeScript declarations and protocol dependencies; no private npm registry is needed. The official SDK manifest supplies the immutable package filename.",
          "已有桌面 CLI 或 Connector 使用 adc update 更新；五个平台归档自带运行时。SDK 下载包包含编译后的导出、TypeScript 声明与协议依赖，无需私有 npm 源；官方 SDK 清单提供带摘要的包名。"
        ),
        text(
          "Skill 0.4.2 and harness plugins 0.1.5 already carry the current integration instructions. CLI-backed plugins need CLI 0.1.7. Android Mobile Node remains on its separately versioned 0.2.3 release and is updated through the APK entry.",
          "Skill 0.4.2 与各 Harness 插件 0.1.5 已包含当前集成说明，依赖 CLI 的插件还需要 CLI 0.1.7。Android Mobile Node 使用独立版本 0.2.3，通过 APK 入口更新。"
        )
      ],
      code: `adc update --check
adc update
adc --version
SDK_FILE=$(curl -fsSL https://adc.zioon.tech/downloads/sdk/manifest.json |
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).archive.file))')
npm install "https://adc.zioon.tech/downloads/sdk/$SDK_FILE"`,
      links: [
        {
          href: "/downloads/sdk/manifest.json",
          label: text("SDK download manifest", "SDK 下载清单")
        }
      ]
    },
    {
      id: "follow-tasks",
      title: text("Follow the existing task", "继续跟踪已有任务"),
      paragraphs: [
        text(
          "Save the original invocationId or jobId and inspect that task after a wait ends. Intent does not make repeating a write safe. Use the same task and its receipt to determine the result.",
          "等待结束后，保留原有 invocationId 或 jobId 并查询同一个任务。补充意图不会让重复写入变得安全，应通过同一任务和回执确认结果。"
        )
      ],
      code: `adc task wait JOB_ID --wait 4000 --json
adc invoke task.wait --args '{"jobId":"JOB_ID","waitMs":4000}' --json`
    }
  ]
};

const previousRelease: PublicContentEntry = {
  path: "/updates/connector-0-1-6",
  kind: "Product update",
  title: text(
    "Connector 0.1.6: teams, device sharing and root sharing",
    "Connector 0.1.6：团队、设备共享与根目录共享"
  ),
  summary: text(
    "Share a device with a team or a named account, choose how shared work runs, and see which devices need an update.",
    "把设备共享给团队或指定账号，选择共享任务的执行方式，并直接看到哪些设备需要更新。"
  ),
  publishedAt: "2026-11-01",
  updatedAt: "2026-11-03",
  readingMinutes: 3,
  keywords: [
    "Agent Device Cloud 0.1.6",
    "ADC team sharing",
    "AI agent device sharing",
    "adc update"
  ],
  listed: true,
  relatedPaths: [
    "/articles/least-privilege-for-ai-agents",
    "/guides/first-device-to-first-tool-call",
    "/updates/connector-0-1-3"
  ],
  sections: [
    {
      id: "sharing",
      title: text("Share a device with people you choose", "把设备共享给你选择的人"),
      paragraphs: [
        text(
          "Connector 0.1.5 (October 31) added teams with per-member device policies and sharing with one named account. You pick exact folders, tools and approvals; the device keeps its owner, and every person still authorizes their own agent.",
          "10 月 31 日发布的 Connector 0.1.5 新增团队与成员设备策略，以及与指定账号共享设备。你可以精确选择目录、工具和审批规则；设备归属不变，每个人仍需为自己的 Agent 单独授权。"
        ),
        text(
          "Shared work runs read-only, in a temporary Linux container with no network, or directly on the host after you explicitly trust that person on the device.",
          "共享任务可以只读运行、在无网络的临时 Linux 容器中运行，或在你于设备本地明确信任对方后直接在宿主机上运行。"
        ),
        text(
          "For example, an engineer can share an existing project environment so a colleague's agent can inspect it. A team can reuse the same build machine without installing a separate agent on that target. Create a team and member policies, or send a named invitation; each recipient accepts and creates their own Agent access.",
          "例如，工程师可以共享现有项目环境，让同事的 Agent 查看；团队也可以复用同一台构建机器，不必在目标机器上再安装一个 Agent。你可以创建团队并设置成员策略，或者发送指定用户邀请；接收人接受后，需要创建自己的 Agent 授权。"
        ),
        text(
          "The modes have different effects: read-only does not run commands; isolated execution discards workspace changes after each call; trusted host work can change the real device. Choose the mode before granting tools. Linux isolation needs Docker with seccomp and a digest-pinned image, and cannot use a whole filesystem root.",
          "三种模式的结果不同：只读不运行命令；隔离执行在每次调用后丢弃工作区修改；宿主机信任模式可以修改真实设备。请先选择执行方式，再选择工具。Linux 隔离需要支持 seccomp 的 Docker 和固定摘要镜像，不能以整个文件系统根目录做快照。"
        )
      ],
      links: [
        {
          href: "/docs/collaboration",
          label: text("Configure teams and sharing", "配置团队与共享")
        }
      ]
    },
    {
      id: "root-sharing",
      title: text("Share a whole root with a team", "与团队共享整个根目录"),
      paragraphs: [
        text(
          "Connector 0.1.6 (November 1) lets a team share a device's exposed / or drive root, so you no longer need to add a separate project folder. Member policies and each Agent access still narrow it. External users continue to receive specific folders.",
          "11 月 1 日发布的 Connector 0.1.6 允许团队共享设备已开放的 / 或盘符根目录，无需再额外添加项目目录。成员策略和每份 Agent 授权仍会继续收窄范围；外部用户仍只能获得具体目录。"
        ),
        text(
          "The console now shows the current and available Connector version for every device, including offline ones. Root sharing needs Connector and CLI 0.1.6, SDK 0.2.2 or the updated plugins.",
          "控制台现在会显示每台设备当前与可更新的连接器版本，包括离线设备。根目录共享需要 Connector 与 CLI 0.1.6、SDK 0.2.2 或更新后的插件。"
        ),
        text(
          "Update the relevant Connectors first, then explicitly select the exposed root in team sharing. This release does not give every team member full device authority. Smaller project folders remain appropriate for isolated execution. Windows Node and Android Node are still in testing; Android does not provide the desktop root-sharing toolset.",
          "先更新需要共享的 Connector，再在团队共享中明确选择已开放根目录。本次更新不会自动给所有成员整台设备的权限。需要隔离执行时，仍应选择较小的项目目录。Windows Node 与 Android Node 仍在测试阶段；Android 不提供桌面根目录共享工具集。"
        )
      ],
      code: "adc update --check\nadc update\nadc-node status",
      links: [
        {
          href: "/docs/connector",
          label: text("Update and inspect the Connector", "更新与检查 Connector")
        }
      ]
    },
    {
      id: "follow-tasks",
      title: text("Follow shared work the same way", "用同样的方式跟踪共享任务"),
      paragraphs: [
        text(
          "Calls on shared devices return the same jobId, approval and receipt states as your own devices. If both you and the device owner require approval, both must approve before it runs.",
          "在共享设备上的调用，与自己设备上的调用一样返回 jobId、审批与回执状态。如果你和设备所有者都要求审批，必须双方都批准后才会执行。"
        ),
        text(
          "A wait ending does not mean the job failed. Keep the returned jobId and wait again; do not submit a replacement command. Revoking a share stops further access, but cannot undo changes already made in trusted host mode. Verify a read-only shared call before granting the tools for the real task.",
          "一次等待结束不代表任务失败。保留返回的 jobId 继续等待，不要重新提交替代命令。撤销共享会停止后续访问，但无法还原宿主机信任模式已产生的修改。开放真实任务所需工具前，应先验证一次共享只读调用。"
        )
      ],
      code: `adc invoke task.wait --args '{"jobId":"job_example","waitMs":4000}' --json`,
      links: [{ href: "/docs/api", label: text("Waiting and task states", "等待与任务状态") }]
    }
  ]
};

// Retain the historical transfer entry behind the same product visibility flag.
const transferRelease: PublicContentEntry = {
  path: "/updates/connector-0-1-4",
  kind: "Product update",
  title: text("Connector 0.1.4: direct file transfers", "Connector 0.1.4：文件直传"),
  summary: text("Copy files through private object storage.", "通过私有对象存储复制文件。"),
  publishedAt: "2026-10-19",
  updatedAt: "2026-10-19",
  readingMinutes: 2,
  keywords: ["ADC file.transfer", "Agent upload", "private object storage"],
  listed: true,
  relatedPaths: ["/updates/connector-0-1-3", "/guides/first-device-to-first-tool-call"],
  sections: [
    {
      id: "transfer",
      title: text("Transfer files with scoped authorization", "在授权范围内传输文件"),
      paragraphs: [
        text(
          "Connector 0.1.4 supports private object storage for file.transfer. Your administrator must enable the backend and both participating Connectors must be updated. ADC handles authorization, approval and task state; file bytes travel through storage.",
          "Connector 0.1.4 为 file.transfer 增加私有对象存储支持。管理员需启用后端，参与传输的 Connector 均需更新。ADC 处理授权、审批和任务状态，文件字节通过对象存储传输。"
        ),
        text(
          "adc transfer upload sends a local Agent file to an authorized device without registering a source Node. The destination verifies the file and commits it without overwriting an existing path. Keep the same arguments and idempotency key when resuming after approval.",
          "adc transfer upload 可将 Agent 本地文件上传至已授权设备，无需注册源 Node。目标校验文件后落盘，保留已有同名文件。审批后继续上传时，保持相同参数与幂等键。"
        )
      ],
      code: "adc update\nadc transfer upload --help"
    },
    {
      id: "wait",
      title: text("Follow the existing task", "跟踪已有任务"),
      paragraphs: [
        text(
          "An upload response contains the existing jobId. Use task.wait to follow the destination result. Upload completion alone does not mean the destination has committed the file.",
          "上传响应包含已有 jobId，使用 task.wait 跟踪目标结果。上传结束时，目标可能尚未完成文件落盘。"
        )
      ],
      code: `adc invoke task.wait --args '{"jobId":"job_example","waitMs":4000}' --json`
    },
    {
      id: "permissions",
      title: text("Check destination access", "检查目标权限"),
      paragraphs: [
        text(
          "Grant file.transfer and access to the destination folder. Device-to-device copies also require source access. Owner approval applies before transfer starts, and cancellation stops pending storage requests.",
          "授权需包含 file.transfer 和目标目录权限。设备间复制还需源目录权限。需要审批的传输在审批后开始，取消会停止待处理的存储请求。"
        )
      ]
    }
  ]
};

function estimateReadingMinutes(entry: PublicContentEntry): number {
  const english = entry.sections
    .flatMap((section) => [
      section.title.en,
      ...section.paragraphs.map((paragraph) => paragraph.en),
      ...(section.bullets?.map((bullet) => bullet.en) ?? []),
      section.code ?? ""
    ])
    .join(" ");
  const chinese = entry.sections
    .flatMap((section) => [
      section.title["zh-CN"],
      ...section.paragraphs.map((paragraph) => paragraph["zh-CN"]),
      ...(section.bullets?.map((bullet) => bullet["zh-CN"]) ?? [])
    ])
    .join("");
  return Math.max(
    1,
    Math.ceil(Math.max(english.split(/\s+/).filter(Boolean).length / 220, chinese.length / 400))
  );
}

const byPath = new Map(articleContent.map((entry) => [entry.path, entry]));
const olderContentOrder = [
  "/updates/connector-0-1-3",
  "/updates/connector-0-1-1",
  "/updates/public-knowledge-base",
  "/guides/first-device-to-first-tool-call",
  "/articles/least-privilege-for-ai-agents",
  "/articles/durable-receipts-for-agent-side-effects",
  "/updates/websocket-task-wakeups",
  "/articles/ai-agent-behind-nat"
];

export const publicContent: PublicContentEntry[] = [
  latestRelease,
  invocationContextRelease,
  previousRelease,
  cloudAgentArticle,
  adcPositioningArticle,
  ...(showCloudFileTransfers ? [transferRelease] : []),
  ...olderContentOrder.map((path) => byPath.get(path)!),
  remoteAccessComparisonArticle,
  ...["/use-cases/remote-local-development", "/privacy", "/telemetry"].map((path) =>
    byPath.get(path)!
  )
].map((entry) => ({ ...entry, readingMinutes: estimateReadingMinutes(entry) }));

export const listedPublicContent = publicContent.filter((entry) => entry.listed);

export function publicContentEntry(pathname: string): PublicContentEntry | undefined {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return publicContent.find((entry) => entry.path === normalized);
}

export function relatedPublicContent(entry: PublicContentEntry, limit = 3): PublicContentEntry[] {
  const candidates = listedPublicContent.filter((candidate) => candidate.path !== entry.path);
  const explicitlyRelated = (entry.relatedPaths ?? [])
    .map((path) => candidates.find((candidate) => candidate.path === path))
    .filter((candidate): candidate is PublicContentEntry => !!candidate);
  const sameKind = candidates.filter(
    (candidate) =>
      candidate.kind === entry.kind &&
      !explicitlyRelated.some((related) => related.path === candidate.path)
  );
  const remaining = candidates.filter(
    (candidate) =>
      !explicitlyRelated.some((related) => related.path === candidate.path) &&
      !sameKind.some((related) => related.path === candidate.path)
  );
  return [...explicitlyRelated, ...sameKind, ...remaining].slice(0, limit);
}
