import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Daemon } from "../src/daemon";

export type Call = (method: string, params?: Record<string, unknown>) => Promise<any>;

/** A fake GitHub token for a new user named `login`, distinct from every other test's (see fake-github.ts). */
export function freshUser(login: string): string {
  return `gho_fake_${login}.${Math.random().toString(36).slice(2, 10)}`;
}

/** An agent session (one client in one folder), as its MCP server would open it. */
export async function agentSession(daemon: Daemon, client: string, folder: string, cwd?: string) {
  const dir = cwd ?? join(mkdtempSync(join(tmpdir(), "proj-")), folder);
  mkdirSync(dir, { recursive: true });
  const { sessionId, seatKey } = await daemon.call("session.open", { client, cwd: dir });
  const call: Call = (method, params = {}) => daemon.call(method, { sessionId, ...params });
  return { call, seatKey, cwd: dir };
}

/** Adds an agent session to a lobby and reads its "you were added" notice. */
export async function add(daemon: Daemon, lobbyId: string, agent: { call: Call; seatKey: string }, handle: string, owns: string[] = []) {
  await daemon.call("lobby.addAgent", { lobbyId, seatKey: agent.seatKey, handle, owns });
  await agent.call("inbox.pull", { limit: 25 });
}

export async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  for (const deadline = Date.now() + ms; ; ) {
    const v = await fn();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Runs git in `cwd` as a throwaway test user. */
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" }).toString().trim();

/** A git repo on `main` with one commit, in `dir` or a new temp folder. */
export function makeRepo(dir = mkdtempSync(join(tmpdir(), "al-repo-"))): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "orders.ts"), "export const v = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}
