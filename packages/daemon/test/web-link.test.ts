import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { Daemon } from "../src/daemon";
import { agentSession, eventually, freshUser } from "./lobby-helpers";

const relayUrl = inject("relayUrl");
const ORIGIN = "http://localhost"; // PUBLIC_URL in the relay's test config
const running: Daemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

/** Signs in through the web flow as the same GitHub user as `githubToken`, returning the session cookie. */
async function webSession(githubToken: string): Promise<string> {
  const start = await fetch(`${relayUrl}/auth/github/login`, { redirect: "manual" });
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  const user = githubToken.replace(/^gho_fake_/, "");
  const done = await fetch(`${relayUrl}/auth/github/callback?code=code-${user}&state=${state}`, {
    redirect: "manual", headers: { cookie: start.headers.get("set-cookie")!.split(";")[0]! },
  });
  return done.headers.getSetCookie().find((c) => c.startsWith("__Host-session=ey"))!.split(";")[0]!;
}

describe("the hosted dashboard reaching this machine", () => {
  it("lists this machine's agents and adds one to a lobby from the browser", async () => {
    const githubToken = freshUser("webby");
    const daemon = new Daemon({ home: mkdtempSync(join(tmpdir(), "al-home-")), relayUrl });
    await daemon.start();
    running.push(daemon);
    await daemon.call("account.login", { githubToken });
    const web = await agentSession(daemon, "claude-code", "web");
    const { lobbyId } = await daemon.call("lobby.create", { name: "from-the-web" });

    const cookie = await webSession(githubToken);
    const machines = await eventually(
      () => fetch(`${relayUrl}/v1/me/agents`, { headers: { cookie } }).then((r) => r.json() as Promise<any[]>),
      (m) => m[0]?.online && m[0].agents.some((a: { folder: string }) => a.folder === "web"),
    );
    const [machine] = machines;

    const res = await fetch(`${relayUrl}/v1/lobbies/${lobbyId}/agents`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ machineId: machine.machineId, seatKey: web.seatKey, owns: ["web"] }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ handle: "web-claude" });

    const [notice] = await eventually(() => web.call("inbox.pull", { limit: 5 }), (m) => m.length > 0);
    expect(notice.body).toContain("You were added to lobby from-the-web by @webby");
  });

  it("joins a lobby on this machine when the invite is accepted in the browser", async () => {
    const owner = new Daemon({ home: mkdtempSync(join(tmpdir(), "al-home-")), relayUrl });
    await owner.start();
    running.push(owner);
    await owner.call("account.login", { githubToken: freshUser("host") });
    const { lobbyId } = await owner.call("lobby.create", { name: "invited" });
    const { url } = await owner.call("invite.create", { lobbyId });

    const githubToken = freshUser("guest");
    const guest = new Daemon({ home: mkdtempSync(join(tmpdir(), "al-home-")), relayUrl });
    await guest.start();
    running.push(guest);
    await guest.call("account.login", { githubToken });
    const cookie = await webSession(githubToken);
    const accepted = await fetch(`${relayUrl}/v1/invites/accept`, {
      method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ token: url.split("/").pop() }),
    });
    expect(accepted.status).toBe(200);

    const lobbies = await eventually(() => guest.call("dashboard.lobbies", {}), (l) => l.length === 1);
    expect(lobbies[0]).toMatchObject({ lobbyId, name: "invited", myRole: "member" });
  });
});
