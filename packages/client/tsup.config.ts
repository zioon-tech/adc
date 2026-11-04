import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/node.ts"],
  format: ["esm"],
  dts: true,
  noExternal: ["@adc/protocol", "zod"],
  target: "node18",
  splitting: true,
  clean: true,
  outDir: "dist"
});
