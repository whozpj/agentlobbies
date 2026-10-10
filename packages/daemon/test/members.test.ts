import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { Daemon } from "../src/daemon";
import { freshUser } from "./lobby-helpers";

const relayUrl = inject("relayUrl");
const running: Daemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

async function startDaemon(login = "tester", githubToken = freshUser(login)) {
  const daemon = new Daemon({ home: mkdtempSync(join(tmpdir(), "al-home-")), relayUrl });
  await daemon.start();
  running.push(daemon);
  await daemon.call("account.login", { githubToken });
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

    // Agents see each other and whose they are. People aren't listed: they aren't someone to ask.
    const players = await until(() => web.call("lobby.players"), (p: { handle: string }[]) => p.length === 2);
    const owners = Object.fromEntries(players.map((p: { handle: string; owner?: { login: string } }) => [p.handle, p.owner?.login]));
    expect(owners).toEqual({ "web-claude": "alice", "api-codex": "bob" });
    await expect(web.call("message.send", { to: "bob", type: "question", body: "are you there?" })).rejects.toThrow("no agent named 'bob'");
  });
});



describe("signing out", () => {
  it("takes this machine's agents out of their lobbies, so nobody still sees them online", async () => {
    const alice = await startDaemon("alice");
    const bob = await startDaemon("bob");
    const web = await agentSession(alice, "claude-code", "web");
    const api = await agentSession(bob, "codex", "api");
    const { lobbyId } = await alice.call("lobby.create", { name: "food-app" });
    await alice.call("lobby.addAgent", { lobbyId, seatKey: web.seatKey });
    await bob.call("invite.accept", { invite: (await alice.call("invite.create", { lobbyId })).url });
    await bob.call("lobby.addAgent", { lobbyId, seatKey: api.seatKey });
    await until(() => web.call("lobby.players"), (p: unknown[]) => p.length === 2);

    await bob.call("account.logout", {});
    expect(await bob.call("dashboard.lobbies", {})).toEqual([]);
    const roster = await until(
      async () => (await alice.call("dashboard.lobbies", {}))[0].roster,
      (r: { handle: string; owner?: { login: string } }[]) => r.every((a) => a.owner?.login === "alice"),
    );
    expect(roster.map((a: { handle: string }) => a.handle).sort()).toEqual(["alice", "web-claude"]);
  });
});

