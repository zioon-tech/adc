import { Link } from "react-router-dom";
import { CodeBlock, PageIntro, Section, useDocCopy } from "./docs-code.tsx";

export function CollaborationDocs() {
  const copy = useDocCopy();
  const modes: Array<[[string, string], [string, string]]> = [
    [
      ["Read only", "只读"],
      [
        "Structured folder and file reads only. Revoking stops further calls.",
        "仅结构化读取目录与文件。撤销后后续调用立即停止。"
      ]
    ],
    [
      ["Isolated execution", "隔离执行"],
      [
        "Each call runs in a temporary non-root Linux container with no network or host environment. Source is copied read-only and writes are discarded. Needs Linux Docker with seccomp and a digest-pinned image; it never falls back to the host.",
        "每次调用在临时的非 root Linux 容器中运行，无网络、无宿主机环境。源目录以只读副本挂载，写入会被丢弃。需要支持 seccomp 的 Linux Docker 与固定摘要镜像，校验失败不会回退到宿主机。"
      ]
    ],
    [
      ["Trusted host", "宿主机信任"],
      [
        "Runs directly on the device. Must be enabled locally and confirmed per person. Revoking cannot undo changes already made.",
        "直接在设备上执行。需在设备本地开启，并对每个人单独确认信任。撤销无法还原已经产生的修改。"
      ]
    ]
  ];
  return (
    <>
      <PageIntro
        eyebrow={copy("Teams and sharing", "团队与共享")}
        title={copy("Share a device with other people", "与他人共享设备")}
        description={copy(
          "Share a device with a team or one named account. You choose the exact folders, tools and approvals. The device keeps its owner, and each person still authorizes their own agent.",
          "可以把设备共享给团队或某个指定账号，并精确选择目录、工具与审批规则。设备归属不变，每个人仍需为自己的 Agent 单独授权。"
        )}
      />
      <Section id="start" title={copy("Share in four steps", "四步完成共享")}>
        <ol className="docs-numbered">
          <li>
            {copy(
              "Create a team under Teams and invite members by email. Send them the invitation link yourself; no email is sent automatically.",
              "在「团队」中创建团队，按邮箱邀请成员。邀请链接需要你自己发给对方，系统不会自动发送邮件。"
            )}
          </li>
          <li>
            {copy(
              "The member signs in with a verified account and accepts. Opening the link alone changes nothing.",
              "成员使用已验证的账号登录并接受邀请。仅打开链接不会产生任何变化。"
            )}
          </li>
          <li>
            {copy(
              "On Devices, choose Share for a device, pick the team or an external user, and select folders, tools and approvals.",
              "在「设备」页选择「共享」，指定团队或外部用户，再选择目录、工具和审批规则。"
            )}
          </li>
          <li>
            {copy(
              "In the team, set each member's device policy. Members start with no device access.",
              "在团队中为每位成员设置设备策略。普通成员默认没有设备访问权限。"
            )}
          </li>
        </ol>
        <p>
          <Link className="docs-text-link" to="/app/teams">
            {copy("Open Teams", "打开团队")}
          </Link>{" "}
          ·{" "}
          <Link className="docs-text-link" to="/app/sharing">
            {copy("Open Sharing", "打开共享")}
          </Link>
        </p>
      </Section>
      <Section id="modes" title={copy("Choose how shared work runs", "选择共享任务的执行方式")}>
        <dl className="docs-definitions docs-terms">
          {modes.map(([mode, text]) => (
            <div key={mode[0]}>
              <dt>{copy(...mode)}</dt>
              <dd>{copy(...text)}</dd>
            </div>
          ))}
        </dl>
        <CodeBlock label={copy("On the device", "在设备上")}>
          {`adc-node roots add /path/to/project --label Collaboration
adc-node sharing on --isolation docker --image 'REGISTRY/IMAGE@sha256:DIGEST'
adc-node sharing off`}
        </CodeBlock>
        <p>
          {copy(
            "Teams can share an exposed / or drive root with Connector 0.1.6+; isolated execution needs a smaller folder. External users always get specific folders.",
            "团队可以共享设备已开放的 / 或盘符根目录（需要 Connector 0.1.6+）；隔离执行需要选择较小的目录。外部用户只能获得具体目录。"
          )}
        </p>
      </Section>
      <Section id="cli" title={copy("From the CLI and SDK", "通过 CLI 与 SDK")}>
        <CodeBlock label="adc">
          {`adc team create --name Research
adc team invite TEAM_ID --email colleague@example.com
adc invitation accept INVITATION_ID --yes
adc team device-add TEAM_ID --node NODE_ID --scope scope.json
adc share create NODE_ID --email guest@example.com --scope scope.json --days 7
adc share revoke BINDING_ID --yes`}
        </CodeBlock>
        <CodeBlock label="scope.json">
          {JSON.stringify(
            {
              roots: [{ rootId: "root_EXACT_ID", path: "/path/to/project", writable: false }],
              allowedTools: ["file.list", "file.read", "file.search", "task.status", "task.wait"],
              execution: "read-only",
              approvalPolicy: "always",
              templateIds: []
            },
            null,
            2
          )}
        </CodeBlock>
        <p>
          {copy(
            "Use --account TEAM_ID on management commands to act in a team. The SDK uses client.withAccount(teamId); HTTP uses the X-ADC-Account header. When creating Agent access for a shared device in the SDK, pass resourceBindings: [{ nodeId, bindingId }].",
            "管理命令加 --account TEAM_ID 即可在团队中操作。SDK 使用 client.withAccount(teamId)，HTTP 使用 X-ADC-Account 请求头。在 SDK 中为共享设备创建 Agent 授权时，需要传入 resourceBindings: [{ nodeId, bindingId }]。"
          )}
        </p>
      </Section>
      <Section id="revocation" title={copy("Revoking and approvals", "撤销与审批")}>
        <ul className="docs-checklist">
          <li>
            {copy(
              "Changes apply to new calls immediately and to running work at its next lease renewal.",
              "修改会立即作用于新的调用，运行中的任务会在下次续租时生效。"
            )}
          </li>
          <li>
            {copy(
              "Widening a share needs the recipient to accept again; existing Agent access never grows on its own.",
              "扩大共享范围需要接收人重新接受，已有的 Agent 授权不会自动扩大。"
            )}
          </li>
          <li>
            {copy(
              "If both the requester and the device owner require approval, both must approve before the call runs.",
              "如果请求方和设备所有者都要求审批，必须双方都批准后调用才会执行。"
            )}
          </li>
          <li>
            {copy(
              "Members see only their own results. Device owners see what ran, not the requester's output.",
              "成员只能看到自己的执行结果；设备所有者能看到执行了什么，但看不到请求方的输出内容。"
            )}
          </li>
        </ul>
      </Section>
    </>
  );
}
