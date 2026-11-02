import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  HarnessPlugins,
  PluginInstallation,
  pluginHosts,
  type PluginHost
} from "./harness-plugins.tsx";
import { LocaleProvider, type Locale } from "./i18n.tsx";

const origin = "https://adc.zioon.tech";
function render(component: ReturnType<typeof createElement>, locale: Locale = "en") {
  return renderToStaticMarkup(
    createElement(LocaleProvider, { initialLocale: locale, children: component })
  );
}
function installation(host: PluginHost, locale: Locale = "en") {
  return render(createElement(PluginInstallation, { host, origin }), locale);
}

describe("plugin installation guide", () => {
  it.each(["en", "zh-CN"] as const)(
    "offers labeled Agent choices with one default in %s",
    (locale) => {
      const html = render(createElement(HarnessPlugins, { origin }), locale);
      expect(html.match(/type="radio"/g)).toHaveLength(pluginHosts.length);
      expect(html.match(/checked=""/g)).toHaveLength(1);
      expect(html).toMatch(/checked="" value="zion"/);
      expect(html).not.toContain("<select");
      const panel = html.match(/aria-controls="([^"]+)"/)![1]!;
      expect(html).toContain(`id="${panel}"`);
      expect(
        new Set([...html.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1])).size
      ).toBe(1);
      expect(html).toContain(locale === "en" ? "Your Agent" : "你的 Agent");
      expect(html).toContain("/downloads/plugins/index.json");
      expect(html).toContain('href="#skill"');
    }
  );

  it.each(["claude", "codex", "cursor", "droid"] as const)(
    "provides the complete marketplace archive for %s marketplace paths",
    (host) => {
      const html = installation(host);
      const firstDownload = html.match(/href="([^"]+)" download/);
      expect(firstDownload![1]).toBe(
        `${origin}/downloads/plugins/agent-device-cloud-marketplace.zip`
      );
      expect(html).toContain("adc-plugins");
      expect(html).toContain(`${origin}/downloads/plugins/agent-device-cloud-${host}.zip`);
    }
  );

  it.each(["gemini", "pi", "opencode", "copilot"] as const)(
    "pairs the %s ZIP with commands using its extracted root",
    (host) => {
      const html = installation(host);
      const firstDownload = html.match(/href="([^"]+)" download/);
      expect(firstDownload![1]).toBe(`${origin}/downloads/plugins/agent-device-cloud-${host}.zip`);
      expect(html).toContain(`/absolute/path/adc-${host}`);
      expect(html).not.toContain(`/absolute/path/adc-plugins/packages/${host}`);
      expect(html).toContain('aria-label="Copy content"');
      expect(html).toContain('aria-live="polite"');
    }
  );

  it("uses the HTTPS Cline installer with its embedded onboarding command", () => {
    const html = installation("cline");
    expect(html).toContain(
      `cline plugin install ${origin}/downloads/plugins/agent-device-cloud-cline.mjs`
    );
    expect(html).toContain("/adc setup");
    expect(html).toContain("SDK/CLI/Kanban");
    expect(html).toContain("read-only");
    expect(html).not.toContain("/absolute/path/");
  });

  it("documents the current VS Code local plugin setting and OpenCode dependency", () => {
    expect(installation("copilot")).toContain("&quot;chat.pluginLocations&quot;");
    expect(installation("copilot")).not.toContain("chat.plugins.paths");
    expect(installation("opencode")).toContain("@opencode-ai/plugin &gt;=1.19.0");
    expect(installation("opencode")).toContain("mkdir -p .opencode/plugins");
  });

  it.each(pluginHosts)(
    "keeps onboarding and collapsed compatibility details for $name",
    ({ id }) => {
      for (const locale of ["en", "zh-CN"] as const) {
        const html = installation(id, locale);
        expect(html).toContain('class="plugin-installation-steps"');
        expect(html).toContain(locale === "en" ? "Install the plugin" : "安装插件");
        expect(html).toContain(locale === "en" ? "Connect your device" : "连接设备，开始使用");
        expect(html).toContain('<details class="plugin-installation-details">');
        expect(html).toContain("README.md");
        expect(html).toContain("VALIDATION.md");
        expect(html).toContain(locale === "en" ? "not published yet" : "尚未发布");
        expect(html).toContain(
          locale === "en" ? "Confirm sign-in and authorization yourself" : "登录与授权由你本人确认"
        );
      }
    }
  );
});
