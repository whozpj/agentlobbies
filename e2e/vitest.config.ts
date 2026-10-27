import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../packages/daemon/test/relay-setup.ts", "./install-setup.ts"],
    testTimeout: 90_000,
    // The fake GitHub has one "signed in to GitHub" user for browser sign-ins, so browser tests
    // in different files would sign in as each other if they ran at the same time.
    fileParallelism: false,
    hookTimeout: 180_000,
  },
});
