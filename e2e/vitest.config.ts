import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../packages/daemon/test/relay-setup.ts", "./install-setup.ts"],
    testTimeout: 90_000,
    hookTimeout: 180_000,
  },
});
