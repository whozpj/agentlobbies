import { signEnvelope, webCrypto } from "@agentlobbies/protocol";
import { ulid } from "ulid";
import { beforeAll, describe, expect, it } from "vitest";
import { ORIGIN, TestSocket, addAgent, addPerson, api, boxKey, createInvite, createLobby, fakeGitHub, member, postJson, randomIp, signIn, web, webSignIn, type Account } from "./client";

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
    expect(message).toEqual({
      id: envelope.id, seq: expect.any(Number), from: "web-claude", fromAgentId: agent.agentId, to: "all", type: "question",
      inReplyTo: null, committedAt: expect.any(Number), sealed: { epoch: 1, iv: "aXZpdml2aXZpdml2", data: "Y2lwaGVydGV4dA" },
    });

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
    // The content arrives still encrypted; only a member's device can open it.
    expect(meta.message).toMatchObject({ id: envelope.id, from: "watched", to: "all", sealed: { data: "Y2lwaGVydGV4dA" } });
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
    expect((machines as unknown as { machines: unknown[] }).machines).toEqual([
      { machineId: machine.machineId, name: "test-mac", online: true, agents: [{ ...agent, secure: false, pendingApprovals: 0 }] },
    ]);

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

describe("who can do what (security)", () => {
  it("refuses a forged or swapped token in every place one is accepted", async () => {
    const machine = await signIn("tokens");
    const cookie = await webSignIn("tokens");
    const session = cookie.split("=")[1]!;

    expect((await web("/v1/me", `__Host-session=${session.slice(0, -4)}AAAA`)).status).toBe(401);
    expect((await web("/v1/me", `__Host-session=${machine.token}`)).status).toBe(401);
    expect((await api("/v1/me", { headers: { authorization: `Bearer ${session}` } })).status).toBe(401);

    const machineWs = await api("/v1/me/ws", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `agentlobbies.v1, account.${session}` } });
    expect(machineWs.status).toBe(401);
  });

  it("keeps daemon-only routes away from browsers", async () => {
    const cookie = await webSignIn("browser-only");
    expect((await web("/v1/auth/box-key", cookie, { method: "POST", body: { boxPublicKey: "cHVi" } })).status).toBe(403);
    expect((await web("/v1/auth/logout", cookie, { method: "POST", body: {} })).status).toBe(403);
  });

  it("refuses cookie deletes from another site", async () => {
    const owner = await signIn("delete-owner");
    const lobby = await createLobby("delete-owner", owner);
    const agent = await addAgent(lobby.lobbyId, "web-claude", owner);
    const cookie = await webSignIn("delete-owner");
    const res = await web(`/v1/lobbies/${lobby.lobbyId}/agents/${agent.agentId}`, cookie, { method: "DELETE", origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await web(`/v1/lobbies/${lobby.lobbyId}/agents/${agent.agentId}`, cookie, { method: "DELETE" })).status).toBe(200);
  });

  it("only lets the owner invite, and only members see a lobby", async () => {
    const lobby = await createLobby("gated");
    const { token } = await createInvite(lobby);
    const memberCookie = await webSignIn("gated-member");
    await web("/v1/invites/accept", memberCookie, { method: "POST", body: { token } });
    expect((await web(`/v1/lobbies/${lobby.lobbyId}/invites`, memberCookie, { method: "POST", body: {} })).status).toBe(403);

    const strangerCookie = await webSignIn("gated-stranger");
    expect((await web(`/v1/lobbies/${lobby.lobbyId}/events`, strangerCookie)).status).toBe(403);
    expect((await web(`/v1/lobbies/${lobby.lobbyId}/members/gated-member`, strangerCookie, { method: "DELETE" })).status).toBe(403);
    const lobbies = await (await web("/v1/lobbies", strangerCookie)).json<unknown[]>();
    expect(lobbies).toEqual([]);
  });

  it("doesn't let a member remove someone else's agent, but lets the owner", async () => {
    const owner = await signIn("agent-owner");
    const lobby = await createLobby("agent-owner", owner);
    const bob = await member(lobby, "agent-bob");
    const carol = await member(lobby, "agent-carol");
    const bobsAgent = await addAgent(lobby.lobbyId, "bob-claude", bob);
    const remove = (as: Account) => api(`/v1/lobbies/${lobby.lobbyId}/agents/${bobsAgent.agentId}`, { method: "DELETE", headers: { authorization: `Bearer ${as.token}` } });
    expect((await remove(carol)).status).toBe(403);
    expect((await remove(owner)).status).toBe(200);
  });

  it("removes a signed-out machine's agents, so their sockets are refused", async () => {
    const owner = await signIn("revoked");
    const lobby = await createLobby("revoked", owner);
    await postJson("/v1/auth/logout", {}, randomIp(), owner.token);
    expect(await (await TestSocket.open(lobby, owner)).closed()).toBe(4003);
  });

  it("gives a viewer's socket the key but no way to send", async () => {
    const lobby = await createLobby("view-host");
    const { token } = await createInvite(lobby, { role: "viewer" });
    const viewer = await signIn("viewer-person");
    await api("/v1/invites/accept", { method: "POST", headers: { authorization: `Bearer ${viewer.token}`, "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const seat = await addPerson(lobby.lobbyId, "viewer-person", viewer);
    const ws = await TestSocket.open(seat, viewer);
    const welcome = await ws.hello();
    expect(welcome.role).toBe("observer");
    expect((await ws.next("keys")).machines.map((m) => m.machineId)).toContain(viewer.machineId);

    const envelope = await signEnvelope(webCrypto, seat.keys.secretKey, {
      v: 2, id: ulid(), lobbyId: lobby.lobbyId, from: seat.agentId, to: { kind: "broadcast" },
      type: "update", threadDepth: 0, sealed: { epoch: 1, iv: "aXZpdml2aXZpdml2", data: "Y2lwaGVydGV4dA" }, createdAt: Date.now(),
    });
    const reqId = ulid();
    ws.send({ t: "send", reqId, envelope });
    expect(await ws.next("err", (f) => f.reqId === reqId)).toMatchObject({ code: "forbidden" });
  });
});

describe("the browser as a device (LLD 15.11)", () => {
  it("registers a browser's key, asks member machines to seal the lobby key to it, and hands it only its own sealed keys", async () => {
    const owner = await signIn("device-owner");
    const lobby = await createLobby("device-owner", owner);
    const ownerSocket = await TestSocket.open(lobby, owner);
    await ownerSocket.hello();
    ownerSocket.send({ t: "keys.put", reqId: ulid(), epoch: 1, create: true, sealed: [{ machineId: owner.machineId, sealed: "c2VhbGVk" }] });
    await ownerSocket.next("keys", (f) => f.current === 1);

    const cookie = await webSignIn("device-owner");
    const registered = await web("/v1/me/devices", cookie, { method: "POST", body: { boxPublicKey: await boxKey(), name: "Web browser" } });
    expect(registered.status).toBe(201);
    const { machineId } = await registered.json<{ machineId: string }>();
    const asked = await ownerSocket.next("keys", (f) => f.missing.some((m) => m.machineId === machineId));
    expect(asked.machines.map((m) => m.machineId)).toContain(machineId);

    ownerSocket.send({ t: "keys.put", reqId: ulid(), epoch: 1, create: false, sealed: [{ machineId, sealed: "Zm9yLWJyb3dzZXI" }] });
    await ownerSocket.next("ok");
    const keys = await web(`/v1/lobbies/${lobby.lobbyId}/keys?device=${machineId}`, cookie);
    expect(await keys.json()).toEqual([{ epoch: 1, sealed: "Zm9yLWJyb3dzZXI" }]);
    expect((await web(`/v1/lobbies/${lobby.lobbyId}/keys?device=${owner.machineId}`, await webSignIn("device-stranger"))).status).toBe(403);
  });

  it("removes the browser on sign-out, which makes its lobbies change keys", async () => {
    const owner = await signIn("device-leaver");
    const lobby = await createLobby("device-leaver", owner);
    const ownerSocket = await TestSocket.open(lobby, owner);
    await ownerSocket.hello();
    ownerSocket.send({ t: "keys.put", reqId: ulid(), epoch: 1, create: true, sealed: [{ machineId: owner.machineId, sealed: "c2VhbGVk" }] });
    await ownerSocket.next("keys", (f) => f.current === 1);

    const cookie = await webSignIn("device-leaver");
    const { machineId } = await (await web("/v1/me/devices", cookie, { method: "POST", body: { boxPublicKey: await boxKey(), name: "Web browser" } })).json<{ machineId: string }>();
    expect((await web(`/v1/me/devices/${machineId}`, cookie, { method: "DELETE" })).status).toBe(200);
    const rotate = await ownerSocket.next("keys", (f) => f.rotate);
    expect(rotate.machines.map((m) => m.machineId)).not.toContain(machineId);
  });

  it("only lets a browser register as a device, not a machine's account token", async () => {
    const machine = await signIn("device-machine");
    const res = await api("/v1/me/devices", { method: "POST", headers: { authorization: `Bearer ${machine.token}`, "content-type": "application/json" }, body: JSON.stringify({ boxPublicKey: "eA", name: "x" }) });
    expect(res.status).toBe(403);
  });
});

describe("devices", () => {
  it("lists a user's machines and browsers, and revoking one stops it and changes the lobby key", async () => {
    const laptop = await signIn("devices-user");
    const lobby = await createLobby("devices-user", laptop);
    const socket = await TestSocket.open(lobby, laptop);
    await socket.hello();
    socket.send({ t: "keys.put", reqId: ulid(), epoch: 1, create: true, sealed: [{ machineId: laptop.machineId, sealed: "c2VhbGVk" }] });
    await socket.next("keys", (f) => f.current === 1);
    const oldLaptop = await signIn("devices-user");
    const cookie = await webSignIn("devices-user");
    await web("/v1/me/devices", cookie, { method: "POST", body: { boxPublicKey: await boxKey(), name: "Web browser (MacIntel)" } });

    const listed = await (await api("/v1/me/devices", { headers: { authorization: `Bearer ${laptop.token}` } }))
      .json<{ deviceId: string; kind: string; current: boolean; name: string }[]>();
    expect(listed.map((d) => d.kind).sort()).toEqual(["browser", "machine", "machine"]);
    expect(listed.find((d) => d.current)?.deviceId).toBe(laptop.machineId);

    expect((await web(`/v1/me/devices/${oldLaptop.machineId}`, cookie, { method: "DELETE" })).status).toBe(200);
    expect((await socket.next("keys", (f) => f.rotate)).machines.map((m) => m.machineId)).not.toContain(oldLaptop.machineId);
    expect((await api("/v1/me", { headers: { authorization: `Bearer ${oldLaptop.token}` } })).status).toBe(401);
    const after = await (await web("/v1/me/devices", cookie)).json<{ deviceId: string }[]>();
    expect(after.map((d) => d.deviceId)).not.toContain(oldLaptop.machineId);
  });

  it("won't revoke someone else's device", async () => {
    const mine = await signIn("devices-mine");
    const cookie = await webSignIn("devices-other");
    await web(`/v1/me/devices/${mine.machineId}`, cookie, { method: "DELETE" });
    expect((await api("/v1/me", { headers: { authorization: `Bearer ${mine.token}` } })).status).toBe(200);
  });
});

describe("your data", () => {
  it("exports what the relay keeps about you, with no message content", async () => {
    const machine = await signIn("exporter");
    const lobby = await createLobby("exporter", machine);
    const res = await api("/v1/me/export", { headers: { authorization: `Bearer ${machine.token}` } });
    expect(res.headers.get("content-disposition")).toContain("agentlobbies-account.json");
    const data = await res.json<{ user: { login: string }; devices: unknown[]; lobbies: { lobby_id: string; role: string }[] }>();
    expect(data.user.login).toBe("exporter");
    expect(data.devices).toHaveLength(1);
    expect(data.lobbies).toEqual([expect.objectContaining({ lobby_id: lobby.lobbyId, role: "owner" })]);
  });

  it("deletes an account: owned lobbies close for everyone, other lobbies drop the person and change keys", async () => {
    const leaver = await signIn("account-leaver");
    const owned = await createLobby("account-leaver", leaver);
    const other = await createLobby("someone-else");
    const otherSocket = await TestSocket.open(other, other.account);
    await otherSocket.hello();
    otherSocket.send({ t: "keys.put", reqId: ulid(), epoch: 1, create: true, sealed: [{ machineId: other.account.machineId, sealed: "c2VhbGVk" }] });
    await otherSocket.next("keys", (f) => f.current === 1);
    const { token } = await createInvite(other);
    await api("/v1/invites/accept", { method: "POST", headers: { authorization: `Bearer ${leaver.token}`, "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const ownedSocket = await TestSocket.open(owned, leaver);
    await ownedSocket.hello();

    const cookie = await webSignIn("account-leaver");
    const res = await web("/v1/me", cookie, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await ownedSocket.closed()).toBe(4010);
    expect((await otherSocket.next("keys", (f) => f.rotate)).machines.map((m) => m.machineId)).toEqual([other.account.machineId]);
    expect((await api("/v1/me", { headers: { authorization: `Bearer ${leaver.token}` } })).status).toBe(401);
  });

  it("caps how many devices an account adds in a day", async () => {
    const cookie = await webSignIn("device-spammer");
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await web("/v1/me/devices", cookie, { method: "POST", body: { boxPublicKey: await boxKey(), name: `b${i}` } })).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});
