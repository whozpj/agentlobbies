import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { Daemon } from "../src/daemon";

const relayUrl = inject("relayUrl");
const running: Daemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

async function setup(agentJoin: "allow" | "confirm" = "allow") {
  const staticDir = mkdtempSync(join(tmpdir(), "al-static-"));
  mkdirSync(join(staticDir, "assets"));
  writeFileSync(join(staticDir, "index.html"), "<html>dashboard</html>");
  writeFileSync(join(staticDir, "assets", "app.js"), "console.log(1)");
  const daemon = new Daemon({ home: mkdtempSync(join(tmpdir(), "al-home-")), relayUrl, agentJoin, dashboardDir: staticDir });
  await daemon.start();
  running.push(daemon);
  await daemon.call("account.login", { githubToken: "gho_fake_tester" });
  const { sessionId } = await daemon.call("session.open", { client: "cli", cwd: mkdtempSync(join(tmpdir(), "host-")) });
  const host = (method: string, params: Record<string, unknown> = {}) => daemon.call(method, { sessionId, ...params });
  const { code } = await host("lobby.create", { handle: "prithvi", name: "food-app" });
  const { url } = await daemon.call("dashboard.start", {});
  const base = new URL(url);
  return { daemon, host, code, base, token: base.searchParams.get("token")! };
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

  it("approves a pending join over POST", async () => {
    const { daemon, base, token, code } = await setup("confirm");
    const { sessionId } = await daemon.call("session.open", { client: "claude-code", cwd: mkdtempSync(join(tmpdir(), "web-")) });
    await daemon.call("lobby.join", { sessionId, code, handle: "web-claude", owns: ["web"], source: "agent" }).catch(() => {});
    const [pending] = JSON.parse((await get(base, `/api/approvals?token=${token}`)).body);
    const res = await new Promise<number>((resolve) => {
      request({ host: "127.0.0.1", port: base.port, method: "POST", path: `/api/approvals/${pending.id}?token=${token}`,
                headers: { "content-type": "application/json" } }, (r) => { r.resume(); resolve(r.statusCode!); })
        .end(JSON.stringify({ approve: true }));
    });
    expect(res).toBe(200);
    expect(await daemon.call("lobby.status", { sessionId })).toMatchObject({ handle: "web-claude" });
  });

  it("serves the app, with index.html for client-side routes", async () => {
    const { base } = await setup();
    expect((await get(base, "/assets/app.js")).type).toContain("javascript");
    expect((await get(base, "/lobbies/abc")).body).toContain("dashboard");
    expect((await get(base, "/../../etc/passwd")).body).not.toContain("root:");
  });
});
