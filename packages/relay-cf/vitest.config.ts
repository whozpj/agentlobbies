import { generateKeyPairSync, randomBytes } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Throwaway signing keys and salt for tests only.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          JWT_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
          JWT_PUBLIC_KEYS: JSON.stringify({ k1: publicKey.export({ format: "pem", type: "spki" }).toString() }),
          IP_HASH_SALT: randomBytes(32).toString("hex"),
          GITHUB_CLIENT_SECRET: "test-secret",
          ADMIN_TOKEN: "test-admin-token",
          TEST_MIGRATIONS: await readD1Migrations("./migrations/d1"),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
