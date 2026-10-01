import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { Daemon } from "../src/daemon";
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
});
