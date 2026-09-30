import { refreshSigningBytes, signEnvelope, toB64u, webCrypto } from "@agentlobbies/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ulid } from "ulid";
import { beforeAll, describe, expect, it } from "vitest";
import { TestSocket, addAgent, api, createLobby, fakeGitHub, postJson, randomIp, signIn, type Seat } from "./client";
import { newAgent } from "./helpers";

function envelope(seat: Seat, fields: Record<string, unknown> = {}) {
  return signEnvelope(webCrypto, seat.keys.secretKey, {
    v: 1, id: ulid(), lobbyId: seat.lobbyId, from: seat.agentId, to: { kind: "broadcast" },
    type: "update", threadDepth: 0, body: "renamed etaMinutes to estimatedArrival", createdAt: Date.now(), ...fields,
  });
}

beforeAll(() => fakeGitHub());

describe("REST", () => {
  it("reports health", async () => {
    const res = await api("/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("creates a lobby and returns a token and lobby id", async () => {
    const host = await createLobby();
    expect(host.lobbyId).toMatch(/^[0-9a-f]{64}$/);
    expect(host.token.split(".")).toHaveLength(3);
  });

  it("returns 400 bad_request for an invalid body", async () => {
    const res = await postJson("/v1/lobbies", { host: { handle: "Not Valid" } }, randomIp(), (await signIn("creator")).token);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
  });

  it("limits lobby creation to 5 per minute from one IP (G14)", async () => {
    const ip = randomIp();
    const { token } = await signIn("busy-creator");
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await postJson("/v1/lobbies", { host: (await newAgent("host")).profile }, ip, token)).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it("refuses a WebSocket upgrade without a valid token", async () => {
    const host = await createLobby();
    const res = await api(`/v1/lobbies/${host.lobbyId}/ws`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "agentlobbies.v1, bearer.not-a-jwt" },
    });
    expect(res.status).toBe(401);
  });

  it("refuses a token issued for a different lobby", async () => {
    const a = await createLobby();
    const b = await createLobby();
    const res = await api(`/v1/lobbies/${b.lobbyId}/ws`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `agentlobbies.v1, bearer.${a.token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("token refresh", () => {
  async function refresh(seat: Seat, ts = Date.now(), keys = seat.keys) {
    const sig = await webCrypto.sign(keys.secretKey, refreshSigningBytes({ lobbyId: seat.lobbyId, agentId: seat.agentId, ts }));
    return postJson(`/v1/lobbies/${seat.lobbyId}/token`, { agentId: seat.agentId, ts, sig: toB64u(sig) });
  }

  it("issues a new token for a request signed by the seat's key (C6)", async () => {
    const host = await createLobby();
    const res = await refresh(host);
    expect(res.status).toBe(200);
    const { token } = await res.json<{ token: string }>();
    const ws = await TestSocket.open({ lobbyId: host.lobbyId, token });
    expect((await ws.hello()).agentId).toBe(host.agentId);
  });

  it("refuses a signature from another key", async () => {
    const host = await createLobby();
    const other = await createLobby();
    expect((await refresh(host, Date.now(), other.keys)).status).toBe(401);
  });

  it("refuses a timestamp more than 5 minutes old", async () => {
    const host = await createLobby();
    expect((await refresh(host, Date.now() - 6 * 60_000)).status).toBe(401);
  });
});

describe("WebSocket", () => {
  it("welcomes with the roster, then replays history ending in more: false", async () => {
    const host = await createLobby();
    await addAgent(host.lobbyId, "backend", host.account);
    const ws = await TestSocket.open(host);
    const welcome = await ws.hello();
    expect(welcome).toMatchObject({ agentId: host.agentId, role: "host", headSeq: 3 });
    expect(welcome.roster.map((a) => a.handle)).toEqual(["host", "backend"]);
    const replayed = ws.frames.filter((f) => f.t === "events").flatMap((f) => f.events.map((e) => e.seq));
    expect(replayed).toEqual([1, 2, 3]);
  });

  it("delivers a broadcast live to other agents and acks the sender with its seq", async () => {
    const host = await createLobby();
    const member = await addAgent(host.lobbyId, "backend", host.account);
    const hostWs = await TestSocket.open(host);
    await hostWs.hello();
    const memberWs = await TestSocket.open(member);
    await memberWs.hello();

    const e = await envelope(member);
    memberWs.send({ t: "send", reqId: ulid(), envelope: e });
    expect(await memberWs.next("ok")).toMatchObject({ seq: 4 });
    const live = await hostWs.next("event", (f) => f.event.seq === 4);
    expect(live.event).toMatchObject({ kind: "message", envelope: { id: e.id } });
  });

  it("returns the original seq when an envelope is resent (I5)", async () => {
    const host = await createLobby();
    const ws = await TestSocket.open(host);
    await ws.hello();
    const e = await envelope(host);
    ws.send({ t: "send", reqId: ulid(), envelope: e });
    ws.send({ t: "send", reqId: ulid(), envelope: e });
    await ws.next("ok");
    await new Promise((r) => setTimeout(r, 100));
    expect(ws.frames.filter((f) => f.t === "ok").map((f) => f.seq)).toEqual([3, 3]);
  });

  it("rejects an envelope signed with the wrong key", async () => {
    const host = await createLobby();
    const other = await createLobby();
    const ws = await TestSocket.open(host);
    await ws.hello();
    const forged = await envelope({ ...host, keys: other.keys });
    ws.send({ t: "send", reqId: ulid(), envelope: forged });
    expect(await ws.next("err")).toMatchObject({ code: "bad_signature" });
  });

  it("replays only what an agent missed after reconnecting with its cursor (I3)", async () => {
    const host = await createLobby();
    const member = await addAgent(host.lobbyId, "backend", host.account);
    const hostWs = await TestSocket.open(host);
    await hostWs.hello();

    const memberWs = await TestSocket.open(member);
    await memberWs.hello();
    for (let i = 0; i < 3; i++) memberWs.send({ t: "send", reqId: ulid(), envelope: await envelope(member) });
    await hostWs.next("event", (f) => f.event.seq === 6);
    hostWs.ws.close(1000);

    const again = await TestSocket.open(host);
    await again.hello(4);
    const replayed = again.frames.filter((f) => f.t === "events").flatMap((f) => f.events.map((e) => e.seq));
    expect(replayed).toEqual([5, 6]);
  });

  it("closes the older socket with 4009 when the same seat connects again (I14)", async () => {
    const host = await createLobby();
    const first = await TestSocket.open(host);
    await first.hello();
    const second = await TestSocket.open(host);
    await second.hello();
    expect(await first.closed()).toBe(4009);
  });

  it("shows connected agents as active, to live agents and to newcomers", async () => {
    const host = await createLobby();
    const member = await addAgent(host.lobbyId, "backend", host.account);
    const hostWs = await TestSocket.open(host);
    await hostWs.hello();

    const memberWs = await TestSocket.open(member);
    const welcome = await memberWs.hello();
    expect(welcome.roster.find((a) => a.handle === "host")?.status).toBe("active");
    expect(welcome.roster.find((a) => a.handle === "backend")?.status).toBe("active");
    expect((await hostWs.next("roster", (f) => f.agent.handle === "backend")).agent.status).toBe("active");
  });

  it("marks an agent offline once its heartbeats stop, the next time the lobby is active", async () => {
    const host = await createLobby();
    const member = await addAgent(host.lobbyId, "backend", host.account);
    const silent = await TestSocket.open(member);
    await silent.hello();
    const silentSince = Date.now();
    await new Promise((r) => setTimeout(r, 1500));

    const live = await TestSocket.open(host);
    await live.hello();
    live.ws.send('{"t":"ping"}');
    await new Promise((r) => setTimeout(r, 200));

    const stub = env.LOBBY.get(env.LOBBY.idFromString(host.lobbyId));
    await runInDurableObject(stub, (lobby) => lobby.closeStaleSockets(silentSince + 60_500));

    expect(await silent.closed()).toBe(1001);
    expect((await live.next("roster", (f) => f.agent.handle === "backend" && f.agent.status === "offline")).agent.status).toBe("offline");
    expect(live.closeCode).toBeUndefined();
  });

  it("closes with 4000 when the first frame is not hello", async () => {
    const host = await createLobby();
    const ws = await TestSocket.open(host);
    ws.send({ t: "ack", seq: 1 });
    expect(await ws.closed()).toBe(4000);
  });
});
