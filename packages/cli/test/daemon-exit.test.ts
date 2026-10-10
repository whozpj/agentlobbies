import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DAEMON = join(import.meta.dirname, "../dist/main.js");

describe("the background daemon", () => {
  it("exits by itself once its home folder is deleted, instead of running on unreachable", async () => {
    const home = mkdtempSync(join("/tmp", "al-exit-"));
    const daemon = spawn(process.execPath, [DAEMON], {
      env: { ...process.env, AGENTLOBBIES_HOME: home, AGENTLOBBIES_RELAY_URL: "http://127.0.0.1:9", AGENTLOBBIES_ORPHAN_CHECK_MS: "200" },
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve) => daemon.on("exit", resolve));
    for (let i = 0; i < 100 && !existsSync(join(home, "daemon.sock")); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(join(home, "daemon.sock"))).toBe(true);

    rmSync(home, { recursive: true, force: true });
    expect(await exited).toBe(0);
  }, 20_000);
});
