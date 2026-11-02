import {
  createCliTransport,
  executeNativeTool,
  nativeTools,
  WORKFLOW_GUIDANCE,
  type HarnessTransport
} from "../../packages/harness-core/src/index.ts";

export default function activatePi(pi: any) {
  const transport: HarnessTransport = createCliTransport();
  for (const definition of nativeTools) {
    pi.registerTool({
      name: definition.name,
      label: definition.name.replace("adc_", "ADC "),
      description: `${definition.description} ${WORKFLOW_GUIDANCE}`,
      // Pi validates JSON Schema via its public TypeBox-compatible tool contract.
      parameters: definition.inputSchema,
      async execute(_toolCallId: string, input: any, signal: AbortSignal, _update: any, ctx: any) {
        if (["adc_invoke", "adc_cancel"].includes(definition.name)) {
          if (!ctx.hasUI)
            throw new Error("ADC side effects require an interactive Pi confirmation.");
          const approved = await ctx.ui.confirm("ADC device operation", JSON.stringify(input));
          if (!approved) throw new Error("ADC operation declined.");
        }
        const result = await executeNativeTool(transport, definition.name, input, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }
    });
  }
  pi.registerCommand("adc", {
    description: "ADC connection, devices, setup and existing tasks",
    async handler(args: string, ctx: any) {
      const [action = "status", identity] = args.trim().split(/\s+/);
      try {
        if (action === "setup" || action === "approval") {
          const text =
            action === "setup"
              ? "Help me start using ADC using the agent-device-cloud Skill. Check the CLI, guide sign-in, device and scoped access setup, then verify a read-only result."
              : "Open my ADC approval review link. I will make the decision; then inspect the same invocation.";
          pi.sendUserMessage(text);
          return;
        }
        const result = await executeNativeTool(
          transport,
          action === "devices" ? "adc_discover" : action === "task" ? "adc_task" : "adc_status",
          action === "task" ? { invocationId: identity } : {}
        );
        if (ctx.hasUI) {
          ctx.ui.notify(JSON.stringify(result, null, 2), "info");
          ctx.ui.setStatus("adc", action === "devices" ? "ADC · devices refreshed" : "ADC");
        } else
          pi.sendMessage({ customType: "adc", content: JSON.stringify(result), display: true });
      } catch {
        if (ctx.hasUI) ctx.ui.notify("ADC is unavailable. Use /adc setup to connect.", "warning");
        else throw new Error("ADC is unavailable. Use the ADC setup Skill to connect.");
      }
    }
  });
  pi.on("session_shutdown", () => transport.dispose());
}
