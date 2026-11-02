import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { analyticsEventForRequest, analyticsPath, trackAnalytics } from "./analytics.tsx";
import { LocaleProvider, type Locale } from "./i18n.tsx";
import { Landing } from "./landing.tsx";
import { listedPublicContent, publicContent, relatedPublicContent } from "./public-content.ts";
import { icpFiling } from "./public-header.tsx";
import { PublicContentRoute } from "./public-site.tsx";
import { publicRouteMetadata, publicRoutes } from "./site-metadata.ts";

function renderPublicPage(path: string, locale: Locale): string {
  const component = path === "/" ? Landing : PublicContentRoute;
  return renderToStaticMarkup(
    createElement(LocaleProvider, {
      initialLocale: locale,
      children: createElement(
        StaticRouter,
        { location: path },
        createElement(component, { signedIn: false })
      )
    })
  );
}

describe("public site metadata", () => {
  it("defines one indexable entry for every public route", () => {
    const paths = publicRoutes.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain("/");
    expect(paths).toContain("/docs/security");
    expect(paths).toContain("/docs/api");
    expect(paths).toContain("/docs/operations");
    expect(paths).toContain("/docs/contributing");
    expect(paths).toContain("/updates");
    expect(paths).toContain("/guides/first-device-to-first-tool-call");
    expect(listedPublicContent.length).toBeGreaterThanOrEqual(8);
    for (const entry of publicContent) {
      expect(publicRouteMetadata(entry.path)).toMatchObject({ path: entry.path });
      expect(entry.sections.length).toBeGreaterThanOrEqual(3);
      expect(new Set(entry.sections.map((section) => section.id)).size).toBe(entry.sections.length);
      expect(relatedPublicContent(entry).every((related) => related.path !== entry.path)).toBe(
        true
      );
    }
    expect(publicRouteMetadata("/privacy")?.kind).toBe("website");
    expect(publicRouteMetadata("/articles/ai-agent-behind-nat")?.kind).toBe("article");
    expect(publicRouteMetadata("/app")).toBeUndefined();
    expect(publicRouteMetadata("/login")).toBeUndefined();
    expect(analyticsPath("/articles/ai-agent-behind-nat/")).toBe("/articles/ai-agent-behind-nat");
    expect(analyticsPath("/app/devices")).toBe("/app/devices");
    expect(analyticsPath("/app/devices/private-id")).toBeUndefined();
    expect(analyticsPath("/unknown/private-value")).toBeUndefined();
  });

  it("maps only coarse successful product actions to analytics events", () => {
    expect(analyticsEventForRequest("/api/auth/sign-up/email", "POST")).toBe("account_registered");
    expect(analyticsEventForRequest("/api/v1/pairing-codes", "POST")).toBe("pairing_code_created");
    expect(analyticsEventForRequest("/api/v1/grants", "POST")).toBe("agent_access_created");
    expect(analyticsEventForRequest("/api/v1/grants/grant_example", "PATCH")).toBeUndefined();
    expect(analyticsEventForRequest("/api/v1/invocations", "POST")).toBeUndefined();
    expect(() => trackAnalytics("primary_cta_selected", { placement: "test" })).not.toThrow();
  });

  it("publishes the approved ICP filing in the public footer", () => {
    expect(icpFiling).toEqual({
      number: "赣ICP备2026025481号",
      url: "https://beian.miit.gov.cn/"
    });
  });

  it.each(["en", "zh-CN"] as const)("renders official service positioning in %s", (locale) => {
    for (const path of ["/", "/updates", ...publicContent.map((entry) => entry.path)]) {
      const html = renderPublicPage(path, locale);
      expect(html).not.toMatch(/public preview|hosted preview|公网预览|托管预览|nip\.io/i);
      expect(html).toContain("赣ICP备2026025481号");
    }
    const landing = renderPublicPage("/", locale);
    expect(landing).toContain(locale === "en" ? "official hosted service" : "官方托管服务");
    expect(landing).toContain("Android Mobile Node");
    expect(publicRouteMetadata("/")?.description[locale]).toContain("Windows");
    expect(publicRouteMetadata("/")?.description[locale]).toContain("Android");
  });

  it("lists the current Connector release with discoverable notes and keeps historical releases", () => {
    const { version } = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
    ) as { version: string };
    const release = listedPublicContent.find((entry) => entry.kind === "Product update");
    expect(release?.path).toBe(`/updates/connector-${version.replaceAll(".", "-")}`);
    expect(publicRouteMetadata(release!.path)?.publishedAt).toBe(release!.publishedAt);
    expect(release!.sections.some((section) => section.code?.includes("task.wait"))).toBe(true);
    expect(publicContent.some((entry) => entry.path === "/updates/connector-0-1-1")).toBe(true);
    const guide = publicContent.find(
      (entry) => entry.path === "/guides/first-device-to-first-tool-call"
    );
    expect(guide!.sections.find((section) => section.id === "pair")?.code).toContain(
      "/downloads/node/install.sh"
    );
  });
});
