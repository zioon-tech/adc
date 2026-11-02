import { useId, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { CodeBlock } from "./docs-code.tsx";
import { useI18n } from "./i18n.tsx";

export const pluginHosts = [
  { id: "zion", name: "Zion" },
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "cursor", name: "Cursor" },
  { id: "copilot", name: "Copilot / VS Code" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "droid", name: "Factory Droid" },
  { id: "pi", name: "Pi" },
  { id: "cline", name: "Cline SDK / CLI" },
  { id: "opencode", name: "OpenCode" },
  { id: "portable", name: "Other Agents" }
] as const;
export type PluginHost = (typeof pluginHosts)[number]["id"];

export function PluginInstallation({ host, origin }: { host: PluginHost; origin: string }) {
  const { locale } = useI18n();
  const copy = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const name = pluginHosts.find((entry) => entry.id === host)!.name;
  const marketplace = ["claude", "codex", "cursor", "droid"].includes(host);
  const commands: Partial<Record<PluginHost, string>> = {
    claude:
      "claude plugin marketplace add /absolute/path/adc-plugins\nclaude plugin install agent-device-cloud@adc-plugins",
    codex:
      "codex plugin marketplace add /absolute/path/adc-plugins\ncodex plugin add agent-device-cloud@adc-plugins",
    gemini: "gemini extensions install /absolute/path/adc-gemini",
    droid:
      "droid plugin marketplace add /absolute/path/adc-plugins\ndroid plugin install agent-device-cloud@adc-plugins",
    pi: "pi install /absolute/path/adc-pi",
    cline: `cline plugin install ${origin}/downloads/plugins/agent-device-cloud-cline.mjs`,
    opencode:
      "mkdir -p .opencode/plugins\ncp /absolute/path/adc-opencode/index.mjs .opencode/plugins/agent-device-cloud.js",
    copilot: JSON.stringify(
      {
        "chat.plugins.enabled": true,
        "chat.pluginLocations": { "/absolute/path/adc-copilot": true }
      },
      null,
      2
    )
  };
  const install: Record<PluginHost, [string, string]> = {
    zion: [
      "Download the ZIP and import it in Zion's plugin manager. Your Runtime needs Plugin API v2 and the host compatibility patch included in the package.",
      "下载 ZIP，在 Zion 插件管理器中导入。Runtime 需要 Plugin API v2，以及包内附带的宿主兼容补丁。"
    ],
    claude: [
      "Extract the complete archive into adc-plugins. Replace /absolute/path/adc-plugins with its actual path, then run:",
      "将完整包解压到 adc-plugins，把 /absolute/path/adc-plugins 替换为实际路径，然后运行："
    ],
    codex: [
      "Extract the complete archive into adc-plugins. Replace /absolute/path/adc-plugins with its actual path, then run:",
      "将完整包解压到 adc-plugins，把 /absolute/path/adc-plugins 替换为实际路径，然后运行："
    ],
    cursor: [
      "Extract the complete archive into adc-plugins and add it as a local or team plugin source supported by your Cursor version. The archive includes .cursor-plugin/marketplace.json and packages/cursor.",
      "将完整包解压到 adc-plugins，按当前 Cursor 版本支持的方式添加本地或团队插件源。包内包含 .cursor-plugin/marketplace.json 和 packages/cursor。"
    ],
    copilot: [
      "Extract the ZIP into adc-copilot. Open VS Code's user settings JSON and add the following, using the actual folder path:",
      "将 ZIP 解压到 adc-copilot。在 VS Code 用户设置 JSON 中添加以下配置，并替换为实际文件夹路径："
    ],
    gemini: [
      "Extract the ZIP into adc-gemini. Replace the path below with its actual path, run the command, then restart Gemini:",
      "将 ZIP 解压到 adc-gemini，替换下面的实际路径，运行命令后重启 Gemini："
    ],
    droid: [
      "Extract the complete archive into adc-plugins. Replace /absolute/path/adc-plugins with its actual path, then run:",
      "将完整包解压到 adc-plugins，把 /absolute/path/adc-plugins 替换为实际路径，然后运行："
    ],
    pi: [
      "Extract the ZIP into adc-pi. Replace the path below with its actual path and run:",
      "将 ZIP 解压到 adc-pi，替换下面的实际路径，然后运行："
    ],
    cline: [
      "Run this single-file installer in Cline CLI. It includes the getting-started guide:",
      "在 Cline CLI 运行这个单文件安装命令，接入指南已包含在内："
    ],
    opencode: [
      "Extract the ZIP into adc-opencode. In your project directory, replace the path below and run:",
      "将 ZIP 解压到 adc-opencode。在项目目录中替换下面的实际路径，然后运行："
    ],
    portable: [
      "Import the ZIP through your client's local Agent Plugins installer. For TRAE or a Cline editor extension, use the official Skill and MCP sections below.",
      "通过客户端的本地 Agent Plugins 安装器导入 ZIP。TRAE 或 Cline 编辑器扩展可使用下方的官方 Skill 与 MCP 接入方式。"
    ]
  };
  const connection: Partial<Record<PluginHost, [string, string]>> = {
    zion: [
      "Open a Zion conversation and choose ADC → Connect ADC. Sign in, choose your authorization, then select a device in the sidebar.",
      "打开 Zion 会话，选择「ADC → 连接 ADC」，登录并选择授权，再在侧栏中选择设备。"
    ],
    cline: [
      "Run /adc setup to check your CLI connection and follow the embedded setup guide. You confirm sign-in and authorization yourself.",
      "运行 /adc setup，检查 CLI 连接并跟随内嵌指南完成接入。登录与授权由你本人确认。"
    ]
  };
  const technical: Partial<Record<PluginHost, [string, string]>> = {
    zion: [
      "Install the complete package in your Runtime plugin root, apply host-compat.patch and enable dev.agent-device-cloud before restarting Runtime. See README.md for the exact steps. Device operations follow the Runtime execution policy.",
      "将完整包安装到 Runtime 插件目录，应用 host-compat.patch，启用 dev.agent-device-cloud 后重启 Runtime。具体步骤见 README.md；设备操作遵循 Runtime 执行策略。"
    ],
    cursor: [
      "Local plugin sources depend on your Cursor version and organization settings. ADC has not been listed in Cursor's public store.",
      "本地插件源取决于 Cursor 版本和组织设置。ADC 尚未上架 Cursor 公共商店。"
    ],
    copilot: [
      "Plugin availability depends on the VS Code/Copilot version and organization policy. Enable the plugin after updating settings; preserve your existing plugin paths.",
      "插件可用性取决于 VS Code/Copilot 版本和组织策略。更新设置后启用插件，并保留已有的插件路径配置。"
    ],
    pi: [
      "Requires Node.js 22+ and the ADC CLI. The setup Skill guides adc login and adc connect ACCESS. Pi confirms device operations interactively.",
      "需要 Node.js 22+ 与 ADC CLI。接入 Skill 会引导 adc login 和 adc connect ACCESS；Pi 会交互确认设备操作。"
    ],
    cline: [
      "Native plugins support Cline SDK/CLI/Kanban. Editor extensions use Skill plus MCP. Requires Node.js 22+ and the ADC CLI. Each session starts read-only; /adc mode execute enables operations within your ADC access.",
      "原生插件支持 Cline SDK/CLI/Kanban；编辑器扩展使用 Skill 加 MCP。需要 Node.js 22+ 与 ADC CLI。每个会话初始为只读，/adc mode execute 可在 ADC 授权范围内启用设备操作。"
    ],
    opencode: [
      "Requires Node.js 22+ and the ADC CLI. The setup Skill guides adc login and adc connect ACCESS. Device operations use the adc_execute permission prompt.",
      "需要 Node.js 22+ 与 ADC CLI。接入 Skill 会引导 adc login 和 adc connect ACCESS；设备操作使用 adc_execute 权限提示。"
    ],
    portable: [
      "The portable package includes Skills and MCP components. Supported components depend on your client version. ChatGPT can connect through its custom MCP interface.",
      "通用包包含 Skills 与 MCP 组件，支持范围取决于客户端版本。ChatGPT 可通过自定义 MCP 入口连接。"
    ]
  };
  return (
    <div className="plugin-installation">
      <header className="plugin-installation-heading">
        <h3>{host === "portable" ? copy("Other Agents", "其他 Agent") : name}</h3>
        <span>{copy("Plugin", "插件")} · v0.1.1</span>
      </header>
      <ol className="plugin-installation-steps">
        <li>
          <span aria-hidden="true">01</span>
          <div>
            <h4>{copy("Install the plugin", "安装插件")}</h4>
            <p>{copy(...install[host])}</p>
            {host !== "cline" ? (
              <a
                className="primary plugin-download"
                href={`${origin}/downloads/plugins/agent-device-cloud-${marketplace ? "marketplace" : host}.zip`}
                download
              >
                <Download size={15} />
                {marketplace
                  ? copy("Download complete bundle", "下载完整安装包")
                  : copy(
                      `Download ${name} ZIP`,
                      `下载 ${host === "portable" ? "通用插件" : name} ZIP`
                    )}
              </a>
            ) : null}
            {commands[host] ? (
              <CodeBlock label={host === "copilot" ? "settings.json" : copy("Terminal", "终端")}>
                {commands[host]!}
              </CodeBlock>
            ) : null}
            {host === "opencode" ? (
              <p className="plugin-installation-note">
                {copy(
                  "Install @opencode-ai/plugin >=1.19.0 in .opencode/package.json, add the package's skills/ folder to your Agent's Skill paths, then restart OpenCode.",
                  "在 .opencode/package.json 中安装 @opencode-ai/plugin >=1.19.0，将包内 skills/ 加入 Agent 的 Skill 路径，再重启 OpenCode。"
                )}
              </p>
            ) : null}
          </div>
        </li>
        <li>
          <span aria-hidden="true">02</span>
          <div>
            <h4>{copy("Connect your device", "连接设备，开始使用")}</h4>
            {connection[host] ? (
              <p>{copy(...connection[host]!)}</p>
            ) : (
              <p>
                {copy(
                  "Send this prompt in a new conversation. ADC will check your setup and guide sign-in, device connection and authorization.",
                  "在新会话中发送下面这句话。ADC 会检查环境，并引导登录、设备连接与授权。"
                )}
              </p>
            )}
            {host !== "zion" ? (
              <CodeBlock label={copy("First message", "首次使用提示")}>
                {host === "cline"
                  ? "/adc setup"
                  : copy(
                      "Help me start using ADC, connect my device and configure access.",
                      "帮我开始使用 ADC，引导我连接设备并配置授权。"
                    )}
              </CodeBlock>
            ) : null}
            <p className="plugin-installation-note">
              {copy(
                "Confirm sign-in and authorization yourself. Choose a device before sending your first task.",
                "登录与授权由你本人确认。选择设备后，就可以发送第一个任务。"
              )}
            </p>
          </div>
        </li>
      </ol>
      <details className="plugin-installation-details">
        <summary>
          {copy("Compatibility and manual installation", "兼容性与手动安装说明")}
          <ChevronDown size={15} />
        </summary>
        {technical[host] ? <p>{copy(...technical[host]!)}</p> : null}
        <p>
          {copy(
            "Each ZIP includes README.md and VALIDATION.md with installation steps and verified compatibility. npm packages and public vendor-store listings are not published yet.",
            "每个 ZIP 包含 README.md 和 VALIDATION.md，说明安装步骤及已验证兼容范围。目前尚未发布 npm 包或上架厂商公共商店。"
          )}
        </p>
        <a
          className="docs-text-link"
          href={`${origin}/downloads/plugins/agent-device-cloud-${host}.zip`}
          download
        >
          {copy(
            `Download ${name} package only`,
            `仅下载 ${host === "portable" ? "通用插件" : name} 包`
          )}
        </a>
      </details>
    </div>
  );
}

