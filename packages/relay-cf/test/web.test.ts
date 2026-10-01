import { signEnvelope, webCrypto } from "@agentlobbies/protocol";
import { ulid } from "ulid";
import { beforeAll, describe, expect, it } from "vitest";
import { ORIGIN, TestSocket, addAgent, addPerson, api, createInvite, createLobby, fakeGitHub, member, signIn, web, webSignIn, type Account } from "./client";

beforeAll(() => fakeGitHub());

/** Opens a WebSocket the way a browser on the hosted dashboard would: cookie and Origin, no tokens. */
async function browserSocket(path: string, cookie: string, origin: string = ORIGIN): Promise<TestSocket> {
  const res = await api(path, { headers: { Upgrade: "websocket", cookie, origin } });
  if (!res.webSocket) throw new Error(`upgrade failed: ${res.status}`);
  return new TestSocket(res.webSocket);
}

/** A daemon's socket to its user object. */
async function machineSocket(account: Account): Promise<TestSocket> {
  const res = await api("/v1/me/ws", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `agentlobbies.v1, account.${account.token}` } });
  if (!res.webSocket) throw new Error(`upgrade failed: ${res.status}`);
  return new TestSocket(res.webSocket);
}

describe("web sign-in (LLD 15.6)", () => {
  it("sends the browser to GitHub with a state it remembers in a cookie", async () => {
    const res = await api("/auth/github/login?return=/invite/abc");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("redirect_uri")).toMatch(/\/auth\/github\/callback$/);
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-oauth=[\w-]+\.%2Finvite%2Fabc; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  });

  it("starts a session and returns to the page the user came from", async () => {
    const start = await api("/auth/github/login?return=/invite/abc");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const res = await api(`/auth/github/callback?code=code-web-alice&state=${state}`, { headers: { cookie: start.headers.get("set-cookie")!.split(";")[0]! } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/invite/abc");
    const session = res.headers.getSetCookie().find((c) => c.startsWith("__Host-session=ey"));
    expect(session).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    const me = await web("/v1/me", session!.split(";")[0]!);
    expect(await me.json()).toMatchObject({ login: "web-alice" });
  });

  it("refuses a callback whose state doesn't match", async () => {
    const start = await api("/auth/github/login");
    const res = await api("/auth/github/callback?code=code-web-mallory&state=forged", { headers: { cookie: start.headers.get("set-cookie")!.split(";")[0]! } });
    expect(res.headers.get("location")).toBe("/?signin=failed");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-session=ey"))).toBe(false);
  });

  it("never redirects off the site after sign-in", async () => {
    const start = await api("/auth/github/login?return=//evil.example");
    expect(start.headers.get("set-cookie")).toMatch(/^__Host-oauth=[\w-]+\.%2F;/);
  });

  it("refuses requests without a session, and clears it on sign-out", async () => {
    expect((await api("/v1/me")).status).toBe(401);
    const cookie = await webSignIn("web-leaver");
    const out = await web("/auth/logout", cookie, { method: "POST" });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/^__Host-session=; .*Max-Age=0/);
  });
});

