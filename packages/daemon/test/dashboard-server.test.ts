import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { Daemon } from "../src/daemon";
import { agentSession, freshUser } from "./lobby-helpers";

const relayUrl = inject("relayUrl");
const running: Daemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

async function setup() {
  const staticDir = mkdtempSync(join(tmpdir(), "al-static-"));
  mkdirSync(join(staticDir, "assets"));
  writeFileSync(join(staticDir, "index.html"), "<html>dashboard</html>");
  writeFileSync(join(staticDir, "assets", "app.js"), "console.log(1)");
  const daemon = new Daemon({ home: mkdtempSync(join(tmpdir(), "al-home-")), relayUrl, dashboardDir: staticDir });
  await daemon.start();
  running.push(daemon);
  await daemon.call("account.login", { githubToken: freshUser("tester") });
  const { sessionId } = await daemon.call("session.open", { client: "person", cwd: tmpdir() });
  const host = (method: string, params: Record<string, unknown> = {}) => daemon.call(method, { sessionId, ...params });
  await daemon.call("lobby.create", { name: "food-app" });
  const { url } = await daemon.call("dashboard.start", {});
  const base = new URL(url);
  return { daemon, host, base, token: base.searchParams.get("token")! };
}

function send(base: URL, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: base.port, method, path, headers: { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : undefined }));
    }).on("error", reject).end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function get(base: URL, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: base.port, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, body, type: res.headers["content-type"] }));
    }).on("error", reject).end();
  });
}

describe("dashboard server", () => {
  it("listens on localhost and hands out a URL with a token", async () => {
    const { base, token } = await setup();
    expect(base.hostname).toBe("127.0.0.1");
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it("refuses API calls without the token", async () => {
    const { base } = await setup();
    expect((await get(base, "/api/lobbies")).status).toBe(401);
  });

  it("refuses requests whose Host header is not localhost (DNS rebinding)", async () => {
    const { base, token } = await setup();
    expect((await get(base, `/api/lobbies?token=${token}`, { host: `evil.example:${base.port}` })).status).toBe(403);
  });

  it("serves lobbies as JSON", async () => {
    const { base, token } = await setup();
    const res = await get(base, `/api/lobbies?token=${token}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)[0]).toMatchObject({ name: "food-app" });
  });

  it("streams activity as server-sent events", async () => {
    const { base, token, host } = await setup();
    const firstMessage = new Promise<string>((resolve) => {
      request({ host: "127.0.0.1", port: base.port, path: `/api/events?token=${token}` }, (res) => {
        expect(res.headers["content-type"]).toContain("text/event-stream");
        let buffer = "";
        res.on("data", (d) => {
          buffer += d;
          const line = buffer.split("\n").find((l) => l.startsWith("data:") && l.includes('"message"'));
          if (line) { resolve(line); res.destroy(); }
        });
      }).end();
    });
    await new Promise((r) => setTimeout(r, 200));
    await host("message.send", { to: "all", type: "update", body: "hello dashboard" });
    expect(JSON.parse((await firstMessage).slice(5)).message.body).toBe("hello dashboard");
  });

  it("creates a lobby, invites, and adds and removes your agent", async () => {
    const { daemon, base, token } = await setup();
    const agent = await agentSession(daemon, "claude-code", "web");
    const q = `?token=${token}`;

    expect((await send(base, "GET", `/api/me${q}`)).body).toMatchObject({ login: "tester" });
    const created = await send(base, "POST", `/api/lobbies${q}`, { name: "checkout" });
    expect(created.status).toBe(200);
    const lobbyId = created.body.lobbyId;

    const invite = await send(base, "POST", `/api/lobbies/${lobbyId}/invites${q}`, { role: "member" });
    expect(invite.body.url).toContain("/invite/");

    const agents = (await send(base, "GET", `/api/agents${q}`)).body;
    expect(agents).toContainEqual(expect.objectContaining({ seatKey: agent.seatKey, folder: "web", online: true }));

    const added = await send(base, "POST", `/api/lobbies/${lobbyId}/agents${q}`, { seatKey: agent.seatKey, owns: ["web"] });
    expect(added.body).toMatchObject({ handle: "web-claude" });
    expect(await agent.call("lobby.status")).toMatchObject({ handle: "web-claude" });

    const edited = await send(base, "PATCH", `/api/lobbies/${lobbyId}/agents/${added.body.agentId}${q}`, { handle: "Web UI", owns: ["Frontend"] });
    expect(edited.body).toMatchObject({ handle: "web-ui", owns: ["frontend"] });

    expect((await send(base, "DELETE", `/api/lobbies/${lobbyId}/agents/${added.body.agentId}${q}`)).status).toBe(200);
    await expect(agent.call("lobby.status")).rejects.toMatchObject({ code: "no_seat" });
  });

  it("lets the owner remove a person, but not themselves", async () => {
    const { base, token } = await setup();
    const q = `?token=${token}`;
    const { lobbyId } = (await send(base, "POST", `/api/lobbies${q}`, { name: "people" })).body;
    const { url } = (await send(base, "POST", `/api/lobbies/${lobbyId}/invites${q}`, { role: "member" })).body;

    const guest = new Daemon({ home: mkdtempSync(join(tmpdir(), "al-home-")), relayUrl });
    await guest.start();
    running.push(guest);
    await guest.call("account.login", { githubToken: freshUser("guest") });
    await guest.call("invite.accept", { invite: url });

    expect((await send(base, "DELETE", `/api/lobbies/${lobbyId}/members/tester${q}`)).status).toBe(400);
    expect((await send(base, "DELETE", `/api/lobbies/${lobbyId}/members/guest${q}`)).status).toBe(200);
    for (let i = 0; i < 50 && (await guest.call("dashboard.lobbies", {})).length > 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await guest.call("dashboard.lobbies", {})).toEqual([]);
  });

  it("serves the app, with index.html for client-side routes", async () => {
    const { base } = await setup();
    expect((await get(base, "/assets/app.js")).type).toContain("javascript");
    expect((await get(base, "/lobbies/abc")).body).toContain("dashboard");
    expect((await get(base, "/../../etc/passwd")).body).not.toContain("root:");
  });
});
