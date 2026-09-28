import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { Crypto } from "../src/index.js";

// Ed25519 PKCS8 DER prefix for a raw 32-byte seed.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export const nodeCrypto: Crypto = {
  async sign(secretKey, msg) {
    const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, secretKey]), format: "der", type: "pkcs8" });
    return new Uint8Array(sign(null, msg, key));
  },
  async verify(publicKey, msg, sig) {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") }, format: "jwk" });
    return verify(null, msg, key, sig);
  },
};

export function keypair(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  return {
    secretKey: new Uint8Array(Buffer.from(jwk.d!, "base64url")),
    publicKey: new Uint8Array(Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url")),
  };
}

export const LOBBY = "a".repeat(64);
export const AGENT_A = "01J9Z3K8M4N5P6Q7R8S9T0V1W2";
export const AGENT_B = "01J9Z3K8M4N5P6Q7R8S9T0V1W3";
export const MSG_ID = "01J9Z3K8M4N5P6Q7R8S9T0V1W4";