describe("the hosted dashboard's API", () => {
  it("creates and lists lobbies for a browser session", async () => {
    const cookie = await webSignIn("web-creator");
    const created = await web("/v1/lobbies", cookie, { method: "POST", body: { name: "web-made" } });
    expect(created.status).toBe(201);
    const lobbies = await (await web("/v1/lobbies", cookie)).json<{ name: string; role: string; keyEpoch: number }[]>();
    expect(lobbies).toEqual([expect.objectContaining({ name: "web-made", role: "owner", keyEpoch: 0, roster: [] })]);
  });

  it("refuses cookie requests that change things unless they come from the dashboard's own origin", async () => {
    const cookie = await webSignIn("web-csrf");
    expect((await web("/v1/lobbies", cookie, { method: "POST", body: {}, origin: null })).status).toBe(403);
    expect((await web("/v1/lobbies", cookie, { method: "POST", body: {}, origin: "https://evil.example" })).status).toBe(403);
  });

  it("previews an invite and joins with it from the browser", async () => {
    const lobby = await createLobby("invite-host");
    const { token } = await createInvite(lobby);
    const preview = await api(`/v1/invites/${token}`);
    expect(await preview.json()).toEqual({ lobbyName: "invite-host-lobby", role: "member", invitedBy: "owner-invite-host" });
    expect((await api("/v1/invites/not-a-real-invite-token-xx")).status).toBe(404);

    const cookie = await webSignIn("web-joiner");
    const accepted = await web("/v1/invites/accept", cookie, { method: "POST", body: { token } });
    expect(await accepted.json()).toMatchObject({ lobbyId: lobby.lobbyId, role: "member" });
    const lobbies = await (await web("/v1/lobbies", cookie)).json<{ lobbyId: string }[]>();
    expect(lobbies.map((l) => l.lobbyId)).toEqual([lobby.lobbyId]);
  });

  it("doesn't let a browser add a person seat; only the app on a machine can", async () => {
    const cookie = await webSignIn("web-person");
    const { lobbyId } = await (await web("/v1/lobbies", cookie, { method: "POST", body: {} })).json<{ lobbyId: string }>();
    const person = { handle: "web-person", client: "cli", owns: [], workingOn: "", publicKey: "cHVi" };
    expect((await web(`/v1/lobbies/${lobbyId}/people`, cookie, { method: "POST", body: { person } })).status).toBe(403);
  });

  it("shows who messaged whom without any content, and only to members", async () => {
    const owner = await signIn("meta-owner");
    const lobby = await createLobby("meta-owner", owner);
    const agent = await addAgent(lobby.lobbyId, "web-claude", owner);
    const ws = await TestSocket.open(agent);
    await ws.hello();
    const envelope = await signEnvelope(webCrypto, agent.keys.secretKey, {
      v: 2, id: ulid(), lobbyId: lobby.lobbyId, from: agent.agentId, to: { kind: "broadcast" },
      type: "question", threadDepth: 0, sealed: { epoch: 1, iv: "aXZpdml2aXZpdml2", data: "Y2lwaGVydGV4dA" }, createdAt: Date.now(),
    });
    ws.send({ t: "send", reqId: ulid(), envelope });
    await ws.next("ok");

    const events = await api(`/v1/lobbies/${lobby.lobbyId}/events`, { headers: { authorization: `Bearer ${owner.token}` } });
    const [message] = await events.json<Record<string, unknown>[]>();
    expect(message).toEqual({ id: envelope.id, seq: expect.any(Number), from: "web-claude", to: "all", type: "question", inReplyTo: null, committedAt: expect.any(Number) });

    const stranger = await signIn("meta-stranger");
    expect((await api(`/v1/lobbies/${lobby.lobbyId}/events`, { headers: { authorization: `Bearer ${stranger.token}` } })).status).toBe(403);
  });

  it("lets the owner remove a member and a member leave, but not the owner leave", async () => {
    const owner = await signIn("rm-owner");
    const lobby = await createLobby("rm-owner", owner);
    const bob = await member(lobby, "rm-bob");
    const carol = await member(lobby, "rm-carol");
    const remove = (login: string, as: Account) => api(`/v1/lobbies/${lobby.lobbyId}/members/${login}`, { method: "DELETE", headers: { authorization: `Bearer ${as.token}` } });

    expect((await remove("rm-carol", bob)).status).toBe(403);
    expect((await remove("rm-owner", owner)).status).toBe(403);
    expect((await remove("rm-bob", owner)).status).toBe(200);
    expect((await remove("rm-carol", carol)).status).toBe(200);
    expect((await remove("rm-carol", owner)).status).toBe(404);
  });
});

