import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { Daemon } from "../src/daemon";

const relayUrl = inject("relayUrl");
const running: Daemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

async function startDaemon(home = mkdtempSync(join(tmpdir(), "al-home-")), agentJoin: "allow" | "confirm" = "allow") {
  const daemon = new Daemon({ home, relayUrl, agentJoin });
  await daemon.start();
  running.push(daemon);
  return daemon;
}

/** Opens a session the way an MCP server would: one client in one working directory. */
async function session(daemon: Daemon, client: string, cwd: string) {
  const { sessionId } = await daemon.call("session.open", { client, cwd });
  return (method: string, params: Record<string, unknown> = {}) => daemon.call(method, { sessionId, ...params });
}

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (const deadline = Date.now() + 10_000; ; ) {
    const v = await fn();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("daemon against the real relay", () => {
  it("lets one agent ask another a question and read the answer (E1 shape)", async () => {
    const daemon = await startDaemon();
    const web = await session(daemon, "claude-code", mkdtempSync(join(tmpdir(), "web-")));
    const api = await session(daemon, "codex", mkdtempSync(join(tmpdir(), "api-")));

    const { code } = await web("lobby.create", { handle: "web-claude", name: "food-app" });
    await api("lobby.join", { code, handle: "api-codex", owns: ["api"] });
    await eventually(() => web("lobby.players"), (players) => players.length === 2);

    const sent = await web("message.send", { to: "owner:api", type: "question", body: "What field holds the ETA?" });
    expect(sent.seq).toBeGreaterThan(0);

    const [question] = await eventually(() => api("inbox.pull", { limit: 5 }), (m) => m.length > 0);
    expect(question).toMatchObject({ from: "web-claude", type: "question", body: "What field holds the ETA?" });

    await api("message.send", { to: "web-claude", type: "answer", inReplyTo: question.id, body: "estimatedArrival, ISO 8601" });
    const [answer] = await eventually(() => web("inbox.pull", { limit: 5 }), (m) => m.length > 0);
    expect(answer).toMatchObject({ from: "api-codex", type: "answer", inReplyTo: question.id });
  });

  it("catches up on messages sent while the daemon was stopped, in order, once (E5 shape)", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "al-home-"));
    const a = await startDaemon();
    let b = await startDaemon(homeA);
    const apiCwd = mkdtempSync(join(tmpdir(), "api-"));
    const web = await session(a, "claude-code", mkdtempSync(join(tmpdir(), "web-")));
    let api = await session(b, "codex", apiCwd);

    const { code } = await web("lobby.create", { handle: "web" });
    await api("lobby.join", { code, handle: "api" });
    await eventually(() => web("lobby.players"), (players) => players.length === 2);
    await eventually(() => api("lobby.status"), (s) => s.connection === "live");
    await b.stop();

    for (const n of [1, 2, 3]) await web("message.send", { to: "api", type: "question", body: `question ${n}` });

    b = await startDaemon(homeA);
    api = await session(b, "codex", apiCwd);
    const msgs = await eventually(() => api("inbox.peek"), (p) => p.unread >= 3);
    expect(msgs.unread).toBe(3);
    expect((await api("inbox.pull", { limit: 10 })).map((m: { body: string }) => m.body)).toEqual(["question 1", "question 2", "question 3"]);
  });

  it("refuses to send a message containing a secret", async () => {
    const daemon = await startDaemon();
    const web = await session(daemon, "claude-code", mkdtempSync(join(tmpdir(), "web-")));
    await web("lobby.create", { handle: "web" });
    await expect(web("message.send", { to: "all", type: "update", body: "use AKIAIOSFODNN7EXAMPLE" }))
      .rejects.toMatchObject({ code: "secret_detected" });
  });

  it("tells a session with no lobby to join one first", async () => {
    const daemon = await startDaemon();
    const web = await session(daemon, "claude-code", mkdtempSync(join(tmpdir(), "web-")));
    await expect(web("lobby.status")).rejects.toMatchObject({ code: "no_seat" });
  });

  it("holds an agent's own join until the human approves it (G42)", async () => {
    const daemon = await startDaemon(undefined, "confirm");
    const web = await session(daemon, "claude-code", mkdtempSync(join(tmpdir(), "web-")));
    const { code } = await web("lobby.create", { handle: "web" });
    const api = await session(daemon, "codex", mkdtempSync(join(tmpdir(), "api-")));

    await expect(api("lobby.join", { code, handle: "api", source: "agent" })).rejects.toMatchObject({ code: "join_pending" });
    const [request] = await daemon.call("approval.list", { scope: "join" });
    expect(request).toMatchObject({ client: "codex", handle: "api" });

    await daemon.call("approval.decide", { scope: "join", id: request.id, approve: true });
    expect(await api("lobby.status")).toMatchObject({ handle: "api", role: "member" });
    expect(await daemon.call("approval.list", { scope: "join" })).toEqual([]);
  });

  it("includes the sender's client in surfaced messages and updates presence", async () => {
    const daemon = await startDaemon();
    const web = await session(daemon, "claude-code", mkdtempSync(join(tmpdir(), "web-")));
    const api = await session(daemon, "codex", mkdtempSync(join(tmpdir(), "api-")));
    const { code } = await web("lobby.create", { handle: "web" });
    await api("lobby.join", { code, handle: "api" });
    await eventually(() => api("lobby.status"), (s) => s.connection === "live");
    await eventually(() => web("lobby.players"), (p) => p.length === 2);

    await api("presence.set", { status: "busy", workingOn: "order status API" });
    await web("message.send", { to: "api", type: "question", body: "ready?" });
    const [msg] = await eventually(() => api("inbox.pull", { limit: 5 }), (m) => m.length > 0);
    expect(msg).toMatchObject({ from: "web", fromClient: "claude-code" });

    const players = await eventually(() => web("lobby.players"), (p) => p.some((a: { status: string }) => a.status === "busy"));
    expect(players.find((a: { handle: string }) => a.handle === "api")).toMatchObject({ status: "busy", workingOn: "order status API" });
  });
});
