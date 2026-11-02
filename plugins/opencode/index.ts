import {
  createCliTransport,
  executeNativeTool,
  nativeTools,
  WORKFLOW_GUIDANCE,
  type HarnessTransport
} from "../../packages/harness-core/src/index.ts";

// The SDK's tool helper is supplied by the bundled host entry; dependencies stay host-owned.
export function createOpenCodePlugin(tool: any, transportFactory = createCliTransport) {
  return async () => {
    const transport: HarnessTransport = transportFactory();
    return {
      config: async (config: any) => {
        config.command ??= {};
        for (const [name, template] of Object.entries({
          "adc-setup":
            "Help me start using ADC. Check adc_status, then guide sign-in, device setup and scoped access using the agent-device-cloud Skill.",
          "adc-devices": "Use adc_discover to show my ADC devices and help me choose a target.",
          "adc-tasks": "Inspect my existing ADC invocation/task identities using adc_task.",
          "adc-approval":
            "Show the ADC approval review link. The human decides; then inspect the same invocation."
        }))
          config.command[name] ??= { description: template, template };
      },
      tool: Object.fromEntries(
        nativeTools.map((definition) => [
          definition.name,
          tool({
            description: `${definition.description} ${WORKFLOW_GUIDANCE}`,
            args:
              definition.name === "adc_status" || definition.name === "adc_discover"
                ? {}
                : {
                    input: tool.schema
                      .string()
                      .describe(`JSON object matching: ${JSON.stringify(definition.inputSchema)}`)
                  },
            async execute(args: { input?: string }, context: any) {
              // OpenCode's public tool context carries the AbortSignal and ask permission helper.
              if (["adc_invoke", "adc_cancel"].includes(definition.name)) {
                if (typeof context.ask !== "function")
                  throw new Error("This OpenCode version cannot request ADC execution permission.");
                await context.ask({
                  permission: "adc_execute",
                  patterns: ["authorized-device"],
                  always: ["authorized-device"],
                  metadata: { tool: definition.name }
                });
              }
              return JSON.stringify(
                await executeNativeTool(
                  transport,
                  definition.name,
                  args.input ? JSON.parse(args.input) : {},
                  context.abort
                )
              );
            }
          })
        ])
      ),
      dispose: async () => transport.dispose()
    };
  };
}