describe("watching a lobby live", () => {
  it("streams roster changes and message metadata to members, from the dashboard's origin only", async () => {
    const lobby = await createLobby("watched");
    const { token } = await createInvite(lobby);
    const cookie = await webSignIn("web-watcher");
    await web("/v1/invites/accept", cookie, { method: "POST", body: { token } });

    const refused = await api(`/v1/lobbies/${lobby.lobbyId}/watch`, { headers: { Upgrade: "websocket", cookie, origin: "https://evil.example" } });
    expect(refused.status).toBe(403);

    const watcher = await browserSocket(`/v1/lobbies/${lobby.lobbyId}/watch`, cookie);
    const ws = await TestSocket.open(lobby);
    await ws.hello();
    await watcher.next("roster", (f) => f.agent.handle === "watched");
    const envelope = await signEnvelope(webCrypto, lobby.keys.secretKey, {
      v: 2, id: ulid(), lobbyId: lobby.lobbyId, from: lobby.agentId, to: { kind: "broadcast" },
      type: "update", threadDepth: 0, sealed: { epoch: 1, iv: "aXZpdml2aXZpdml2", data: "Y2lwaGVydGV4dA" }, createdAt: Date.now(),
    });
    ws.send({ t: "send", reqId: ulid(), envelope });
    const meta = await watcher.next("meta");
    expect(meta.message).toMatchObject({ id: envelope.id, from: "watched", to: "all" });
    expect(JSON.stringify(watcher.frames)).not.toContain("Y2lwaGVydGV4dA");
  });

  it("refuses to let a non-member watch", async () => {
    const lobby = await createLobby("private");
    const cookie = await webSignIn("web-nosy");
    const res = await api(`/v1/lobbies/${lobby.lobbyId}/watch`, { headers: { Upgrade: "websocket", cookie, origin: ORIGIN } });
    expect(res.status).toBe(403);
  });
});

describe("reaching your machines from the web", () => {
  it("lists a machine's agents live and asks it to add one to a lobby", async () => {
    const machine = await signIn("web-reach");
    const lobby = await createLobby("web-reach", machine);
    const cookie = await webSignIn("web-reach");
    const daemon = await machineSocket(machine);
    const live = await browserSocket("/v1/me/live", cookie);

    const agent = { seatKey: "abc123", client: "claude-code", folder: "web", online: true, lobbies: [] };
    daemon.send({ t: "agents", agents: [agent] });
    const machines = await live.next("machines" as never, (f: { machines: { agents: unknown[] }[] }) => f.machines[0]?.agents.length === 1);
    expect((machines as unknown as { machines: unknown[] }).machines).toEqual([{ machineId: machine.machineId, name: "test-mac", online: true, agents: [agent] }]);

    const adding = web(`/v1/lobbies/${lobby.lobbyId}/agents`, cookie, { method: "POST", body: { machineId: machine.machineId, seatKey: "abc123", owns: ["web"] } });
    const call = (await daemon.next("call" as never)) as unknown as { id: string; method: string; params: Record<string, unknown> };
    expect(call).toMatchObject({ method: "lobby.addAgent", params: { lobbyId: lobby.lobbyId, seatKey: "abc123", owns: ["web"] } });
    daemon.send({ t: "result", id: call.id, result: { handle: "web-claude" } });
    const res = await adding;
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ handle: "web-claude" });
  });

  it("says the machine is offline when its app isn't connected", async () => {
    const machine = await signIn("web-offline");
    const lobby = await createLobby("web-offline", machine);
    const cookie = await webSignIn("web-offline");
    const res = await web(`/v1/lobbies/${lobby.lobbyId}/agents`, cookie, { method: "POST", body: { machineId: machine.machineId, seatKey: "x" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "machine_offline" } });
  });

  it("tells the user's machines when their lobbies change", async () => {
    const machine = await signIn("web-notified");
    const daemon = await machineSocket(machine);
    const lobby = await createLobby("notifier");
    const { token } = await createInvite(lobby);
    await api("/v1/invites/accept", { method: "POST", headers: { authorization: `Bearer ${machine.token}`, "content-type": "application/json" }, body: JSON.stringify({ token }) });
    await daemon.next("lobbies" as never);
    await addPerson(lobby.lobbyId, "web-notified", machine);
  });
});
