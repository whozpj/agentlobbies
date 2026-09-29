import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  clean: true,
  platform: "node",
  target: "node22",
  removeNodeProtocol: false,
});
