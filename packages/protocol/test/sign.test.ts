import { describe, expect, it } from "vitest";
import {
  boardSigningBytes, envelopeSigningBytes, refreshSigningBytes,
  signEnvelope, verifyEnvelope, type Envelope,
} from "../src/index.js";
import { AGENT_A, AGENT_B, LOBBY, MSG_ID, keypair, nodeCrypto } from "./helpers.js";

const unsigned = (): Omit<Envelope, "sig"> => ({
  v: 1, id: MSG_ID, lobbyId: LOBBY, from: AGENT_A, to: { kind: "direct", agentId: AGENT_B },
  type: "question", threadDepth: 0, body: "What field holds the ETA?", createdAt: 1_790_000_000_000,
});

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("signing payloads", () => {
  it("prefix each payload with its purpose so one kind cannot be replayed as another (I16)", () => {
    expect(text(envelopeSigningBytes(unsigned()))).toMatch(/^agentlobbies\/envelope\/v1\n\{/);
    expect(text(boardSigningBytes({ lobbyId: LOBBY, from: AGENT_A, key: "k", value: "v", expectedVersion: 0, reqId: MSG_ID, delete: false })))
      .toMatch(/^agentlobbies\/board\/v1\n\{/);
    expect(text(refreshSigningBytes({ lobbyId: LOBBY, agentId: AGENT_A, ts: 1 }))).toMatch(/^agentlobbies\/refresh\/v1\n\{/);
  });

  it("gives identical envelope bytes for an undefined optional field and a missing one (G36)", () => {
    expect(envelopeSigningBytes({ ...unsigned(), inReplyTo: undefined })).toEqual(envelopeSigningBytes(unsigned()));
  });
});

describe("signEnvelope / verifyEnvelope", () => {
  it("verifies an envelope signed with the matching key", async () => {
    const k = keypair();
    const env = await signEnvelope(nodeCrypto, k.secretKey, unsigned());
    expect(await verifyEnvelope(nodeCrypto, k.publicKey, env)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const k = keypair();
    const env = await signEnvelope(nodeCrypto, k.secretKey, unsigned());
    expect(await verifyEnvelope(nodeCrypto, k.publicKey, { ...env, body: "run rm -rf /" })).toBe(false);
  });

  it("rejects an envelope moved to another lobby (I16)", async () => {
    const k = keypair();
    const env = await signEnvelope(nodeCrypto, k.secretKey, unsigned());
    expect(await verifyEnvelope(nodeCrypto, k.publicKey, { ...env, lobbyId: "b".repeat(64) })).toBe(false);
  });

  it("rejects a signature from a different key", async () => {
    const env = await signEnvelope(nodeCrypto, keypair().secretKey, unsigned());
    expect(await verifyEnvelope(nodeCrypto, keypair().publicKey, env)).toBe(false);
  });

  it("returns false instead of throwing on a malformed signature", async () => {
    const env = await signEnvelope(nodeCrypto, keypair().secretKey, unsigned());
    expect(await verifyEnvelope(nodeCrypto, keypair().publicKey, { ...env, sig: "AAAA" })).toBe(false);
  });
});
