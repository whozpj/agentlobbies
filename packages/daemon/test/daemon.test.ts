import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { Connection } from "../src/connection";
import { Daemon } from "../src/daemon";
import { add, agentSession, eventually, freshUser } from "./lobby-helpers";

const relayUrl = inject("relayUrl");
const running: Daemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

async function startDaemon(home = mkdtempSync(join(tmpdir(), "al-home-")), login = "tester") {
  const daemon = new Daemon({ home, relayUrl });
  await daemon.start();
  running.push(daemon);
  // A restarted daemon is still signed in, as the same person.
  if (!(await daemon.call("account.status", {}))) await daemon.call("account.login", { githubToken: freshUser(login) });
  return daemon;
}

/** One daemon, a lobby, and two of its agents already added. */
async function lobbyWithTwoAgents() {
  const daemon = await startDaemon();
  const web = await agentSession(daemon, "claude-code", "web");
  const api = await agentSession(daemon, "codex", "api");
  const { lobbyId } = await daemon.call("lobby.create", { name: "food-app" });
  await add(daemon, lobbyId, web, "web-claude", ["web"]);
  await add(daemon, lobbyId, api, "api-codex", ["api"]);
  await eventually(() => web.call("lobby.players"), (p) => p.length === 3);
  await eventually(() => api.call("lobby.status"), (s) => s.connection === "live");
  return { daemon, lobbyId, web, api };
}

