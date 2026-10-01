import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";
import { unstable_dev } from "wrangler";
import { startFakeGitHub } from "./fake-github";

declare module "vitest" {
  export interface ProvidedContext {
    relayUrl: string;
    githubUrl: string;
  }
}

/** Runs the real relay locally (wrangler dev) for the daemon's integration tests. */
export default async function setup(project: TestProject) {
  const relayDir = resolve(import.meta.dirname, "../../relay-cf");
  const persistTo = mkdtempSync(join(tmpdir(), "agentlobbies-relay-"));
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "agentlobbies", "--local", "--env", "test", "--persist-to", persistTo], {
    cwd: relayDir, stdio: "ignore",
  });

  const github = await startFakeGitHub();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const worker = await unstable_dev(join(relayDir, "src/worker.ts"), {
    config: join(relayDir, "wrangler.toml"),
    env: "test",
    persistTo,
    vars: {
      JWT_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      JWT_PUBLIC_KEYS: JSON.stringify({ k1: publicKey.export({ format: "pem", type: "spki" }).toString() }),
      IP_HASH_SALT: randomBytes(32).toString("hex"),
      GITHUB_API_URL: github.url,
      GITHUB_URL: github.url,
      GITHUB_CLIENT_SECRET: "test-secret",
    },
    experimental: { disableExperimentalWarning: true },
  });

  project.provide("relayUrl", `http://${worker.address}:${worker.port}`);
  project.provide("githubUrl", github.url);
  return async () => {
    await worker.stop();
    github.server.close();
  };
}
