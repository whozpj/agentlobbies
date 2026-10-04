import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toB64u } from "@agentlobbies/protocol";
import { afterEach, describe, expect, inject, it } from "vitest";
import { Daemon } from "../src/daemon";
import { generateBoxKeys } from "../src/encryption";
import { add, agentSession, eventually, freshUser } from "./lobby-helpers";

const relayUrl = inject("relayUrl");
const running: Daemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

async function startDaemon(githubToken: string) {
  const daemon = new Daemon({ home: mkdtempSync(join(tmpdir(), "al-home-")), relayUrl });
  await daemon.start();
  running.push(daemon);
  await daemon.call("account.login", { githubToken });
  const { sessionId } = await daemon.call("session.open", { client: "person", cwd: tmpdir() });
  const person = (method: string, params: Record<string, unknown> = {}) => daemon.call(method, { sessionId, ...params });
  return { daemon, person };
}

describe("end-to-end encryption between machines", () => {
  it("hands the lobby key to a new member's machine, which then reads the history", async () => {
    const alice = await startDaemon(freshUser("alice"));
    const { lobbyId } = await alice.daemon.call("lobby.create", { name: "secret-app" });
    await alice.person("message.send", { lobbyId, to: "all", type: "update", body: "the launch is on Friday" });

    const bob = await startDaemon(freshUser("bob"));
    const { url } = await alice.daemon.call("invite.create", { lobbyId });
    await bob.daemon.call("invite.accept", { invite: url });

    const status = await eventually(() => bob.person("lobby.status", { lobbyId }), (s) => s.keyEpoch === 1);
    expect(status.keyEpoch).toBe(1);
    const history = await eventually(() => bob.daemon.call("dashboard.messages", { lobbyId }), (m) => m.length === 1 && m[0].body);
    expect(history[0]).toMatchObject({ from: "alice", body: "the launch is on Friday" });
  });

  it("delivers a message sent while the receiving machine had no key yet, once the key arrives", async () => {
    const alice = await startDaemon(freshUser("alice"));
    const { lobbyId } = await alice.daemon.call("lobby.create", { name: "late-key" });
    const bob = await startDaemon(freshUser("bob"));
    const api = await agentSession(bob.daemon, "codex", "api");
    const { url } = await alice.daemon.call("invite.create", { lobbyId });
    await bob.daemon.call("invite.accept", { invite: url });
    await eventually(() => bob.person("lobby.status", { lobbyId }), (s) => s.keyEpoch === 1);
    await add(bob.daemon, lobbyId, api, "api-codex", ["api"]);

    await alice.person("message.send", { lobbyId, to: "api-codex", type: "question", body: "Is the ETA in UTC?" });
    const [question] = await eventually(() => api.call("inbox.pull", { limit: 5 }), (m) => m.length > 0);
    expect(question).toMatchObject({ from: "alice", body: "Is the ETA in UTC?" });
  });

  it("makes a new key when a member is removed, and keeps using it", async () => {
    const alice = await startDaemon(freshUser("alice"));
    const { lobbyId } = await alice.daemon.call("lobby.create", { name: "rotating" });
    const bob = await startDaemon(freshUser("bob"));
    const { url } = await alice.daemon.call("invite.create", { lobbyId });
    await bob.daemon.call("invite.accept", { invite: url });
    await eventually(() => bob.person("lobby.status", { lobbyId }), (s) => s.keyEpoch === 1);

    await alice.daemon.call("lobby.removeMember", { lobbyId, login: "bob" });

    const rotated = await eventually(() => alice.person("lobby.status", { lobbyId }), (s) => s.keyEpoch === 2);
    expect(rotated.keyEpoch).toBe(2);
    await alice.person("message.send", { lobbyId, to: "all", type: "update", body: "bob can't read this" });
    expect(await bob.daemon.call("dashboard.lobbies", {})).toEqual([]);
  });

  it("sends a message written right after someone leaves under the new key, never the old one", async () => {
    const alice = await startDaemon(freshUser("alice"));
    const { lobbyId } = await alice.daemon.call("lobby.create", { name: "no-stale-key" });
    const bob = await startDaemon(freshUser("bob"));
    const { url } = await alice.daemon.call("invite.create", { lobbyId });
    await bob.daemon.call("invite.accept", { invite: url });
    await eventually(() => bob.person("lobby.status", { lobbyId }), (s) => s.keyEpoch === 1);

    await alice.daemon.call("lobby.removeMember", { lobbyId, login: "bob" });
    // The relay refuses anything under the old key, so this goes through only if it waited for the new one.
    expect(await alice.person("message.send", { lobbyId, to: "all", type: "update", body: "right after" })).toHaveProperty("seq");
    expect((await alice.person("lobby.status", { lobbyId })).keyEpoch).toBe(2);
  });

  it("sends a message queued while offline under the new key, when the lobby switched keys meanwhile", async () => {
    const alice = await startDaemon(freshUser("alice"));
    const { lobbyId } = await alice.daemon.call("lobby.create", { name: "queued" });
    const bob = await startDaemon(freshUser("bob"));
    const carol = await startDaemon(freshUser("carol"));
    for (const other of [bob, carol]) {
      const { url } = await alice.daemon.call("invite.create", { lobbyId });
      await other.daemon.call("invite.accept", { invite: url });
      await eventually(() => other.person("lobby.status", { lobbyId }), (s) => s.keyEpoch === 1);
    }

    // Alice's machine loses its connection, and she writes a message, which waits in the outbox.
    const connections = [...(alice.daemon as unknown as { connections: Map<string, { stop(): void; start(): Promise<void> }> }).connections.values()];
    for (const conn of connections) conn.stop();
    expect(await alice.person("message.send", { lobbyId, to: "all", type: "update", body: "written offline" })).toMatchObject({ queued: true });

    // Meanwhile Carol is removed, and Bob's machine makes the new key.
    await alice.daemon.call("lobby.removeMember", { lobbyId, login: "carol" });
    await eventually(() => bob.person("lobby.status", { lobbyId }), (s) => s.keyEpoch === 2);

    for (const conn of connections) void conn.start();
    const messages = await eventually(() => bob.daemon.call("dashboard.messages", { lobbyId }), (m) => m.some((x: { body: string }) => x.body === "written offline"));
    expect(messages.find((x: { body: string }) => x.body === "written offline")).toMatchObject({ from: "alice" });
  }, 60_000);

  it("hands out a new key in batches small enough for the relay, the rest only once the relay took the key", async () => {
    const alice = await startDaemon(freshUser("alice"));
    await alice.daemon.call("lobby.create", { name: "crowded" });
    const internals = alice.daemon as unknown as {
      db: { activeSeats(): { lobby_id: string }[]; account(): { machine_id: string } };
      onKeys(seat: unknown, conn: unknown, frame: unknown): Promise<void>;
      onReply(seat: unknown, frame: unknown): void;
    };
    const seat = internals.db.activeSeats()[0]!;
    const own = { machineId: internals.db.account().machine_id, boxPublicKey: toB64u((await generateBoxKeys()).publicKey) };
    const others = await Promise.all(Array.from({ length: 299 }, async (_, i) => ({
      machineId: `01J${String(i).padStart(23, "0")}`, boxPublicKey: toB64u((await generateBoxKeys()).publicKey),
    })));
    const frame = { t: "keys", current: 0, rotate: false, mine: [], machines: [...others, own], missing: [] };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

    // The relay takes the key: the remaining copies follow.
    const sent: { reqId: string; create: boolean; sealed: { machineId: string }[] }[] = [];
    await internals.onKeys(seat, { send: (f: never) => sent.push(f) }, frame);
    expect(sent.map((f) => [f.create, f.sealed.length])).toEqual([[true, 256]]);
    expect(sent[0]!.sealed[0]!.machineId).toBe(own.machineId);
    internals.onReply(seat, { t: "ok", reqId: sent[0]!.reqId });
    await settle();
    expect(sent.map((f) => [f.create, f.sealed.length])).toEqual([[true, 256], [false, 44]]);

    // Another machine made the epoch first: this key's other copies never go out.
    const lost: typeof sent = [];
    await internals.onKeys(seat, { send: (f: never) => lost.push(f) }, frame);
    internals.onReply(seat, { t: "err", reqId: lost[0]!.reqId, code: "version_conflict", message: "version_conflict" });
    await settle();
    expect(lost).toHaveLength(1);
  });
});
