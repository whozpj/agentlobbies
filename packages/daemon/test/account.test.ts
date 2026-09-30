import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { Daemon } from "../src/daemon";

const relayUrl = inject("relayUrl");
const running: Daemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

async function startDaemon(home = mkdtempSync(join(tmpdir(), "al-home-"))) {
  const daemon = new Daemon({ home, relayUrl, agentJoin: "allow" });
  await daemon.start();
  running.push(daemon);
  return daemon;
}

async function session(daemon: Daemon, client: string) {
  const { sessionId } = await daemon.call("session.open", { client, cwd: mkdtempSync(join(tmpdir(), `${client}-`)) });
  return (method: string, params: Record<string, unknown> = {}) => daemon.call(method, { sessionId, ...params });
}

describe("accounts", () => {
  it("signs in with a GitHub token and remembers it across restarts", async () => {
    const home = mkdtempSync(join(tmpdir(), "al-home-"));
    let daemon = await startDaemon(home);
    expect(await daemon.call("account.status", {})).toBeNull();
    expect(await daemon.call("account.login", { githubToken: "gho_fake_whozpj" })).toMatchObject({ login: "whozpj" });
    await daemon.stop();
    daemon = await startDaemon(home);
    expect(await daemon.call("account.status", {})).toMatchObject({ login: "whozpj" });
  });

  it("asks you to sign in before creating or joining a lobby", async () => {
    const web = await session(await startDaemon(), "claude-code");
    await expect(web("lobby.create", { handle: "web" })).rejects.toMatchObject({ code: "login_required" });
    await expect(web("lobby.join", { code: "2-abandon-ability", handle: "web" })).rejects.toMatchObject({ code: "login_required" });
  });

  it("shows which person owns each agent", async () => {
    const laptop = await startDaemon();
    const server = await startDaemon();
    await laptop.call("account.login", { githubToken: "gho_fake_alice" });
    await server.call("account.login", { githubToken: "gho_fake_bob" });
    const web = await session(laptop, "claude-code");
    const api = await session(server, "codex");
    const { code } = await web("lobby.create", { handle: "web-claude" });
    await api("lobby.join", { code, handle: "api-codex", owns: ["api"] });

    let players: { handle: string; owner?: { login: string } }[] = [];
    for (let i = 0; i < 100 && players.length < 2; i++) {
      players = await web("lobby.players");
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(Object.fromEntries(players.map((p) => [p.handle, p.owner?.login]))).toEqual({ "web-claude": "alice", "api-codex": "bob" });
  });

  it("refreshes an unreadable account token with the machine key", async () => {
    const home = mkdtempSync(join(tmpdir(), "al-home-"));
    let daemon = await startDaemon(home);
    await daemon.call("account.login", { githubToken: "gho_fake_refresher" });
    await daemon.stop();
    const db = new DatabaseSync(join(home, "daemon.db"));
    db.prepare("UPDATE account SET token = 'garbage'").run();
    db.close();

    daemon = await startDaemon(home);
    const web = await session(daemon, "claude-code");
    expect(await web("lobby.create", { handle: "web" })).toHaveProperty("code");
  });

  it("signs out", async () => {
    const daemon = await startDaemon();
    await daemon.call("account.login", { githubToken: "gho_fake_leaver" });
    await daemon.call("account.logout", {});
    expect(await daemon.call("account.status", {})).toBeNull();
    const web = await session(daemon, "claude-code");
    await expect(web("lobby.create", { handle: "web" })).rejects.toMatchObject({ code: "login_required" });
  });
});
