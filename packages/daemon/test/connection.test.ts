import { generateSeatKeys, toB64u } from "@agentlobbies/protocol";
import { describe, expect, inject, it } from "vitest";
import { Connection, type ConnectionState } from "../src/connection";
import { freshUser } from "./lobby-helpers";

const relayUrl = inject("relayUrl");

async function hostToken(): Promise<{ lobbyId: string; token: string }> {
  const keys = await generateSeatKeys();
  const post = (path: string, body: unknown, token?: string) => fetch(`${relayUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<any>);
  const { token: accountToken } = await post("/v1/auth/github", { githubToken: freshUser("tester"), machinePublicKey: toB64u(keys.publicKey), machineName: "test" });
  const { lobbyId } = await post("/v1/lobbies", { name: "heartbeats" }, accountToken);
  const person = { handle: "host", client: "cli", owns: [], publicKey: toB64u(keys.publicKey) };
  const { token } = await post(`/v1/lobbies/${lobbyId}/people`, { person }, accountToken);
  return { lobbyId, token };
}

describe("Connection", () => {
  it("sends heartbeats and hears the relay's pongs", async () => {
    const { lobbyId, token } = await hostToken();
    const states: ConnectionState[] = [];
    const conn = new Connection({
      url: `${relayUrl.replace(/^http/, "ws")}/v1/lobbies/${lobbyId}/ws`,
      token: async () => token,
      onRejected: () => {},
      clientVersion: "0.4.0",
      cursor: () => 0,
      onFrame: () => {},
      onState: (s) => states.push(s),
      heartbeatMs: 100,
    });
    await conn.start();
    for (let i = 0; i < 50 && conn.state !== "live"; i++) await new Promise((r) => setTimeout(r, 100));
    const liveAt = Date.now();
    await new Promise((r) => setTimeout(r, 500));

    expect(conn.lastPongAt).toBeGreaterThan(liveAt);
    expect(states).not.toContain("backoff");
    conn.stop();
  });
});
