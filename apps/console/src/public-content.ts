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
  path: "/updates/connector-0-1-6",
  kind: "Product update",
  title: text("Connector 0.1.6: teams, device sharing and root sharing", "Connector 0.1.6：团队、设备共享与根目录共享"),
  summary: text(
    "Share a device with a team or a named account, choose how shared work runs, and see which devices need an update.",
    "把设备共享给团队或指定账号，选择共享任务的执行方式，并直接看到哪些设备需要更新。"
  ),
  publishedAt: "2026-11-01",
  updatedAt: "2026-11-03",
  readingMinutes: 3,
  keywords: ["Agent Device Cloud 0.1.6", "ADC team sharing", "AI agent device sharing", "adc update"],
  listed: true,
  relatedPaths: ["/articles/least-privilege-for-ai-agents", "/guides/first-device-to-first-tool-call", "/updates/connector-0-1-3"],
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
      links: [{ href: "/docs/collaboration", label: text("Configure teams and sharing", "配置团队与共享") }]
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
      links: [{ href: "/docs/connector", label: text("Update and inspect the Connector", "更新与检查 Connector") }]
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
        text("An upload response contains the existing jobId. Use task.wait to follow the destination result. Upload completion alone does not mean the destination has committed the file.", "上传响应包含已有 jobId，使用 task.wait 跟踪目标结果。上传结束时，目标可能尚未完成文件落盘。")
      ],
      code: `adc invoke task.wait --args '{"jobId":"job_example","waitMs":4000}' --json`
    },
    {
      id: "permissions",
      title: text("Check destination access", "检查目标权限"),
      paragraphs: [
        text("Grant file.transfer and access to the destination folder. Device-to-device copies also require source access. Owner approval applies before transfer starts, and cancellation stops pending storage requests.", "授权需包含 file.transfer 和目标目录权限。设备间复制还需源目录权限。需要审批的传输在审批后开始，取消会停止待处理的存储请求。")
      ]
    }
  ]
};

function estimateReadingMinutes(entry: PublicContentEntry): number {
  const english = entry.sections.flatMap((section) => [
    section.title.en,
    ...section.paragraphs.map((paragraph) => paragraph.en),
    ...(section.bullets?.map((bullet) => bullet.en) ?? []),
    section.code ?? ""
  ]).join(" ");
  const chinese = entry.sections.flatMap((section) => [
    section.title["zh-CN"],
    ...section.paragraphs.map((paragraph) => paragraph["zh-CN"]),
    ...(section.bullets?.map((bullet) => bullet["zh-CN"]) ?? [])
  ]).join("");
  return Math.max(1, Math.ceil(Math.max(english.split(/\s+/).filter(Boolean).length / 220, chinese.length / 400)));
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
  cloudAgentArticle,
  adcPositioningArticle,
  ...(showCloudFileTransfers ? [transferRelease] : []),
  ...olderContentOrder.map((path) => byPath.get(path)!),
  remoteAccessComparisonArticle,
  ...["/use-cases/remote-local-development", "/privacy", "/telemetry"].map((path) => byPath.get(path)!)
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
  const sameKind = candidates.filter((candidate) =>
    candidate.kind === entry.kind && !explicitlyRelated.some((related) => related.path === candidate.path)
  );
  const remaining = candidates.filter((candidate) =>
    !explicitlyRelated.some((related) => related.path === candidate.path) &&
    !sameKind.some((related) => related.path === candidate.path)
  );
  return [...explicitlyRelated, ...sameKind, ...remaining].slice(0, limit);
}
