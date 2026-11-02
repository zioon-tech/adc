import { useEffect, useState } from "react";
import type { NodeRecord } from "./main.tsx";
import type { Request } from "./auth-ui.tsx";
import { Dialog } from "./dialog.tsx";
import { useI18n } from "./i18n.tsx";
import { CodeBlock } from "./docs-code.tsx";

export function ConnectorUpdate({ node, request, onClose }: { node: NodeRecord; request: Request; onClose: () => void }) {
  const { t } = useI18n();
  const [installation, setInstallation] = useState<{ available: boolean; downloadUrl?: string; installerUrl?: string; windowsInstallerUrl?: string; latest?: { version: string } }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    request("/api/v1/node-installation").then(value => { if (active) setInstallation(value); }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [request]);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const command = installation?.available && installation.downloadUrl && installation.installerUrl
    ? node.platform === "win32" && installation.windowsInstallerUrl
      ? `$p=Join-Path $env:TEMP ('adc-update-'+[guid]::NewGuid().ToString('N')+'.ps1'); Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(installation.windowsInstallerUrl)} -OutFile $p; & powershell -NoProfile -ExecutionPolicy Bypass -File $p -DownloadUrl ${psQuote(installation.downloadUrl)}; Remove-Item $p -Force`
      : `curl -fsSL ${quote(installation.installerUrl)} | sh -s -- --download-url ${quote(installation.downloadUrl)}`
    : undefined;
  return <Dialog title={t("Update Connector")} onClose={onClose}>
    <p><strong>{node.label}</strong></p>
    <p>{t("Current Connector: {version}", { version: node.capability?.nodeVersion ?? t("Unavailable") })} · {t("Latest version: {version}", { version: installation?.latest?.version ?? node.update?.latest?.version ?? "—" })}</p>
    <p className="description">{t("Run the update on this device. Its identity, folders and existing permissions are preserved.")}</p>
    {!node.online ? <p className="hint">{t("This device is offline. The update remains available; reconnect it before checking the result.")}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {command ? <CodeBlock label={node.platform === "win32" ? "PowerShell" : "Terminal"}>{command}</CodeBlock> : !error ? <p className="hint">{t(installation ? "Connector downloads are unavailable. Try again later." : "Loading…")}</p> : null}
    <p className="hint">{t("The device list refreshes automatically after the upgraded Connector reconnects.")}</p>
  </Dialog>;
}
