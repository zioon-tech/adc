import { Link } from "react-router-dom";
import { useI18n } from "./i18n.tsx";
import { CodeBlock } from "./docs-code.tsx";

export function CollaborationDocs() {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  return <article className="docs-article">
    <h1>{zh ? "团队与设备共享" : "Teams and device sharing"}</h1>
    <p>{zh ? "团队策略决定成员可以使用哪些设备；外部共享将一台设备的指定目录和工具授权给指定账号。Connector 仍只向外连接，执行留在设备上。" : "Team policies govern members' devices. External sharing gives a named account selected folders and tools on one device. Connectors remain outbound; execution stays on the device."}</p>
    <h2>{zh ? "开始协作" : "Start collaborating"}</h2>
    <ol>
      <li>{zh ? "在团队页创建团队，按邮箱邀请成员，并将邀请链接发给接收人。邀请不会自动发送邮件。" : "Create a team, invite a member by email and send the invitation link. Email is not sent automatically."}</li>
      <li>{zh ? "成员用已验证的账号登录，核对并接受邀请。仅打开链接不会接受。" : "The recipient signs in with a verified account, reviews and accepts. Opening the link does not accept."}</li>
      <li>{zh ? "在设备页选择共享，加入自己管理的团队，或指定外部用户。选择精确目录、工具和审批要求。" : "Share a device with a team you administer or an external user. Select exact folders, tools and approvals."}</li>
      <li>{zh ? "切换到团队，编辑每个成员的设备策略。普通成员默认没有设备访问。" : "Switch to the team and assign each member's device policy. Ordinary members start without device access."}</li>
      <li>{zh ? "每个人为自己的 Agent 创建授权，再从 CLI、MCP、SDK 或 Zioon 连接。接受共享不会扩大已有 Agent 权限。" : "Each person authorizes their own Agent and connects from CLI, MCP, SDK or Zioon. Accepting sharing does not expand an existing Agent grant."}</li>
    </ol>
    <p><Link to="/app/teams">{zh ? "团队与成员" : "Teams and members"}</Link> · <Link to="/app/sharing">{zh ? "共享与邀请" : "Sharing and invitations"}</Link></p>
    <h2>{zh ? "选择执行方式" : "Choose execution mode"}</h2>
    <table><thead><tr><th>{zh ? "模式" : "Mode"}</th><th>{zh ? "行为与撤销" : "Behavior and revocation"}</th></tr></thead><tbody>
      <tr><td>{zh ? "只读" : "Read only"}</td><td>{zh ? "仅结构化目录与文件读取；撤销会停止后续调用。" : "Structured file and folder reads only. Revocation stops subsequent calls."}</td></tr>
      <tr><td>{zh ? "隔离执行" : "Isolated execution"}</td><td>{zh ? "每次调用使用临时非 root Linux 容器，无网络和宿主机环境。源目录为只读副本，修改不回写；保留限额内的命令日志产物。撤销或租约到期会回收整个容器。" : "Each call uses a temporary non-root Linux container with no network or host environment. Source is copied read-only; writes are discarded and bounded command-log artifacts retained. Revocation or lease expiry tears down the whole container."}</td></tr>
      <tr><td>{zh ? "宿主机信任访问" : "Trusted host"}</td><td>{zh ? "须在设备本地启用并明确确认信任。撤销 ADC 无法清除此人已建立的其他渠道或宿主机修改。" : "Requires local enablement and explicit trust acknowledgement. ADC revocation cannot undo host changes or other access already established."}</td></tr>
    </tbody></table>
    <p>{zh ? "团队可以选择设备已开放的 / 或盘符根目录，成员策略和 Agent 授权仍独立限制访问。根目录共享需要 Connector 0.1.6 或更高版本；隔离执行请使用较小目录。外部用户共享仍使用具体目录。" : "Teams can select an exposed / or drive root while member policies and Agent grants continue to limit access. Root sharing requires Connector 0.1.6+. Isolated execution uses smaller folders; external user sharing uses selected folders."}</p>
    <CodeBlock label="Device setup">{`adc-node roots add /path/to/project --label Collaboration
adc-node sharing on --isolation docker --image 'REGISTRY/IMAGE@sha256:DIGEST'
adc-node sharing off`}</CodeBlock>
    <p>{zh ? "隔离要求可用的 Linux Docker、seccomp、固定摘要镜像、Node 24 与 Bash。验证失败不会回退到宿主机。旧 Connector 请先更新。平台服务器和托管资源不能当作实体设备共享。" : "Isolation requires Linux Docker, seccomp, a digest-pinned image, Node 24 and Bash. Verification failure does not fall back to host execution. Update old Connectors first. Platform servers and managed resources cannot be shared as physical devices."}</p>
    <h2>CLI / SDK / API</h2>
    <p>{zh ? "设备页显示当前与可更新的 Connector 版本，离线设备也保留更新提示。点击版本提示可复制更新命令；版本无法确认时会明确显示待确认，不会把旧版本当作最新。" : "The device page shows current and available Connector versions, including offline devices. Select an update badge to copy the update command. Unknown versions are explicitly marked rather than treated as current."}</p>
    <CodeBlock label="Collaboration CLI">{`adc account list --json
adc team create --name Research --json
adc team invite TEAM_ID --email colleague@example.com --json
adc invitation accept INVITATION_ID --yes --json
adc team device-add TEAM_ID --node NODE_ID --scope scope.json
adc access create --account TEAM_ID --name Analyst --devices NODE_ID --capabilities read
adc share create NODE_ID --email guest@example.com --scope scope.json --days 7
adc share revoke BINDING_ID --yes`}</CodeBlock>
    <CodeBlock label="scope.json">{JSON.stringify({ roots: [{ rootId: "root_EXACT_ID", path: "/path/to/project", writable: false }], allowedTools: ["file.read", "file.list", "file.search", "device.list", "task.status", "task.result", "task.wait", "task.cancel"], execution: "read-only", approvalPolicy: "always", templateIds: [] }, null, 2)}</CodeBlock>
    <p>{zh ? "账号管理使用 adc login；实际工具调用使用单独的 adc connect Agent 授权。SDK 用 client.withAccount(teamId) 选择团队；HTTP 用 X-ADC-Account。Agent Token 绑定自己的授权。" : "Use adc login for management and a separate adc connect Agent authorization for tools. SDK selects teams with client.withAccount(teamId); HTTP uses X-ADC-Account. Agent tokens stay bound to their grant."}</p>
    <p>{zh ? "SDK 提供 accounts、createTeam、teamMembers、teamDevices、inviteTeamMember、updateTeamMember、linkTeamDevice、inviteDeviceShare、respondInvitation、deviceShares、updateDeviceShare、endDeviceShare。创建共享设备 Agent 授权时显式传 resourceBindings: [{nodeId, bindingId}]。" : "SDK exposes accounts, createTeam, teamMembers, teamDevices, inviteTeamMember, updateTeamMember, linkTeamDevice, inviteDeviceShare, respondInvitation, deviceShares, updateDeviceShare and endDeviceShare. Pass resourceBindings: [{nodeId, bindingId}] when creating shared-device Agent access."}</p>
    <h2>{zh ? "撤销、审批与历史" : "Revocation, approval and history"}</h2>
    <p>{zh ? "新请求立即复核，活动任务续租时复核。共享扩大需原接收人再次接受，已有 Agent 保持原范围。请求人和设备所有者的审批独立，全部满足后才能派发。成员只能查看自己的执行结果；设备所有者查看活动事实。409 冲突请刷新核对，未知结果不能重新发起副作用。" : "New calls recheck access and active work rechecks on lease renewal. Wider sharing requires the same recipient's acceptance; existing Agent scopes remain fixed. Requester and resource owner approvals are independent and all must be satisfied before dispatch. Members see their own results; owners see activity facts. Refresh on 409 conflicts; never resubmit side effects after unknown outcome."}</p>
  </article>;
}
