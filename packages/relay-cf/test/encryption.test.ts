import { signEnvelope, webCrypto, type ServerFrame } from "@agentlobbies/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ulid } from "ulid";
import { beforeAll, describe, expect, it } from "vitest";
import { TestSocket, addPerson, api, createLobby, fakeGitHub, member, postJson, randomIp, signIn, type Account, type Seat } from "./client";

beforeAll(() => fakeGitHub());

type Keys = Extract<ServerFrame, { t: "keys" }>;

function put(ws: TestSocket, epoch: number, create: boolean, machineIds: string[]) {
  const reqId = ulid();
  ws.send({ t: "keys.put", reqId, epoch, create, sealed: machineIds.map((machineId) => ({ machineId, sealed: `c2VhbGVk${machineId.slice(-4)}` })) });
  return ws.reply(reqId);
}

/** The newest keys frame matching `predicate`. */
async function keys(ws: TestSocket, predicate: (f: Keys) => boolean = () => true): Promise<Keys> {
  await ws.next("keys", predicate);
  return ws.frames.filter((f): f is Keys => f.t === "keys" && predicate(f)).at(-1)!;
}

async function connect(seat: Seat, account: Account): Promise<TestSocket> {
  const ws = await TestSocket.open(seat, account);
  await ws.hello();
  return ws;
}

describe("lobby keys (LLD 15.4)", () => {
  it("starts a new lobby with no key and lists the owner's machine as needing one", async () => {
    const owner = await signIn("keys-owner");
    const lobby = await createLobby("keys-owner", owner);
    const ws = await connect(lobby, owner);
    const frame = await keys(ws);
    expect(frame).toMatchObject({ current: 0, rotate: false, mine: [], missing: [] });
    expect(frame.machines).toEqual([{ machineId: owner.machineId, boxPublicKey: owner.boxPublicKey }]);
  });

  it("lets a member machine create epoch 1, and gives it back as that machine's own", async () => {
    const owner = await signIn("creator-1");
    const lobby = await createLobby("creator-1", owner);
    const ws = await connect(lobby, owner);
    expect((await put(ws, 1, true, [owner.machineId])).t).toBe("ok");
    const frame = await keys(ws, (f) => f.current === 1);
    expect(frame.mine).toEqual([{ epoch: 1, sealed: expect.any(String) }]);
  });

  it("refuses a second epoch unless the key must rotate, and a create that skips an epoch", async () => {
    const owner = await signIn("creator-2");
    const lobby = await createLobby("creator-2", owner);
    const ws = await connect(lobby, owner);
    await put(ws, 1, true, [owner.machineId]);
    expect(await put(ws, 2, true, [owner.machineId])).toMatchObject({ t: "err", code: "version_conflict" });
    expect(await put(ws, 3, true, [owner.machineId])).toMatchObject({ t: "err", code: "version_conflict" });
  });

  it("asks the online machine to fill in a new member's machine, which then gets its copy", async () => {
    const owner = await signIn("filler");
    const lobby = await createLobby("filler", owner);
    const ownerWs = await connect(lobby, owner);
    await put(ownerWs, 1, true, [owner.machineId]);

    const bob = await member(lobby, "fill-bob");
    const missing = await keys(ownerWs, (f) => f.missing.some((m) => m.machineId === bob.machineId));
    expect(missing.missing).toEqual([{ machineId: bob.machineId, epochs: [1] }]);

    const bobWs = await connect(await addPerson(lobby.lobbyId, "fill-bob", bob), bob);
    expect((await keys(bobWs)).mine).toEqual([]);
    expect((await put(ownerWs, 1, false, [bob.machineId])).t).toBe("ok");
    expect((await keys(bobWs, (f) => f.mine.length > 0)).mine).toEqual([{ epoch: 1, sealed: expect.any(String) }]);
  });

  it("refuses an agent's socket unless it proves the agent's own machine, and keys for a machine outside the lobby", async () => {
    const owner = await signIn("strict-owner");
    const lobby = await createLobby("strict-owner", owner);
    expect(await (await TestSocket.open(lobby, null)).closed()).toBe(4001);

    const outsider = await signIn("outsider");
    const ws = await connect(lobby, owner);
    expect(await put(ws, 1, true, [owner.machineId, outsider.machineId])).toMatchObject({ t: "err", code: "forbidden" });
  });

  it("refuses an agent's socket that proves another user's machine", async () => {
    const owner = await signIn("claim-owner");
    const lobby = await createLobby("claim-owner", owner);
    const mallory = await signIn("claim-mallory");
    expect(await (await TestSocket.open(lobby, mallory)).closed()).toBe(4001);
  });

  it("refuses to fill an epoch the sending machine doesn't hold", async () => {
    const owner = await signIn("holder");
    const lobby = await createLobby("holder", owner);
    const ownerWs = await connect(lobby, owner);
    await put(ownerWs, 1, true, [owner.machineId]);
    const bob = await member(lobby, "holder-bob");
    const bobWs = await connect(await addPerson(lobby.lobbyId, "holder-bob", bob), bob);
    expect(await put(bobWs, 1, false, [bob.machineId])).toMatchObject({ t: "err", code: "forbidden" });
  });

  it("rotates when a member is removed: their machine drops out and their seats close", async () => {
    const owner = await signIn("rotator");
    const lobby = await createLobby("rotator", owner);
    const ownerWs = await connect(lobby, owner);
    await put(ownerWs, 1, true, [owner.machineId]);
    const bob = await member(lobby, "rotate-bob");
    const bobWs = await connect(await addPerson(lobby.lobbyId, "rotate-bob", bob), bob);

    const res = await api(`/v1/lobbies/${lobby.lobbyId}/members/rotate-bob`, { method: "DELETE", headers: { authorization: `Bearer ${owner.token}` } });
    expect(res.status).toBe(200);
    expect(await bobWs.closed()).toBe(4003);
    const frame = await keys(ownerWs, (f) => f.rotate);
    expect(frame.machines.map((m) => m.machineId)).toEqual([owner.machineId]);
    expect((await put(ownerWs, 2, true, [owner.machineId])).t).toBe("ok");
    expect((await keys(ownerWs, (f) => f.current === 2)).rotate).toBe(false);
  });

  it("rotates when a member machine signs out, and leaves it out of the next key", async () => {
    const owner = await signIn("signout-owner");
    const lobby = await createLobby("signout-owner", owner);
    const ownerWs = await connect(lobby, owner);
    await put(ownerWs, 1, true, [owner.machineId]);
    const laptop = await signIn("signout-owner");
    expect((await postJson("/v1/auth/logout", {}, randomIp(), laptop.token)).status).toBe(200);
    const frame = await keys(ownerWs, (f) => f.rotate);
    expect(frame.machines.map((m) => m.machineId)).not.toContain(laptop.machineId);
  });

  it("registers a box key for a machine that signed in without one", async () => {
    const owner = await signIn("late-box");
    const lobby = await createLobby("late-box", owner);
    const ws = await connect(lobby, owner);
    const old = await postJson("/v1/auth/github", { githubToken: "gho_fake_late-box", machinePublicKey: owner.boxPublicKey, machineName: "old" });
    const { token, machineId } = await old.json<{ token: string; machineId: string }>();
    expect((await postJson("/v1/auth/box-key", { boxPublicKey: owner.boxPublicKey }, randomIp(), token)).status).toBe(200);
    await keys(ws, (f) => f.machines.some((m) => m.machineId === machineId));
  });
});

