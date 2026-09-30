import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { Daemon } from "../src/daemon";
import { add, agentSession } from "./lobby-helpers";

const relayUrl = inject("relayUrl");
const running: Daemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

async function setup() {
  const daemon = new Daemon({ home: mkdtempSync(join(tmpdir(), "al-home-")), relayUrl });
  await daemon.start();
  running.push(daemon);
  await daemon.call("account.login", { githubToken: "gho_fake_tester" });
  const { sessionId } = await daemon.call("session.open", { client: "person", cwd: tmpdir() });
  const host = (method: string, params: Record<string, unknown> = {}) => daemon.call(method, { sessionId, ...params });
  const webAgent = await agentSession(daemon, "claude-code", "web");
  const { lobbyId } = await daemon.call("lobby.create", { name: "food-app" });
  await add(daemon, lobbyId, webAgent, "web-claude", ["web"]);
  for (let i = 0; i < 100 && (await host("lobby.players")).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  return { daemon, host, web: webAgent.call, lobbyId };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

describe("dashboard data", () => {
  it("lists each lobby once with its roster and which local agents are in it", async () => {
    const { daemon, lobbyId } = await setup();
    const [lobby] = await daemon.call("dashboard.lobbies", {});
    expect(lobby).toMatchObject({ lobbyId, name: "food-app", myRole: "host" });
    expect(lobby.local.map((s: { handle: string }) => s.handle)).toEqual(["web-claude"]);
    expect(lobby.roster.map((a: { handle: string }) => a.handle).sort()).toEqual(["tester", "web-claude"]);
  });

  it("merges messages from every local agent in the lobby, once each, oldest first", async () => {
    const { daemon, host, web, lobbyId } = await setup();
    await host("message.send", { to: "web-claude", type: "question", body: "Is estimatedArrival ISO 8601?" });
    await web("message.send", { to: "all", type: "update", body: "Renamed etaMinutes to estimatedArrival" });

    const messages = await until(() => daemon.call("dashboard.messages", { lobbyId }), (m) => m.length === 2);
    expect(messages.map((m: { body: string }) => m.body)).toEqual(["Is estimatedArrival ISO 8601?", "Renamed etaMinutes to estimatedArrival"]);
    expect(messages[0]).toMatchObject({ from: "tester", to: "web-claude", type: "question" });
    expect(messages[1]).toMatchObject({ from: "web-claude", to: "all", type: "update" });
  });

  it("emits a live event for each new message", async () => {
    const { daemon, host } = await setup();
    const seen = new Promise<{ type: string; message: { body: string } }>((resolve) => {
      daemon.on("activity", (e) => { if (e.type === "message") resolve(e); });
    });
    await host("message.send", { to: "all", type: "update", body: "deploying now" });
    expect((await seen).message.body).toBe("deploying now");
  });
});
