import { defineConfig } from "tsup";

export default defineConfig({
  // `main` is the daemon; connectToDaemon() spawns it from next to the bundle.
  entry: { cli: "src/cli.ts", hook: "src/hook.ts", main: "../daemon/src/main.ts" },
  format: ["esm"],
  clean: true,
  platform: "node",
  target: "node22",
  removeNodeProtocol: false,
  noExternal: [/^@agentlobbies\//],
});
