import { refreshSigningBytes, signEnvelope, toB64u, webCrypto, type Recipient, type ServerFrame } from "@agentlobbies/protocol";
import { ulid } from "ulid";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ORIGIN, TestSocket, addAgent, api, boxKey, createLobby, fakeGitHub, member, postJson, randomIp, signIn, web, webSignIn, type Seat,
} from "./client";

beforeAll(() => fakeGitHub());

/** Sends a sealed message from `seat` and returns the relay's answer to it. */
async function send(ws: TestSocket, seat: Seat, to: Recipient, epoch = 1) {
  const envelope = await signEnvelope(webCrypto, seat.keys.secretKey, {
    v: 2, id: ulid(), lobbyId: seat.lobbyId, from: seat.agentId, to, type: "update", threadDepth: 0,
    sealed: { epoch, iv: "aXZpdml2aXZpdml2", data: "Y2lwaGVydGV4dA" }, createdAt: Date.now(),
  });
  const reqId = ulid();
  ws.send({ t: "send", reqId, envelope });
  const answer = await ws.next("ok" as const, (f) => f.reqId === reqId).catch(() => ws.next("err", (f) => f.reqId === reqId));
  return { envelope, answer };
}

async function connect(seat: Seat): Promise<TestSocket> {
  const ws = await TestSocket.open(seat);
  await ws.hello();
  return ws;
}

/** Waits a moment, then says whether `ws` received anything about message `id`. */
async function heardOf(ws: TestSocket, id: string): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return ws.frames.some((f: ServerFrame) => (f.t === "event" && f.event.kind === "message" && f.event.envelope.id === id) || (f.t === "meta" && f.message.id === id));
}

async function refresh(seat: Seat) {
  const ts = Date.now();
  const sig = await webCrypto.sign(seat.keys.secretKey, refreshSigningBytes({ lobbyId: seat.lobbyId, agentId: seat.agentId, ts }));
  return postJson(`/v1/lobbies/${seat.lobbyId}/token`, { agentId: seat.agentId, ts, sig: toB64u(sig) });
}

describe("agent sockets can't pass as dashboard watchers", () => {
  it("ignores watcher headers on an agent's socket, so it can't see direct messages between others", async () => {
    const owner = await signIn("spy-owner");
    const lobby = await createLobby("spy-owner", owner);
    const bob = await addAgent(lobby.lobbyId, "spy-bob", await member(lobby, "spy-bob"));
    const carol = await addAgent(lobby.lobbyId, "spy-carol", await member(lobby, "spy-carol"));

    const forged = await api(`/v1/lobbies/${lobby.lobbyId}/ws`, {
      headers: {
        Upgrade: "websocket", "Sec-WebSocket-Protocol": `agentlobbies.v1, bearer.${carol.token}, account.${carol.account.token}`,
        "X-Watch-User": owner.userId, "X-Watch-Owner": "1", "X-Agent-Id": bob.agentId,
      },
    });
    const spy = new TestSocket(forged.webSocket!);
    expect((await spy.hello()).agentId).toBe(carol.agentId);

    const { envelope } = await send(await connect(lobby), lobby, { kind: "direct", agentId: bob.agentId });
    expect(await heardOf(spy, envelope.id)).toBe(false);
  });

  it("refuses a removed member's old seat token, watcher headers or not", async () => {
    const owner = await signIn("gone-owner");
    const lobby = await createLobby("gone-owner", owner);
    const bob = await member(lobby, "gone-bob");
    const bobsAgent = await addAgent(lobby.lobbyId, "gone-bob", bob);
    await api(`/v1/lobbies/${lobby.lobbyId}/members/gone-bob`, { method: "DELETE", headers: { authorization: `Bearer ${owner.token}` } });

    const res = await api(`/v1/lobbies/${lobby.lobbyId}/ws`, {
      headers: {
        Upgrade: "websocket", "Sec-WebSocket-Protocol": `agentlobbies.v1, bearer.${bobsAgent.token}, account.${bob.token}`,
        "X-Watch-User": bob.userId, "X-Watch-Owner": "1",
      },
    });
    const socket = new TestSocket(res.webSocket!);
    expect(await socket.closed()).toBe(4003);
  });
});

