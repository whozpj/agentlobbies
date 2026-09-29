import type { Crypto } from "./sign.js";

// Ed25519 PKCS8 DER prefix; the 32-byte seed follows it.
const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const ED25519 = { name: "Ed25519" };

function pkcs8(seed: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(PKCS8_PREFIX.length + seed.length);
  out.set(PKCS8_PREFIX);
  out.set(seed, PKCS8_PREFIX.length);
  return out;
}

/** Ed25519 over WebCrypto, available in Cloudflare Workers and Node 22+. */
export const webCrypto: Crypto = {
  async sign(secretKey, msg) {
    const key = await crypto.subtle.importKey("pkcs8", pkcs8(secretKey), ED25519, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign(ED25519, key, msg));
  },
  async verify(publicKey, msg, sig) {
    if (publicKey.length !== 32 || sig.length !== 64) return false;
    const key = await crypto.subtle.importKey("raw", publicKey, ED25519, false, ["verify"]);
    return crypto.subtle.verify(ED25519, key, sig, msg);
  },
};

/** A fresh seat keypair: a 32-byte secret seed and a 32-byte public key. */
export async function generateSeatKeys(): Promise<{ secretKey: Uint8Array<ArrayBuffer>; publicKey: Uint8Array<ArrayBuffer> }> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
  const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { secretKey: priv.slice(priv.length - 32), publicKey: pub };
}
