import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/relay-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
