import { refreshSigningBytes, toB64u, webCrypto } from "@agentlobbies/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { TestSocket, addAgent, addPerson, createLobby, fakeGitHub, member, postJson, randomIp, signIn } from "./client";
import { newAgent } from "./helpers";

beforeAll(() => fakeGitHub());

async function refresh(account: Awaited<ReturnType<typeof signIn>>, ts = Date.now()) {
  const sig = await webCrypto.sign(account.machineKeys.secretKey, refreshSigningBytes({ lobbyId: "account", agentId: account.machineId, ts }));
  return postJson("/v1/auth/refresh", { machineId: account.machineId, ts, sig: toB64u(sig) });
}

describe("GitHub sign-in", () => {
  it("verifies the GitHub token and returns an account token and profile", async () => {
    const res = await postJson("/v1/auth/github", { githubToken: "gho_fake_whozpj", machinePublicKey: toB64u((await newAgent("m")).keys.publicKey), machineName: "mac" });
    expect(res.status).toBe(200);
    const body = await res.json<{ token: string; user: { login: string; avatarUrl: string } }>();
    expect(body.user.login).toBe("whozpj");
    expect(body.user.avatarUrl).toMatch(/^https:\/\/avatars\.githubusercontent\.com\//);
    expect(body.token).not.toContain("gho_fake");
  });

  it("refuses a token GitHub rejects", async () => {
    const res = await postJson("/v1/auth/github", { githubToken: "not-a-token", machinePublicKey: toB64u((await newAgent("m")).keys.publicKey), machineName: "mac" });
    expect(res.status).toBe(401);
  });

  it("gives the same user id when the same person signs in again", async () => {
    expect((await signIn("repeat")).userId).toBe((await signIn("repeat")).userId);
  });

  it("refreshes an account token with the machine key, until the machine logs out", async () => {
    const account = await signIn("refresher");
    expect((await refresh(account)).status).toBe(200);
    expect((await postJson("/v1/auth/logout", {}, randomIp(), account.token)).status).toBe(200);
    expect((await refresh(account)).status).toBe(401);
  });
});

describe("lobbies need a signed-in owner", () => {
  it("refuses to create a lobby without an account", async () => {
    const res = await postJson("/v1/lobbies", { name: "nobody's" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "login_required" } });
  });

  it("refuses to add an agent without an account", async () => {
    const host = await createLobby();
    const res = await postJson(`/v1/lobbies/${host.lobbyId}/agents`, { agent: (await newAgent("x")).profile });
    expect(res.status).toBe(401);
  });

  it("shows each agent's owner in the roster", async () => {
    const alice = await signIn("alice");
    const host = await createLobby("alice", alice);
    await addAgent(host.lobbyId, "web-claude", alice);
    const bob = await member(host, "bob");
    await addPerson(host.lobbyId, "bob", bob);
    await addAgent(host.lobbyId, "api-codex", bob);
    const ws = await TestSocket.open(host);
    const welcome = await ws.hello();
    const owners = Object.fromEntries(welcome.roster.map((a) => [a.handle, a.owner?.login]));
    expect(owners).toEqual({ alice: "alice", "web-claude": "alice", bob: "bob", "api-codex": "bob" });
  });
});
