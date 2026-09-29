import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/main.ts", "src/render.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  platform: "node",
  target: "node22",
  removeNodeProtocol: false,
});
