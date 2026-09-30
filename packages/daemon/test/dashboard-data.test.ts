import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { Daemon } from "../src/daemon";

const relayUrl = inject("relayUrl");
const running: Daemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

async function setup() {
  const daemon = new Daemon({ home: mkdtempSync(join(tmpdir(), "al-home-")), relayUrl, agentJoin: "allow" });
  await daemon.start();
  running.push(daemon);
  const session = async (client: string) => {
    const { sessionId } = await daemon.call("session.open", { client, cwd: mkdtempSync(join(tmpdir(), `${client}-`)) });
    return (method: string, params: Record<string, unknown> = {}) => daemon.call(method, { sessionId, ...params });
  };
  const host = await session("cli");
  const web = await session("claude-code");
  const { code, lobbyId } = await host("lobby.create", { handle: "prithvi", name: "food-app" });
  await web("lobby.join", { code, handle: "web-claude", owns: ["web"] });
  for (let i = 0; i < 100 && (await host("lobby.players")).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  return { daemon, host, web, lobbyId };
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
    expect(lobby).toMatchObject({ lobbyId, name: "food-app" });
    expect(lobby.local.map((s: { handle: string }) => s.handle).sort()).toEqual(["prithvi", "web-claude"]);
    expect(lobby.roster.map((a: { handle: string }) => a.handle).sort()).toEqual(["prithvi", "web-claude"]);
  });

  it("merges messages from every local agent in the lobby, once each, oldest first", async () => {
    const { daemon, host, web, lobbyId } = await setup();
    await host("message.send", { to: "web-claude", type: "question", body: "Is estimatedArrival ISO 8601?" });
    await web("message.send", { to: "all", type: "update", body: "Renamed etaMinutes to estimatedArrival" });

    const messages = await until(() => daemon.call("dashboard.messages", { lobbyId }), (m) => m.length === 2);
    expect(messages.map((m: { body: string }) => m.body)).toEqual(["Is estimatedArrival ISO 8601?", "Renamed etaMinutes to estimatedArrival"]);
    expect(messages[0]).toMatchObject({ from: "prithvi", to: "web-claude", type: "question" });
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
