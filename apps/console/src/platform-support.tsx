import { useDocCopy } from "./docs-code.tsx";

export function PlatformTestingNotice() {
  const copy = useDocCopy();
  return (
    <p className="docs-callout platform-testing-notice">
      <strong>{copy("Windows Node and Android Node are in testing.", "Windows Node 和 Android Node 目前处于测试阶段。")}</strong>{" "}
      {copy(
        "They are available to try, but compatibility and reliability are still being validated. An available installer does not mean every system, phone model or operation has been verified.",
        "可以安装试用，但兼容性与运行可靠性仍在验证。提供安装入口不代表所有系统、手机型号或操作都已经验证通过。"
      )}
    </p>
  );
}

export function NodePlatforms() {
  const copy = useDocCopy();
  const platforms: Array<{
    name: string;
    stage: [string, string];
    environment: [string, string];
    capabilities: [string, string];
  }> = [
    {
      name: "macOS",
      stage: ["Available", "可用"],
      environment: ["macOS 13.5+, arm64/x64", "macOS 13.5+，arm64/x64"],
      capabilities: [
        "Files, Bash commands, command templates and registered local MCP tools.",
        "文件读写、Bash 命令、命令模板与已注册的本地 MCP 工具。"
      ]
    },
    {
      name: "Linux",
      stage: ["Available", "可用"],
      environment: ["glibc 2.28+, arm64/x64", "glibc 2.28+，arm64/x64"],
      capabilities: [
        "The same desktop tools on a development machine or server, using its installed dependencies and resources.",
        "在开发机或服务器上使用同一组桌面工具，利用其已安装的依赖与资源。"
      ]
    },
    {
      name: "Windows",
      stage: ["In testing", "测试阶段"],
      environment: ["Windows 10/11 x64", "Windows 10/11 x64"],
      capabilities: [
        "Desktop file tools, PowerShell commands, templates and local MCP tools. Installation and execution compatibility are still being tested.",
        "桌面文件工具、PowerShell 命令、命令模板与本地 MCP 工具。安装与执行兼容性仍在测试。"
      ]
    },
    {
      name: "Android",
      stage: ["In testing", "测试阶段"],
      environment: ["Manually installed Android Mobile Node APK", "手动安装 Android Mobile Node APK"],
      capabilities: [
        "Device state, screenshots, app launch and UI actions where supported and locally permitted; coverage varies by phone and OS.",
        "在具体机型支持且本地已授权时，读取设备状态、截屏、打开应用和执行界面操作；覆盖范围随机型和系统变化。"
      ]
    }
  ];
  return (
    <>
      <div className="table-wrap docs-table">
        <table>
          <thead>
            <tr>
              <th>{copy("Platform", "平台")}</th>
              <th>{copy("Stage", "阶段")}</th>
              <th>{copy("Requirements", "基本要求")}</th>
              <th>{copy("Device capabilities", "设备能力")}</th>
            </tr>
          </thead>
          <tbody>
            {platforms.map((platform) => (
              <tr key={platform.name}>
                <td>{platform.name}</td>
                <td>{copy(...platform.stage)}</td>
                <td>{copy(...platform.environment)}</td>
                <td>{copy(...platform.capabilities)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PlatformTestingNotice />
      <p>
        {copy(
          "A Node represents the capabilities its connector advertises. Operating systems do not all provide the same tools. Local permissions, installed software, online presence and the Agent grant still determine what can run.",
          "Node 代表连接器实际声明的能力，不代表各操作系统拥有相同工具。最终能运行什么，仍由本地权限、已安装软件、在线状态与 Agent 授权共同决定。"
        )}
      </p>
    </>
  );
}
