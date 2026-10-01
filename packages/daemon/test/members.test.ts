import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { Daemon } from "../src/daemon";
import { freshUser } from "./lobby-helpers";

const relayUrl = inject("relayUrl");
const running: Daemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

async function startDaemon(login = "tester") {
  const daemon = new Daemon({ home: mkdtempSync(join(tmpdir(), "al-home-")), relayUrl });
  await daemon.start();
  running.push(daemon);
  await daemon.call("account.login", { githubToken: freshUser(login) });
  return daemon;
}

async function agentSession(daemon: Daemon, client: string, folder: string) {
  const cwd = join(mkdtempSync(join(tmpdir(), "proj-")), folder);
  mkdirSync(cwd);
  const { sessionId, seatKey } = await daemon.call("session.open", { client, cwd });
  const call = (method: string, params: Record<string, unknown> = {}) => daemon.call(method, { sessionId, ...params });
  return { call, seatKey, cwd };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn().catch(() => undefined as T);
    if (v !== undefined && ok(v)) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

describe("your agents", () => {
  it("registers every agent session that connects as one of your agents", async () => {
    const daemon = await startDaemon();
    const web = await agentSession(daemon, "claude-code", "web");
    const agents = await daemon.call("agents.list", {});
    expect(agents).toContainEqual(expect.objectContaining({ seatKey: web.seatKey, client: "claude-code", folder: "web", online: true, lobbies: [] }));
  });

  it("creates a lobby as you, adds your agent, and tells the agent it was added", async () => {
    const daemon = await startDaemon("whozpj");
    const web = await agentSession(daemon, "claude-code", "web");
    const { lobbyId } = await daemon.call("lobby.create", { name: "food-app" });
    const added = await daemon.call("lobby.addAgent", { lobbyId, seatKey: web.seatKey, owns: ["web"] });
    expect(added.handle).toBe("web-claude");

    expect(await web.call("inbox.wait", { timeoutMs: 1000 })).toMatchObject({ unread: 1 });
    const [notice] = await web.call("inbox.pull", { limit: 5 });
    expect(notice).toMatchObject({ type: "notice" });
    expect(notice.body).toContain("You were added to lobby food-app by @whozpj");
    expect(await web.call("lobby.status")).toMatchObject({ handle: "web-claude", role: "member" });
  });

  it("refuses to add an agent that isn't one of yours", async () => {
    const daemon = await startDaemon();
    const { lobbyId } = await daemon.call("lobby.create", { name: "x" });
    await expect(daemon.call("lobby.addAgent", { lobbyId, seatKey: "not-a-real-seat" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("removes an agent from a lobby", async () => {
    const daemon = await startDaemon();
    const web = await agentSession(daemon, "claude-code", "web");
    const { lobbyId } = await daemon.call("lobby.create", { name: "x" });
    const { agentId } = await daemon.call("lobby.addAgent", { lobbyId, seatKey: web.seatKey });
    await daemon.call("lobby.removeAgent", { lobbyId, agentId });
    await until(() => web.call("lobby.status").then(() => "still in", (e) => e.code), (code) => code === "no_seat");
    await expect(web.call("lobby.status")).rejects.toMatchObject({ code: "no_seat" });
  });
});

describe("invites", () => {
  it("lets another person join with a link and add their own agents", async () => {
    const alice = await startDaemon("alice");
    const bob = await startDaemon("bob");
    const web = await agentSession(alice, "claude-code", "web");
    const api = await agentSession(bob, "codex", "api");

    const { lobbyId } = await alice.call("lobby.create", { name: "food-app" });
    await alice.call("lobby.addAgent", { lobbyId, seatKey: web.seatKey, owns: ["web"] });
    const { url } = await alice.call("invite.create", { lobbyId });
    expect(url).toContain("/invite/");

    expect(await bob.call("invite.accept", { invite: url })).toMatchObject({ lobbyId, name: "food-app" });
    await bob.call("lobby.addAgent", { lobbyId, seatKey: api.seatKey, owns: ["api"] });

    const players = await until(() => web.call("lobby.players"), (p: { handle: string }[]) => p.length === 4);
    const owners = Object.fromEntries(players.map((p: { handle: string; owner?: { login: string } }) => [p.handle, p.owner?.login]));
    expect(owners).toEqual({ alice: "alice", "web-claude": "alice", bob: "bob", "api-codex": "bob" });
  });
});



describe("editing your agents", () => {
  it("accepts areas as typed, and tells the agent when it is renamed or given new areas", async () => {
    const daemon = await startDaemon();
    const web = await agentSession(daemon, "claude-code", "web");
    const { lobbyId } = await daemon.call("lobby.create", { name: "edits" });
    const { agentId, handle } = await daemon.call("lobby.addAgent", { lobbyId, seatKey: web.seatKey, owns: ["Frontend"] });
    expect(handle).toBe("web-claude");
    await web.call("inbox.pull", { limit: 5 }); // the "you were added" notice
    type Player = { handle: string; owns: string[] };
    const players = await until<Player[]>(() => web.call("lobby.players"), (p) => p.some((a) => a.handle === "web-claude"));
    expect(players.find((a) => a.handle === "web-claude")?.owns).toEqual(["frontend"]);

    await daemon.call("lobby.updateAgent", { lobbyId, agentId, handle: "Web UI", owns: ["frontend", "Design System"] });
    const [notice] = await until<{ body: string }[]>(() => web.call("inbox.pull", { limit: 5 }), (m) => m.length > 0);
    expect(notice?.body).toBe("Your user updated you in lobby edits: you are now web-ui; you now own: frontend, design-system.");
    expect(await web.call("lobby.status")).toMatchObject({ handle: "web-ui" });
  });

  it("says which area can't be used", async () => {
    const daemon = await startDaemon();
    const web = await agentSession(daemon, "claude-code", "web");
    const { lobbyId } = await daemon.call("lobby.create", { name: "bad-area" });
    await expect(daemon.call("lobby.addAgent", { lobbyId, seatKey: web.seatKey, owns: ["front/end"] }))
      .rejects.toThrow(/"front\/end" isn't a valid area/);
  });
});

describe("deleting lobbies", () => {
  it("deletes a lobby for everyone and erases it from every member's machine", async () => {
    const owner = await startDaemon("owner");
    const { lobbyId } = await owner.call("lobby.create", { name: "short-lived" });
    const { url } = await owner.call("invite.create", { lobbyId });
    const guest = await startDaemon("guest");
    await guest.call("invite.accept", { invite: url });
    await until(() => guest.call("dashboard.lobbies", {}), (l: { keyEpoch: number }[]) => l[0]?.keyEpoch === 1);

    await owner.call("lobby.delete", { lobbyId });
    expect(await owner.call("dashboard.lobbies", {})).toEqual([]);
    const left = await until(() => guest.call("dashboard.lobbies", {}), (l: unknown[]) => l.length === 0);
    expect(left).toEqual([]);
  });

  it("only lets the owner delete, and forgets a lobby on this machine alone", async () => {
    const owner = await startDaemon("owner");
    const { lobbyId } = await owner.call("lobby.create", { name: "kept" });
    const { url } = await owner.call("invite.create", { lobbyId });
    const guest = await startDaemon("guest");
    await guest.call("invite.accept", { invite: url });
    await expect(guest.call("lobby.delete", { lobbyId })).rejects.toThrow(/only the lobby owner/);

    await guest.call("lobby.forget", { lobbyId });
    expect(await guest.call("dashboard.lobbies", {})).toEqual([]);
    expect(await owner.call("dashboard.lobbies", {})).toHaveLength(1);
  });
});
