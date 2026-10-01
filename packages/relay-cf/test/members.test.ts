import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { TestSocket, acceptInvite, addAgent, addPerson, api, createInvite, createLobby, fakeGitHub, member, postJson, randomIp, signIn } from "./client";
import { newAgent } from "./helpers";

beforeAll(() => fakeGitHub());

function remove(lobbyId: string, agentId: string, token: string) {
  return api(`/v1/lobbies/${lobbyId}/agents/${agentId}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
}

async function roster(lobby: { lobbyId: string; token: string }) {
  const ws = await TestSocket.open(lobby);
  return (await ws.hello()).roster;
}

describe("people and their agents", () => {
  it("lets the lobby owner add their own agent, shown as theirs", async () => {
    const alice = await signIn("alice");
    const lobby = await createLobby("alice", alice);
    await addAgent(lobby.lobbyId, "web-claude", alice);
    const byHandle = Object.fromEntries((await roster(lobby)).map((a) => [a.handle, a.owner?.login]));
    expect(byHandle).toEqual({ alice: "alice", "web-claude": "alice" });
  });

  it("refuses to add an agent for someone who isn't a member", async () => {
    const lobby = await createLobby();
    const stranger = await signIn("stranger");
    const res = await postJson(`/v1/lobbies/${lobby.lobbyId}/agents`, { agent: (await newAgent("x")).profile }, randomIp(), stranger.token);
    expect(res.status).toBe(403);
  });

  it("lets an invited person join and add their own agents", async () => {
    const lobby = await createLobby();
    const bob = await member(lobby, "bob");
    await addPerson(lobby.lobbyId, "bob", bob);
    await addAgent(lobby.lobbyId, "api-codex", bob);
    const owners = Object.fromEntries((await roster(lobby)).map((a) => [a.handle, a.owner?.login]));
    expect(owners).toMatchObject({ bob: "bob", "api-codex": "bob" });
  });

  it("returns a shareable invite link, and refuses used-up or unknown invites", async () => {
    const lobby = await createLobby();
    const invite = await createInvite(lobby, { maxUses: 1 });
    expect(invite.url).toMatch(/\/invite\/[A-Za-z0-9_-]{20,}$/);
    expect((await acceptInvite(invite.token, await signIn("first"))).status).toBe(200);
    expect((await acceptInvite(invite.token, await signIn("second"))).status).toBe(404);
    expect((await acceptInvite("not-a-real-invite-token-xx", await signIn("third"))).status).toBe(404);
  });

  it("gives view-only invitees no way to add agents", async () => {
    const lobby = await createLobby();
    const { token } = await createInvite(lobby, { role: "viewer" });
    const viewer = await signIn("viewer");
    expect((await acceptInvite(token, viewer)).status).toBe(200);
    const res = await postJson(`/v1/lobbies/${lobby.lobbyId}/agents`, { agent: (await newAgent("x")).profile }, randomIp(), viewer.token);
    expect(res.status).toBe(403);
  });

  it("only lets the lobby owner create invites", async () => {
    const lobby = await createLobby();
    const bob = await member(lobby, "invites-bob");
    const res = await postJson(`/v1/lobbies/${lobby.lobbyId}/invites`, {}, randomIp(), bob.token);
    expect(res.status).toBe(403);
  });
});

describe("removing agents", () => {
  it("lets an agent's owner remove it, closing its connection", async () => {
    const lobby = await createLobby();
    const bob = await member(lobby, "remover-bob");
    const agent = await addAgent(lobby.lobbyId, "api-codex", bob);
    const ws = await TestSocket.open(agent);
    await ws.hello();
    expect((await remove(lobby.lobbyId, agent.agentId, bob.token)).status).toBe(200);
    expect(await ws.closed()).toBe(4003);
  });

  it("lets the lobby owner remove anyone's agent, but not other members", async () => {
    const lobby = await createLobby();
    const bob = await member(lobby, "bob-2");
    const carol = await member(lobby, "carol");
    const bobs = await addAgent(lobby.lobbyId, "api-codex", bob);
    expect((await remove(lobby.lobbyId, bobs.agentId, carol.token)).status).toBe(403);
    expect((await remove(lobby.lobbyId, bobs.agentId, lobby.account.token)).status).toBe(200);
  });
});

describe("codes are gone", () => {
  it("no longer serves join codes", async () => {
    const lobby = await createLobby();
    expect((await postJson("/v1/join", { code: "2-abandon-ability" }, randomIp(), lobby.account.token)).status).toBe(404);
    expect((await postJson(`/v1/lobbies/${lobby.lobbyId}/codes`, {}, randomIp(), lobby.account.token)).status).toBe(404);
  });
});

describe("editing agents", () => {
  function patch(lobbyId: string, agentId: string, body: unknown, token: string) {
    return api(`/v1/lobbies/${lobbyId}/agents/${agentId}`, {
      method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
  }

  it("renames an agent and sets its areas as typed, telling everyone in the lobby", async () => {
    const lobby = await createLobby("edit-owner");
    const agent = await addAgent(lobby.lobbyId, "web-claude", lobby.account);
    const watcher = await TestSocket.open(lobby);
    await watcher.hello();

    const res = await patch(lobby.lobbyId, agent.agentId, { handle: "Web UI", owns: ["Frontend", " ", "Mobile App"] }, lobby.account.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handle: "web-ui", owns: ["frontend", "mobile-app"] });
    const update = await watcher.next("roster", (f) => f.agent.agentId === agent.agentId && f.agent.handle === "web-ui");
    expect(update.agent.owns).toEqual(["frontend", "mobile-app"]);
  });

  it("explains an area that can't be one, and refuses a name another agent has", async () => {
    const lobby = await createLobby("edit-rules");
    const web = await addAgent(lobby.lobbyId, "web-claude", lobby.account);
    await addAgent(lobby.lobbyId, "api-codex", lobby.account);

    const bad = await patch(lobby.lobbyId, web.agentId, { owns: ["front/end"] }, lobby.account.token);
    expect(bad.status).toBe(400);
    expect((await bad.json<{ error: { message: string } }>()).error.message).toContain('"front/end" isn\'t a valid area');
    expect((await patch(lobby.lobbyId, web.agentId, { handle: "api-codex" }, lobby.account.token)).status).toBe(409);
  });

  it("lets only the agent's owner or the lobby owner edit it, and never a person's seat", async () => {
    const lobby = await createLobby("edit-perms");
    const bob = await member(lobby, "edit-bob");
    const carol = await member(lobby, "edit-carol");
    const bobs = await addAgent(lobby.lobbyId, "bob-claude", bob);

    expect((await patch(lobby.lobbyId, bobs.agentId, { owns: ["x"] }, carol.token)).status).toBe(403);
    expect((await patch(lobby.lobbyId, bobs.agentId, { owns: ["x"] }, bob.token)).status).toBe(200);
    expect((await patch(lobby.lobbyId, bobs.agentId, { owns: ["y"] }, lobby.account.token)).status).toBe(200);
    expect((await patch(lobby.lobbyId, lobby.agentId, { handle: "new-name" }, lobby.account.token)).status).toBe(403);
  });
});

describe("deleting a lobby", () => {
  function del(lobbyId: string, token: string) {
    return api(`/v1/lobbies/${lobbyId}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  }

  it("lets only the owner delete it, then closes it for everyone and erases what it stored", async () => {
    const lobby = await createLobby("doomed");
    const bob = await member(lobby, "doomed-bob");
    const bobsAgent = await addAgent(lobby.lobbyId, "bob-claude", bob);
    const socket = await TestSocket.open(bobsAgent);
    await socket.hello();

    expect((await del(lobby.lobbyId, bob.token)).status).toBe(403);
    expect((await del(lobby.lobbyId, lobby.account.token)).status).toBe(200);

    expect(await socket.closed()).toBe(4010);
    const lobbies = await api("/v1/lobbies", { headers: { authorization: `Bearer ${bob.token}` } });
    expect(await lobbies.json()).toEqual([]);
    expect((await api(`/v1/lobbies/${lobby.lobbyId}/events`, { headers: { authorization: `Bearer ${lobby.account.token}` } })).status).toBe(403);

    const again = await TestSocket.open(bobsAgent);
    expect(await again.closed()).toBe(4010);
    const stored = await runInDurableObject(env.LOBBY.get(env.LOBBY.idFromString(lobby.lobbyId)), (_instance, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf%'").toArray());
    expect(stored).toEqual([]);
  });
});
