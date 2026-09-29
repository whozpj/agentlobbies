import { fromB64u, toB64u } from "./b64u.js";
import { canonical } from "./canonical.js";
import type { Envelope } from "./schemas.js";

/** Ed25519, injected so Node (node:crypto) and Workers (WebCrypto) share this code. */
export interface Crypto {
  sign(secretKey: Uint8Array<ArrayBuffer>, msg: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
  verify(publicKey: Uint8Array<ArrayBuffer>, msg: Uint8Array<ArrayBuffer>, sig: Uint8Array<ArrayBuffer>): Promise<boolean>;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

export function envelopeSigningBytes(e: Omit<Envelope, "sig">): Uint8Array<ArrayBuffer> {
  return utf8("agentlobbies/envelope/v1\n" + canonical(e));
}

export function boardSigningBytes(p: {
  lobbyId: string; from: string; key: string; value: string; expectedVersion: number; reqId: string; delete: boolean;
}): Uint8Array<ArrayBuffer> {
  return utf8("agentlobbies/board/v1\n" + canonical(p));
}

export function refreshSigningBytes(p: { lobbyId: string; agentId: string; ts: number }): Uint8Array<ArrayBuffer> {
  return utf8("agentlobbies/refresh/v1\n" + canonical(p));
}

export async function signEnvelope(crypto: Crypto, secretKey: Uint8Array<ArrayBuffer>, e: Omit<Envelope, "sig">): Promise<Envelope> {
  const sig = await crypto.sign(secretKey, envelopeSigningBytes(e));
  return { ...e, sig: toB64u(sig) };
}

export async function verifyEnvelope(crypto: Crypto, publicKey: Uint8Array<ArrayBuffer>, e: Envelope): Promise<boolean> {
  const { sig, ...rest } = e;
  return verifyBytes(crypto, publicKey, envelopeSigningBytes(rest), sig);
}

/** Verifies a base64url signature, returning false (never throwing) on malformed input. */
export async function verifyBytes(crypto: Crypto, publicKey: Uint8Array<ArrayBuffer>, msg: Uint8Array<ArrayBuffer>, sig: string): Promise<boolean> {
  try {
    return await crypto.verify(publicKey, msg, fromB64u(sig));
  } catch {
    return false;
  }
}
