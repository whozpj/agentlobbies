import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../daemon/test/relay-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