export function HarnessPlugins({ origin }: { origin: string }) {
  const { locale } = useI18n();
  const copy = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const [host, setHost] = useState<PluginHost>("zion");
  const id = useId();
  return (
    <section id="plugins" className="docs-section harness-plugins">
      <h2>{copy("Agent plugins", "Agent 插件")}</h2>
      <p>
        {copy(
          "Choose your Agent to see its installation steps and getting-started guide.",
          "选择你使用的 Agent，查看对应的安装步骤和接入指南。"
        )}
      </p>
      <div className="plugin-workspace">
        <fieldset className="plugin-hosts">
          <legend>{copy("Your Agent", "你的 Agent")}</legend>
          <div className="plugin-host-options">
            {pluginHosts.map((entry) => (
              <label key={entry.id} className={host === entry.id ? "selected" : undefined}>
                <input
                  type="radio"
                  name={`${id}-agent`}
                  value={entry.id}
                  checked={host === entry.id}
                  aria-controls={`${id}-installation`}
                  onChange={() => setHost(entry.id)}
                />
                <span>
                  {entry.id === "portable" ? copy("Other Agents", "其他 Agent") : entry.name}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div id={`${id}-installation`} className="plugin-installation-container">
          <PluginInstallation key={host} host={host} origin={origin} />
        </div>
      </div>
      <nav className="plugin-resources" aria-label={copy("Plugin resources", "插件资源")}>
        <a href={`${origin}/downloads/plugins/agent-device-cloud-marketplace.zip`} download>
          {copy("All plugin packages", "全部插件包")}
        </a>
        <a href={`${origin}/downloads/plugins/index.json`}>
          {copy("Versions and SHA-256", "版本与 SHA-256")}
        </a>
        <a href="#skill">{copy("Install as a Skill", "通过 Skill 安装")}</a>
      </nav>
    </section>
  );
}