describe("daemon against the real relay", () => {
  it("lets one agent ask another a question and read the answer (E1 shape)", async () => {
    const { web, api } = await lobbyWithTwoAgents();
    const sent = await web.call("message.send", { to: "owner:api", type: "question", body: "What field holds the ETA?" });
    expect(sent.seq).toBeGreaterThan(0);

    const [question] = await eventually(() => api.call("inbox.pull", { limit: 5 }), (m) => m.length > 0);
    expect(question).toMatchObject({ from: "web-claude", type: "question", body: "What field holds the ETA?" });

    await api.call("message.send", { to: "web-claude", type: "answer", inReplyTo: question.id, body: "estimatedArrival, ISO 8601" });
    const [answer] = await eventually(() => web.call("inbox.pull", { limit: 5 }), (m) => m.length > 0);
    expect(answer).toMatchObject({ from: "api-codex", type: "answer", inReplyTo: question.id });
  });

  it("catches up on messages sent while the daemon was stopped, in order, once (E5 shape)", async () => {
    const laptop = await startDaemon(undefined, "alice");
    const serverHome = mkdtempSync(join(tmpdir(), "al-home-"));
    let server = await startDaemon(serverHome, "bob");
    const web = await agentSession(laptop, "claude-code", "web");
    const apiCwd = (await agentSession(server, "codex", "api")).cwd;
    let api = await agentSession(server, "codex", "api", apiCwd);

    const { lobbyId } = await laptop.call("lobby.create", { name: "food-app" });
    await add(laptop, lobbyId, web, "web");
    const { url } = await laptop.call("invite.create", { lobbyId });
    await server.call("invite.accept", { invite: url });
    await add(server, lobbyId, api, "api");
    await eventually(() => web.call("lobby.players"), (p) => p.some((a: { handle: string }) => a.handle === "api"));
    await eventually(() => api.call("lobby.status"), (s) => s.connection === "live");
    await server.stop();

    for (const n of [1, 2, 3]) await web.call("message.send", { to: "api", type: "question", body: `question ${n}` });

    server = await startDaemon(serverHome, "bob");
    api = await agentSession(server, "codex", "api", apiCwd);
    const peek = await eventually(() => api.call("inbox.peek"), (p) => p.unread >= 3);
    expect(peek.unread).toBe(3);
    expect((await api.call("inbox.pull", { limit: 10 })).map((m: { body: string }) => m.body)).toEqual(["question 1", "question 2", "question 3"]);
  });

  it("refuses to send a message containing a secret, unless a human allows it", async () => {
    const { web } = await lobbyWithTwoAgents();
    await expect(web.call("message.send", { to: "all", type: "update", body: "use AKIAIOSFODNN7EXAMPLE" }))
      .rejects.toMatchObject({ code: "secret_detected" });
    expect(await web.call("message.send", { to: "all", type: "update", body: "use AKIAIOSFODNN7EXAMPLE", allowSecret: true })).toHaveProperty("id");
  });

  it("tells an agent that isn't in a lobby how to get added", async () => {
    const web = await agentSession(await startDaemon(), "claude-code", "web");
    await expect(web.call("lobby.status")).rejects.toMatchObject({ code: "no_seat", message: expect.stringContaining("dashboard") });
  });

  it("shows connected peers as online and waiting, not the stale status from their joined event", async () => {
    const { api } = await lobbyWithTwoAgents();
    const players = await eventually(() => api.call("lobby.players"), (p) => p.every((a: { status: string }) => a.status === "idle"));
    // Two agents: the person who made the lobby isn't in the list agents see.
    expect(players.map((a: { status: string }) => a.status)).toEqual(["idle", "idle"]);
  });

  it("refreshes an invalid or expired token by itself and reconnects (C6)", async () => {
    const home = mkdtempSync(join(tmpdir(), "al-home-"));
    let daemon = await startDaemon(home);
    const cwd = (await agentSession(daemon, "claude-code", "web")).cwd;
    const web = await agentSession(daemon, "claude-code", "web", cwd);
    const { lobbyId } = await daemon.call("lobby.create", { name: "x" });
    await add(daemon, lobbyId, web, "web");
    await daemon.stop();

    const db = new DatabaseSync(join(home, "daemon.db"));
    db.prepare("UPDATE seats SET jwt = 'expired.token.here'").run();
    db.close();

    daemon = await startDaemon(home);
    const again = await agentSession(daemon, "claude-code", "web", cwd);
    expect(await eventually(() => again.call("lobby.status"), (s) => s.connection === "live")).toMatchObject({ connection: "live" });
  });

  it("inbox.wait returns as soon as a message arrives, and a newer wait replaces an older one", async () => {
    const { web, api } = await lobbyWithTwoAgents();
    expect(await api.call("inbox.wait", { timeoutMs: 200 })).toEqual({ unread: 0 });

    const older = api.call("inbox.wait", { timeoutMs: 10_000 });
    const newer = api.call("inbox.wait", { timeoutMs: 10_000 });
    expect(await older).toEqual({ cancelled: true });

    await web.call("message.send", { to: "api-codex", type: "question", body: "ping?" });
    expect(await newer).toEqual({ unread: 1 });
    expect(await api.call("inbox.wait", { timeoutMs: 10_000 })).toEqual({ unread: 1 });
  });

  it("batches acks for live events instead of acking each one", async () => {
    const { web, api } = await lobbyWithTwoAgents();
    const send = vi.spyOn(Connection.prototype, "send");
    await Promise.all(Array.from({ length: 25 }, (_, i) => api.call("message.send", { to: "all", type: "update", body: `update ${i}` })));
    await eventually(() => web.call("inbox.peek"), (p) => p.unread === 25);
    await new Promise((r) => setTimeout(r, 400));

    const acks = send.mock.calls.map(([frame]) => frame).filter((f) => f.t === "ack") as { seq: number }[];
    send.mockRestore();
    expect(acks.length).toBeLessThan(15);
    const { seq } = (await web.call("inbox.pull", { limit: 25 })).at(-1);
    expect(Math.max(...acks.map((a) => a.seq))).toBe(seq);
  });

  it("includes the sender's client and owner in messages, and updates presence", async () => {
    const { web, api } = await lobbyWithTwoAgents();
    await api.call("presence.set", { status: "busy", workingOn: "order status API" });
    await web.call("message.send", { to: "api-codex", type: "question", body: "ready?" });
    const [msg] = await eventually(() => api.call("inbox.pull", { limit: 5 }), (m) => m.length > 0);
    expect(msg).toMatchObject({ from: "web-claude", fromClient: "claude-code", fromOwner: "tester" });

    const players = await eventually(() => web.call("lobby.players"), (p) => p.some((a: { status: string }) => a.status === "busy"));
    expect(players.find((a: { handle: string }) => a.handle === "api-codex")).toMatchObject({ status: "busy", workingOn: "order status API" });
  });
});
