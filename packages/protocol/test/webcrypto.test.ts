import { describe, expect, it } from "vitest";
import { generateSeatKeys, signEnvelope, verifyEnvelope, webCrypto } from "../src/index.js";
import { nodeCrypto } from "./helpers.js";
import { AGENT_A, AGENT_B, LOBBY, MSG_ID } from "./helpers.js";

const msg = new TextEncoder().encode("agentlobbies/test/v1\n{}");
const unsigned = {
  v: 1 as const, id: MSG_ID, lobbyId: LOBBY, from: AGENT_A, to: { kind: "direct" as const, agentId: AGENT_B },
  type: "question" as const, threadDepth: 0, body: "hi", createdAt: 1,
};

describe("webCrypto (Ed25519 over WebCrypto, used by the relay)", () => {
  it("generates a 32-byte secret seed and 32-byte public key", async () => {
    const k = await generateSeatKeys();
    expect(k.secretKey).toHaveLength(32);
    expect(k.publicKey).toHaveLength(32);
  });

  it("signs and verifies its own signatures", async () => {
    const k = await generateSeatKeys();
    const sig = await webCrypto.sign(k.secretKey, msg);
    expect(await webCrypto.verify(k.publicKey, msg, sig)).toBe(true);
    expect(await webCrypto.verify(k.publicKey, new TextEncoder().encode("other"), sig)).toBe(false);
  });

  it("interoperates with node:crypto in both directions", async () => {
    const k = await generateSeatKeys();
    const fromWeb = await signEnvelope(webCrypto, k.secretKey, unsigned);
    expect(await verifyEnvelope(nodeCrypto, k.publicKey, fromWeb)).toBe(true);
    const fromNode = await signEnvelope(nodeCrypto, k.secretKey, unsigned);
    expect(await verifyEnvelope(webCrypto, k.publicKey, fromNode)).toBe(true);
  });

  it("returns false for a public key of the wrong length instead of throwing", async () => {
    const k = await generateSeatKeys();
    const sig = await webCrypto.sign(k.secretKey, msg);
    expect(await webCrypto.verify(new Uint8Array(5), msg, sig)).toBe(false);
  });
});
