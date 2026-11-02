import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { GrantForm } from "./agents.tsx";
import { ShareDialog } from "./collaboration.tsx";
import { Documentation } from "./docs.tsx";
import { LocaleProvider, type Locale } from "./i18n.tsx";
import type { NodeRecord } from "./main.tsx";
import { listedPublicContent, publicContentEntry, relatedPublicContent } from "./public-content.ts";
import { publicRouteMetadata } from "./site-metadata.ts";

const request = async () => ({});
const noop = () => {};
const node: NodeRecord = {
  nodeId: "node_transfer_test",
  label: "Test device",
  platform: "linux",
  status: "active",
  online: true,
  capability: {
    nodeVersion: "0.1.6",
    roots: [{ rootId: "root_project", path: "/project", label: "Project", writable: true }],
    tools: [
      { name: "file.read", risk: "read" },
      { name: "file.write", risk: "write" },
      { name: "file.transfer", risk: "write" }
    ],
    collaboration: { version: 1, trustedHost: true, isolation: "none" }
  }
};

function render(component: ReactElement, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, {
      initialLocale: locale,
      children: createElement(StaticRouter, { location: "/docs/tools" }, component)
    })
  );
}

describe("cloud file transfer visibility", () => {
  it.each(["en", "zh-CN"] as const)(
    "hides transfer promotion and keeps other tools in %s",
    (locale) => {
      const html = render(createElement(Documentation, { signedIn: false }), locale);
      expect(html).not.toContain("file.transfer");
      expect(html).not.toContain('id="file-transfer"');
      expect(html).not.toContain("adc transfer create");
      expect(html).toContain("file.read");
      expect(html).toContain("file.write");
      expect(html).toContain("task.wait");
    }
  );

  it("does not offer cloud transfer when creating an Agent grant", () => {
    const html = render(
      createElement(GrantForm, {
        request,
        projects: [],
        nodes: [node],
        onError: noop,
        onClose: noop,
        onCreated: noop
      })
    );
    expect(html).not.toContain("file.transfer");
    expect(html).toContain("file.write");
  });

  it("keeps existing transfer grants visible for permission removal", () => {
    const html = render(
      createElement(GrantForm, {
        request,
        projects: [],
        nodes: [node],
        onError: noop,
        onClose: noop,
        onCreated: noop,
        initial: {
          grantId: "grant_existing",
          name: "Existing",
          profile: "workspace-write",
          nodeIds: [node.nodeId],
          rootIds: ["root_project"],
          allowedTools: ["file.read", "file.transfer"]
        }
      })
    );
    expect(html).toMatch(/<input[^>]+type="checkbox"[^>]+checked=""\/>file\.transfer/);
  });

  it("does not offer transfer in a new device-sharing invitation", () => {
    const html = render(
      createElement(ShareDialog, {
        node,
        request,
        teams: [],
        onClose: noop,
        onSaved: noop
      })
    );
    expect(html).not.toContain("file.transfer");
    expect(html).toContain("file.read");
  });

  it("removes the cloud transfer article from discovery and public metadata", () => {
    const path = "/updates/connector-0-1-4";
    expect(publicContentEntry(path)).toBeUndefined();
    expect(publicRouteMetadata(path)).toBeUndefined();
    expect(listedPublicContent.some((entry) => entry.path === path)).toBe(false);
    for (const entry of listedPublicContent) {
      expect(relatedPublicContent(entry).some((related) => related.path === path)).toBe(false);
    }
  });
});
