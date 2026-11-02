import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ToolArgsSchemas, ToolNameSchema } from "../../../packages/protocol/src/index.ts";
import { catalogs, LocaleProvider, zh, type Locale } from "./i18n.tsx";
import {
  Documentation,
  documentedTools,
  docsPageId,
  docsPages,
  windowsInstallExample
} from "./docs.tsx";

function renderDocs(path: string, locale: Locale): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, {
      initialLocale: locale,
      children: createElement(
        StaticRouter,
        { location: path },
        createElement(Documentation, { signedIn: false })
      )
    })
  );
}

describe("documentation navigation", () => {
  it("resolves every documented route and rejects unknown pages", () => {
    expect(docsPageId("/docs")).toBe("overview");
    expect(docsPageId("/docs/")).toBe("overview");
    for (const page of docsPages.slice(1)) {
      expect(docsPageId(`/docs/${page.id}`)).toBe(page.id);
    }
    expect(docsPageId("/docs/unknown")).toBeUndefined();
    expect(new Set(docsPages.map((page) => page.id)).size).toBe(docsPages.length);
    expect(docsPages.map((page) => page.id)).toEqual(
      expect.arrayContaining([
        "use-cases",
        "architecture",
        "api",
        "security",
        "operations",
        "contributing",
        "roadmap"
      ])
    );
    expect(new Set(docsPages.map((page) => page.group))).toEqual(
      new Set(["Start", "Understand", "Build", "Operate", "Project"])
    );
  });

  it("documents every protocol tool exactly once", () => {
    expect(new Set(documentedTools).size).toBe(documentedTools.length);
    expect([...documentedTools].sort()).toEqual([...ToolNameSchema.options].sort());
  });

  it("keeps both locale catalogs complete with matching placeholders", () => {
    const placeholders = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(catalogs.en[key]).toBeTruthy();
      expect(placeholders(catalogs.en[key]).sort()).toEqual(
        placeholders(catalogs["zh-CN"][key]).sort()
      );
    }
  });

  it("renders a valid PowerShell line continuation in the Windows install example", () => {
    expect(windowsInstallExample).toContain("-File $p `\n  -Url");
    expect(windowsInstallExample).not.toContain("-File $p \\`");
  });

  it.each(["en", "zh-CN"] as const)("publishes current service docs in %s", (locale) => {
    for (const page of docsPages) {
      const html = renderDocs(page.id === "overview" ? "/docs" : `/docs/${page.id}`, locale);
      expect(html).not.toMatch(/public preview|hosted preview|公网预览|托管预览|预发布版本记录/i);
      expect(html).toContain("赣ICP备2026025481号");
    }
    const quickstart = renderDocs("/docs/quickstart", locale);
    expect(quickstart).toContain("Windows");
    expect(quickstart).toContain("Android");
    expect(quickstart).toContain(locale === "en" ? "development signing" : "开发签名");
    expect(quickstart).toContain(locale === "en" ? "manual installation" : "手动完成");

    const security = renderDocs("/docs/security", locale);
    expect(security).toContain("Android Keystore");
    expect(security).toContain(locale === "en" ? "real inbox delivery" : "真实收件箱投递");
    const unverified = security.slice(security.indexOf(catalogs[locale]["Not yet certified"]));
    expect(unverified).toContain(catalogs[locale]["Real GitHub consent round trip"]);
    expect(unverified).not.toContain(
      catalogs[locale]["Hosted email verification and password recovery with real inbox delivery"]
    );

    const changelog = renderDocs("/docs/changelog", locale);
    expect(changelog).toContain("0.1.3");
    expect(changelog).toContain("0.1.1");
    expect(changelog).toContain("adc.zioon.tech");
  });

  it("provides a task.wait example accepted by the current protocol", () => {
    const html = renderDocs("/docs/tools", "en");
    const match = html.match(/--args &#x27;([^<]+?)&#x27; --json/);
    expect(match).not.toBeNull();
    const args = JSON.parse(match![1]!.replaceAll("&quot;", '"'));
    expect(ToolArgsSchemas["task.wait"].parse(args)).toEqual({
      jobId: "job_example",
      waitMs: 4000
    });
  });

  it.each(["en", "zh-CN"] as const)(
    "publishes install commands, ZIP and onboarding in %s",
    (locale) => {
      const html = renderDocs("/docs/integrations", locale);
      expect(html).toContain(
        "npx skills@latest add __ADC_PUBLIC_ORIGIN__ --skill agent-device-cloud"
      );
      expect(html).toContain("/downloads/skills/agent-device-cloud.zip");
      expect(html).toContain(locale === "en" ? "Help me get started with ADC" : "帮我开始使用 ADC");
      expect(html).toContain("--global");
      expect(html).toContain("references/");
    }
  );

  it.each(["en", "zh-CN"] as const)(
    "publishes plugin installation and real compatibility limits in %s",
    (locale) => {
      const html = renderDocs("/docs/integrations", locale);
      expect(html).toContain('id="plugins"');
      expect(html).toContain("/downloads/plugins/agent-device-cloud-marketplace.zip");
      expect(html).toContain("/downloads/plugins/agent-device-cloud-zion.zip");
      expect(html).toContain("/downloads/plugins/index.json");
      for (const host of [
        "Claude Code",
        "Codex",
        "Cursor",
        "Copilot",
        "Gemini CLI",
        "Factory Droid",
        "Pi",
        "Cline",
        "OpenCode"
      ])
        expect(html).toContain(host);
      expect(html).toContain("VALIDATION.md");
      expect(html).toContain(locale === "en" ? "not published yet" : "尚未发布");
      expect(html).toContain(locale === "en" ? "Plugin API v2" : "Plugin API v2");
    }
  );
});
