import { signEnvelope, webCrypto } from "@agentlobbies/protocol";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { TestSocket, api, createLobby, joinLobby, postJson, randomIp, type Seat } from "./client";
import { newAgent } from "./helpers";

function envelope(seat: Seat, fields: Record<string, unknown> = {}) {
  return signEnvelope(webCrypto, seat.keys.secretKey, {
    v: 1, id: ulid(), lobbyId: seat.lobbyId, from: seat.agentId, to: { kind: "broadcast" },
    type: "update", threadDepth: 0, body: "renamed etaMinutes to estimatedArrival", createdAt: Date.now(), ...fields,
  });
}

describe("REST", () => {
  it("reports health", async () => {
    const res = await api("/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("creates a lobby and returns a code, token, and lobby id", async () => {
    const host = await createLobby();
    expect(host.lobbyId).toMatch(/^[0-9a-f]{64}$/);
    expect(host.code).toMatch(/^[2-9]-[a-z]+-[a-z]+$/);
    expect(host.token.split(".")).toHaveLength(3);
  });

  it("joins with a code, accepting it in any case and spacing", async () => {
    const host = await createLobby();
    const messy = " " + host.code.toUpperCase().replace(/-/g, " ") + " ";
    const member = await joinLobby(messy, "backend");
    expect(member.lobbyId).toBe(host.lobbyId);
  });

  it("rejects an unknown code with invalid_code", async () => {
    const res = await postJson("/v1/join", { code: "2-abandon-ability", agent: (await createLobby()).profile });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_code" } });
  });

  it("returns 400 bad_request for an invalid body", async () => {
    const res = await postJson("/v1/lobbies", { host: { handle: "Not Valid" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
  });

  it("limits lobby creation to 5 per minute from one IP (G14)", async () => {
    const ip = randomIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await postJson("/v1/lobbies", { host: (await newAgent("host")).profile }, ip)).status);
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

describe("WebSocket", () => {
  it("welcomes with the roster, then replays history ending in more: false", async () => {
    const host = await createLobby();
    await joinLobby(host.code, "backend");
    const ws = await TestSocket.open(host);
    const welcome = await ws.hello();
    expect(welcome).toMatchObject({ agentId: host.agentId, role: "host", headSeq: 3 });
    expect(welcome.roster.map((a) => a.handle)).toEqual(["host", "backend"]);
    const replayed = ws.frames.filter((f) => f.t === "events").flatMap((f) => f.events.map((e) => e.seq));
    expect(replayed).toEqual([1, 2, 3]);
  });

  it("delivers a broadcast live to other agents and acks the sender with its seq", async () => {
    const host = await createLobby();
    const member = await joinLobby(host.code, "backend");
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
    const member = await joinLobby(host.code, "backend");
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

  it("closes with 4000 when the first frame is not hello", async () => {
    const host = await createLobby();
    const ws = await TestSocket.open(host);
    ws.send({ t: "ack", seq: 1 });
    expect(await ws.closed()).toBe(4000);
  });
});
