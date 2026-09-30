import { generateSeatKeys, toB64u } from "@agentlobbies/protocol";
import { describe, expect, inject, it } from "vitest";
import { Connection, type ConnectionState } from "../src/connection";

const relayUrl = inject("relayUrl");

async function hostToken(): Promise<{ lobbyId: string; token: string }> {
  const keys = await generateSeatKeys();
  const signIn = await fetch(`${relayUrl}/v1/auth/github`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ githubToken: "gho_fake_tester", machinePublicKey: toB64u(keys.publicKey), machineName: "test" }),
  });
  const { token: accountToken } = (await signIn.json()) as { token: string };
  const res = await fetch(`${relayUrl}/v1/lobbies`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accountToken}` },
    body: JSON.stringify({ host: { handle: "host", client: "cli", owns: [], publicKey: toB64u(keys.publicKey) } }),
  });
  return res.json() as Promise<{ lobbyId: string; token: string }>;
}

describe("Connection", () => {
  it("sends heartbeats and hears the relay's pongs", async () => {
    const { lobbyId, token } = await hostToken();
    const states: ConnectionState[] = [];
    const conn = new Connection({
      url: `${relayUrl.replace(/^http/, "ws")}/v1/lobbies/${lobbyId}/ws`,
      token: async () => token,
      onRejected: () => {},
      clientVersion: "0.1.0",
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