describe("revoking a machine", () => {
  it("removes its agents everywhere, even if the machine ignores the sign-out", async () => {
    const owner = await signIn("lost-laptop");
    const lobby = await createLobby("lost-laptop", owner);
    const desktop = await signIn("lost-laptop");
    const agent = await addAgent(lobby.lobbyId, "laptop-claude", owner);
    const socket = await connect(agent);

    const cookie = await webSignIn("lost-laptop");
    expect((await web(`/v1/me/devices/${owner.machineId}`, cookie, { method: "DELETE" })).status).toBe(200);

    expect(await socket.closed()).toBe(4003);
    expect((await refresh(agent)).status).toBe(403);
    expect(await (await TestSocket.open(agent)).closed()).toBe(4003);
    // The user's other machine is untouched.
    expect((await api("/v1/me", { headers: { authorization: `Bearer ${desktop.token}` } })).status).toBe(200);
  });

  it("follows an agent to the owner's machine it last connected from, after signing in again there", async () => {
    const before = await signIn("relogin");
    const lobby = await createLobby("relogin", before);
    const agent = await addAgent(lobby.lobbyId, "relogin-claude", before);
    const after = await signIn("relogin"); // `agentlobbies login` again: same laptop, new machine id
    const socket = await TestSocket.open(agent, after);
    expect((await socket.hello()).agentId).toBe(agent.agentId);

    const cookie = await webSignIn("relogin");
    await web(`/v1/me/devices/${after.machineId}`, cookie, { method: "DELETE" });
    expect(await socket.closed()).toBe(4003);
  });

  it("won't refresh a seat token for an agent whose machine was revoked", async () => {
    const owner = await signIn("refresh-revoked");
    const lobby = await createLobby("refresh-revoked", owner);
    expect((await refresh(lobby)).status).toBe(200);
    await postJson("/v1/auth/logout", {}, randomIp(), owner.token);
    expect((await refresh(lobby)).status).not.toBe(200);
  });
});

describe("browser sessions", () => {
  it("ends the browser's sign-in when its device is revoked, so it can't register a new one", async () => {
    await signIn("tab-owner");
    const cookie = await webSignIn("tab-owner");
    const { machineId } = await (await web("/v1/me/devices", cookie, { method: "POST", body: { boxPublicKey: await boxKey(), name: "Web browser" } }))
      .json<{ machineId: string }>();
    const otherTab = await webSignIn("tab-owner");
    expect((await web(`/v1/me/devices/${machineId}`, otherTab, { method: "DELETE" })).status).toBe(200);

    expect((await web("/v1/me", cookie)).status).toBe(401);
    expect((await web("/v1/me/devices", cookie, { method: "POST", body: { boxPublicKey: await boxKey(), name: "again" } })).status).toBe(401);
    expect((await web("/v1/me", otherTab)).status).toBe(200);
  });

  it("ends the session on sign-out, and disconnects that tab's live sockets", async () => {
    const lobby = await createLobby("tab-leaver");
    const cookie = await webSignIn("owner-tab-leaver");
    const res = await api(`/v1/lobbies/${lobby.lobbyId}/watch`, { headers: { Upgrade: "websocket", cookie, origin: ORIGIN } });
    const watcher = new TestSocket(res.webSocket!);

    expect((await web("/auth/logout", cookie, { method: "POST" })).status).toBe(204);
    expect(await watcher.closed()).toBe(4003);
    expect((await web("/v1/me", cookie)).status).toBe(401);
  });

  it("won't let a newer sign-in keep using a device registered by an earlier one", async () => {
    const lobby = await createLobby("relogin-tab");
    const first = await webSignIn("owner-relogin-tab");
    const { machineId } = await (await web("/v1/me/devices", first, { method: "POST", body: { boxPublicKey: await boxKey(), name: "Web browser" } }))
      .json<{ machineId: string }>();
    const second = await webSignIn("owner-relogin-tab"); // the same browser signs in again

    expect((await web(`/v1/lobbies/${lobby.lobbyId}/keys?device=${machineId}`, second)).status).toBe(403);
    const devices = await (await web("/v1/me/devices", second)).json<{ deviceId: string; current: boolean }[]>();
    expect(devices.find((d) => d.deviceId === machineId)?.current).toBe(false);

    // It registers its own device instead, and revoking that ends the newer sign-in too.
    const own = await (await web("/v1/me/devices", second, { method: "POST", body: { boxPublicKey: await boxKey(), name: "Web browser" } }))
      .json<{ machineId: string }>();
    expect((await web(`/v1/me/devices/${own.machineId}`, second, { method: "DELETE" })).status).toBe(200);
    expect((await web("/v1/me/devices", second, { method: "POST", body: { boxPublicKey: await boxKey(), name: "again" } })).status).toBe(401);
  });

  it("refuses a session cookie from before sessions could be ended", async () => {
    const old = "__Host-session=eyJhbGciOiJFZERTQSJ9.eyJraW5kIjoid2ViIn0.c2ln";
    expect((await web("/v1/me", old)).status).toBe(401);
  });
});

