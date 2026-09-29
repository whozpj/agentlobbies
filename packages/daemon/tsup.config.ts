import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/client.ts", "src/main.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  platform: "node",
  target: "node22",
  // Keep `node:sqlite` as written; it has no un-prefixed form.
  removeNodeProtocol: false,
});
