import { useEffect, useState } from "react";
import { Check, Clipboard } from "lucide-react";
import { useI18n } from "./i18n.tsx";

function CopyButton({ text }: { text: string }) {
  const { locale } = useI18n();
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const label =
    locale === "zh-CN"
      ? { idle: "复制", copied: "已复制", error: "请手动复制" }[status]
      : { idle: "Copy", copied: "Copied", error: "Copy manually" }[status];
  useEffect(() => {
    if (status === "idle") return;
    const timer = window.setTimeout(() => setStatus("idle"), 2400);
    return () => window.clearTimeout(timer);
  }, [status]);
  return (
    <button
      className="docs-copy-button"
      aria-label={locale === "zh-CN" ? "复制内容" : "Copy content"}
      onClick={() => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(text);
            setStatus("copied");
          } catch {
            setStatus("error");
          }
        })();
      }}
    >
      {status === "copied" ? <Check size={14} /> : <Clipboard size={14} />}
      <span aria-live="polite">{label}</span>
    </button>
  );
}

export function CodeBlock({ label, children }: { label: string; children: string }) {
  return (
    <div className="docs-code">
      <div>
        <span>{label}</span>
        <CopyButton key={children} text={children} />
      </div>
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  );
}
