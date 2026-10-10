import { spawn } from "node:child_process";
import { RpcClient } from "@agentlobbies/daemon/client";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DAEMON = join(import.meta.dirname, "../dist/main.js");

/** Starts a daemon in `home` and waits until it is listening. */
async function startDaemon(home: string) {
  const daemon = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, AGENTLOBBIES_HOME: home, AGENTLOBBIES_RELAY_URL: "http://127.0.0.1:9", AGENTLOBBIES_ORPHAN_CHECK_MS: "200" },
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve) => daemon.on("exit", resolve));
  for (let i = 0; i < 100 && !(await RpcClient.isListening(join(home, "daemon.sock"))); i++) await new Promise((r) => setTimeout(r, 100));
  return { daemon, exited };
}

describe("the background daemon", () => {
  it("exits by itself once its home folder is deleted, instead of running on unreachable", async () => {
    const home = mkdtempSync(join("/tmp", "al-exit-"));
    const { exited } = await startDaemon(home);
    expect(existsSync(join(home, "daemon.sock"))).toBe(true);

    rmSync(home, { recursive: true, force: true });
    expect(await exited).toBe(0);
  }, 20_000);

  it("exits when another daemon takes over its socket, and leaves that daemon's socket alone", async () => {
    const home = mkdtempSync(join("/tmp", "al-exit-"));
    const socket = join(home, "daemon.sock");
    const old = await startDaemon(home);
    rmSync(socket);
    const current = await startDaemon(home);

    expect(await old.exited).toBe(0);
    await new Promise((r) => setTimeout(r, 500));
    expect(await RpcClient.isListening(socket)).toBe(true);
    current.daemon.kill();
    await current.exited;
  }, 20_000);
});