describe("encryption keys", () => {
  it("refuses box keys that aren't usable X25519 public keys", async () => {
    const cookie = await webSignIn("bad-keys");
    const register = (boxPublicKey: string) => web("/v1/me/devices", cookie, { method: "POST", body: { boxPublicKey, name: "x" } });
    expect((await register(toB64u(new Uint8Array([7])))).status).toBe(400);
    expect((await register(toB64u(new Uint8Array(32)))).status).toBe(400); // the all-zero point
    expect((await register(toB64u(new Uint8Array([1, ...new Array(31).fill(0)])))).status).toBe(400); // a low-order point
    expect((await register(await boxKey())).status).toBe(201);

    const machine = await postJson("/v1/auth/github", {
      githubToken: "gho_fake_bad-keys", machinePublicKey: toB64u(new Uint8Array(32)), boxPublicKey: toB64u(new Uint8Array([7])), machineName: "x",
    });
    expect(machine.status).toBe(400);
  });

  it("refuses messages under an old key, and while the lobby is switching keys", async () => {
    const owner = await signIn("rotating");
    const lobby = await createLobby("rotating", owner);
    const ws = await connect(lobby);
    ws.send({ t: "keys.put", reqId: ulid(), epoch: 1, create: true, sealed: [{ machineId: owner.machineId, sealed: "c2VhbGVk" }] });
    await ws.next("keys", (f) => f.current === 1);
    expect((await send(ws, lobby, { kind: "broadcast" }, 1)).answer.t).toBe("ok");

    const bob = await member(lobby, "rotating-bob");
    await api(`/v1/lobbies/${lobby.lobbyId}/members/rotating-bob`, { method: "DELETE", headers: { authorization: `Bearer ${owner.token}` } });
    await ws.next("keys", (f) => f.rotate);
    expect((await send(ws, lobby, { kind: "broadcast" }, 1)).answer).toMatchObject({ t: "err", code: "key_rotating" });

    ws.send({ t: "keys.put", reqId: ulid(), epoch: 2, create: true, sealed: [{ machineId: owner.machineId, sealed: "bmV3" }] });
    await ws.next("keys", (f) => f.current === 2 && !f.rotate);
    expect((await send(ws, lobby, { kind: "broadcast" }, 1)).answer).toMatchObject({ t: "err", code: "key_rotating" });
    expect((await send(ws, lobby, { kind: "broadcast" }, 2)).answer.t).toBe("ok");
    expect(bob.machineId).toBeDefined();
  });
});

describe("limits", () => {
  it("counts the bytes of a body sent without Content-Length", async () => {
    const big = JSON.stringify({ name: "x".repeat(200 * 1024) });
    const chunks = new ReadableStream({
      start(controller) {
        for (let i = 0; i < big.length; i += 16 * 1024) controller.enqueue(new TextEncoder().encode(big.slice(i, i + 16 * 1024)));
        controller.close();
      },
    });
    const owner = await signIn("streamer");
    const res = await api("/v1/lobbies", {
      method: "POST", body: chunks, duplex: "half",
      headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json", "cf-connecting-ip": randomIp() },
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  it("holds the device limit when many registrations arrive at once", async () => {
    const cookie = await webSignIn("racer");
    const keys = await Promise.all(Array.from({ length: 30 }, () => boxKey()));
    const statuses = await Promise.all(keys.map((boxPublicKey, i) =>
      web("/v1/me/devices", cookie, { method: "POST", body: { boxPublicKey, name: `b${i}` } }).then((r) => r.status)));
    expect(statuses.filter((s) => s === 201)).toHaveLength(20);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
  });

  it("counts machine sign-ins toward the daily device limit", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await postJson("/v1/auth/github", {
        githubToken: "gho_fake_machine-spammer", machinePublicKey: toB64u(new Uint8Array(32)), boxPublicKey: await boxKey(), machineName: `m${i}`,
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe("suspending an account for abuse", () => {
  it("closes its lobbies, signs out its devices, and keeps it from signing in again", async () => {
    const spammer = await signIn("spammer");
    const lobby = await createLobby("spammer", spammer);
    const socket = await connect(lobby);
    const cookie = await webSignIn("spammer");
    const suspend = (token: string) =>
      api("/v1/admin/suspend", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ login: "spammer" }) });

    expect((await suspend("wrong-token")).status).toBe(404);
    expect((await suspend("test-admin-token")).status).toBe(200);
    expect(await socket.closed()).toBe(4010);
    expect((await api("/v1/me", { headers: { authorization: `Bearer ${spammer.token}` } })).status).toBe(401);
    expect((await web("/v1/me", cookie)).status).toBe(401);
    expect((await postJson("/v1/auth/github", { githubToken: "gho_fake_spammer", machinePublicKey: toB64u(new Uint8Array(32)), machineName: "x" })).status).toBe(403);
  });
});
