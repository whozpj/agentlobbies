import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    bin: string;
  }
}

/** Packs the CLI and installs the tarball with plain npm, the way a user gets it. */
export default function setup(project: TestProject) {
  const packDir = mkdtempSync(join(tmpdir(), "al-pack-"));
  execFileSync("corepack", ["pnpm@10", "pack", "--pack-destination", packDir], {
    cwd: resolve(import.meta.dirname, "../packages/cli"),
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    stdio: "ignore",
  });
  const tarball = join(packDir, readdirSync(packDir).find((f) => f.endsWith(".tgz"))!);

  const appDir = mkdtempSync(join(tmpdir(), "al-app-"));
  execFileSync("npm", ["install", "--prefix", appDir, "--no-audit", "--no-fund", tarball], { stdio: "ignore" });
  project.provide("bin", join(appDir, "node_modules", ".bin", "agentlobbies"));
}