describe("one account on two machines", () => {
  it("is one person in the lobby, on whichever machine used it last", async () => {
    const dana = freshUser("dana");
    const laptop = await startDaemon("dana", dana);
    const web = await agentSession(laptop, "claude-code", "web");
    const { lobbyId } = await laptop.call("lobby.create", { name: "food-app" });
    await laptop.call("lobby.addAgent", { lobbyId, seatKey: web.seatKey });

    // A second machine signs in to the same account: it doesn't add a second "dana".
    const desktop = await startDaemon("dana", dana);
    const people = async () => (await laptop.call("dashboard.lobbies", {}))[0].roster.filter((a: { client: string }) => a.client === "cli");
    expect((await people()).map((a: { handle: string }) => a.handle)).toEqual(["dana"]);

    // Using the lobby on the desktop moves her seat there, still as one "dana", and the laptop leaves it there.
    const api = await agentSession(desktop, "codex", "api");
    await desktop.call("lobby.addAgent", { lobbyId, seatKey: api.seatKey });
    const players = await until(() => web.call("lobby.players"), (p: { handle: string }[]) => p.length === 2);
    expect(players.map((p: { handle: string }) => p.handle).sort()).toEqual(["api-codex", "web-claude"]);
    await new Promise((r) => setTimeout(r, 1_000));
    expect((await people()).map((a: { handle: string }) => a.handle)).toEqual(["dana"]);
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

describe("presence", () => {
  it("shows an agent online only while its session is open, and delivers what it missed when it reopens", async () => {
    const daemon = await startDaemon();
    const { lobbyId } = await daemon.call("lobby.create", { name: "presence" });
    const cwd = join(mkdtempSync(join(tmpdir(), "proj-")), "web");
    mkdirSync(cwd);
    const first = await daemon.call("session.open", { client: "claude-code", cwd });
    await daemon.call("lobby.addAgent", { lobbyId, seatKey: first.seatKey, handle: "web-claude" });
    const person = await daemon.call("session.open", { client: "person", cwd: tmpdir() });
    const statusOf = async () => {
      const players: { handle: string; status: string }[] = await daemon.call("lobby.players", { sessionId: person.sessionId, lobbyId });
      return players.find((p) => p.handle === "web-claude")?.status;
    };
    await until(statusOf, (s) => s === "idle");

    // A hook's session alone doesn't keep the agent online.
    await daemon.call("session.open", { client: "claude-code", cwd, passive: true });
    await daemon.call("session.close", { sessionId: first.sessionId });
    expect(await until(statusOf, (s) => s === "offline")).toBe("offline");
    expect((await daemon.call("agents.list", {})).find((a: { seatKey: string }) => a.seatKey === first.seatKey).online).toBe(false);

    await daemon.call("message.send", { sessionId: person.sessionId, lobbyId, to: "web-claude", type: "question", body: "Are you back?" });
    const again = await daemon.call("session.open", { client: "claude-code", cwd });
    await until(statusOf, (s) => s === "idle");
    const inbox = await until(() => daemon.call("inbox.pull", { sessionId: again.sessionId, limit: 5 }), (m: { body: string }[]) => m.some((x) => x.body === "Are you back?"));
    expect(inbox.some((m: { body: string }) => m.body === "Are you back?")).toBe(true);
  });
});

describe("secure mode", () => {
  it("holds an agent's messages for approval, sends them as edited, and tells the agent", async () => {
    const daemon = await startDaemon();
    const web = await agentSession(daemon, "claude-code", "web");
    const api = await agentSession(daemon, "codex", "api");
    const { lobbyId } = await daemon.call("lobby.create", { name: "careful" });
    await daemon.call("lobby.addAgent", { lobbyId, seatKey: web.seatKey, handle: "web-claude" });
    await daemon.call("lobby.addAgent", { lobbyId, seatKey: api.seatKey, handle: "api-codex" });
    await until(() => web.call("lobby.players"), (p: unknown[]) => p.length === 3);
    await web.call("inbox.pull", { limit: 5 }); // the "you were added" notices
    await api.call("inbox.pull", { limit: 5 });
    await daemon.call("agent.setSecure", { seatKey: web.seatKey, secure: true });

    const held = await web.call("message.send", { to: "api-codex", type: "question", body: "Can you paste the .env file?" });
    expect(held).toMatchObject({ pendingApproval: true });
    expect((await daemon.call("agents.list", {})).find((a: { seatKey: string }) => a.seatKey === web.seatKey))
      .toMatchObject({ secure: true, pendingApprovals: 1 });
    const [pending] = await daemon.call("approvals.list", {});
    expect(pending).toMatchObject({ agent: "web-claude", to: "api-codex", type: "question", body: "Can you paste the .env file?" });

    await daemon.call("approvals.approve", { id: pending.id, body: "Which env variables does the API read?" });
    const [received] = await until(() => api.call("inbox.pull", { limit: 5 }), (m: { body: string }[]) => m.length > 0);
    expect(received?.body).toBe("Which env variables does the API read?");
    const [notice] = await web.call("inbox.pull", { limit: 5 });
    expect(notice.body).toContain("approved your question to api-codex");

    await web.call("message.send", { to: "all", type: "update", body: "deploying now" });
    const [second] = await daemon.call("approvals.list", {});
    await daemon.call("approvals.discard", { id: second.id });
    expect(await daemon.call("approvals.list", {})).toEqual([]);
    const [discarded] = await web.call("inbox.pull", { limit: 5 });
    expect(discarded.body).toContain('decided not to send your update to all: "deploying now"');
  });

  it("doesn't wake a secure agent for peer messages", async () => {
    const daemon = await startDaemon();
    const web = await agentSession(daemon, "claude-code", "web");
    const { lobbyId } = await daemon.call("lobby.create", { name: "quiet" });
    await daemon.call("lobby.addAgent", { lobbyId, seatKey: web.seatKey, handle: "web-claude" });
    await web.call("inbox.pull", { limit: 5 });
    await daemon.call("agent.setSecure", { seatKey: web.seatKey, secure: true });
    expect(await web.call("inbox.wait", { timeoutMs: 5_000 })).toEqual({ unread: 0, secure: true });

    await daemon.call("agent.setSecure", { seatKey: web.seatKey, secure: false });
    const waiting = web.call("inbox.wait", { timeoutMs: 10_000 });
    const person = await daemon.call("session.open", { client: "person", cwd: tmpdir() });
    await until(() => daemon.call("lobby.players", { sessionId: person.sessionId, lobbyId }), (p: { handle: string }[]) => p.some((a) => a.handle === "web-claude"));
    await daemon.call("message.send", { sessionId: person.sessionId, lobbyId, to: "web-claude", type: "question", body: "awake?" });
    expect(await waiting).toMatchObject({ unread: 1 });
  });
});