describe("encrypted messages (LLD 15.5)", () => {
  it("refuses a message with a readable body", async () => {
    const lobby = await createLobby("plain-sender");
    const ws = await TestSocket.open(lobby);
    await ws.hello();
    const envelope = await signEnvelope(webCrypto, lobby.keys.secretKey, {
      v: 1, id: ulid(), lobbyId: lobby.lobbyId, from: lobby.agentId, to: { kind: "broadcast" },
      type: "update", threadDepth: 0, body: "secret plans", createdAt: Date.now(),
    });
    const reqId = ulid();
    ws.send({ t: "send", reqId, envelope });
    expect(await ws.next("err", (f) => f.reqId === reqId)).toMatchObject({ code: "bad_request" });
  });

  it("stores only ciphertext", async () => {
    const lobby = await createLobby("cipher-sender");
    const ws = await TestSocket.open(lobby);
    await ws.hello();
    const envelope = await signEnvelope(webCrypto, lobby.keys.secretKey, {
      v: 2, id: ulid(), lobbyId: lobby.lobbyId, from: lobby.agentId, to: { kind: "broadcast" },
      type: "update", threadDepth: 0, sealed: { epoch: 1, iv: "aXZpdml2aXZpdml2", data: "Y2lwaGVydGV4dA" }, createdAt: Date.now(),
    });
    const reqId = ulid();
    ws.send({ t: "send", reqId, envelope });
    await ws.next("ok", (f) => f.reqId === reqId);

    const stored = await runInDurableObject(env.LOBBY.get(env.LOBBY.idFromString(lobby.lobbyId)), (_instance, state) =>
      state.storage.sql.exec<{ event_json: string }>("SELECT event_json FROM events WHERE kind = 'message'").one().event_json);
    expect(JSON.parse(stored).envelope).toMatchObject({ v: 2, sealed: { data: "Y2lwaGVydGV4dA" } });
    expect(JSON.parse(stored).envelope.body).toBeUndefined();
  });
});
