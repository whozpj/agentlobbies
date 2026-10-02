import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import canonicalize from "canonicalize";

// The browser reads end-to-end encrypted messages as one of the user's devices (LLD 15.11). It does
// exactly what the daemon's encryption.ts does, with the browser's WebCrypto instead of node:crypto.

const hpke = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const ENC_BYTES = 32;
const DB_NAME = "agentlobbies";
const STORE = "device";

export interface Sealed {
  epoch: number;
  iv: string;
  data: string;
}

/** The envelope fields a ciphertext is bound to. */
export interface Binding {
  lobbyId: string;
  id: string;
  from: string;
  type: string;
  epoch: number;
}

export interface Content {
  body: string;
  attachments?: { kind: string; name: string; content: string }[];
}

/** This browser's device: its id on the relay and its private key, which can't be read out. */
export interface Device {
  userId: string;
  machineId: string;
  privateKey: CryptoKey;
}

function fromB64u(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function toB64u(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** IndexedDB keeps CryptoKey objects as they are, so a non-extractable key stays non-extractable. */
function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeGet(key: string): Promise<Device | undefined> {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result as Device | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function storeSet(key: string, value: Device | undefined): Promise<void> {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const request = value === undefined ? store.delete(key) : store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * This browser's device for `userId`, creating it the first time: a new X25519 key pair whose
 * private half is non-extractable, with the public half registered through `register`.
 */
export async function ensureDevice(userId: string, register: (boxPublicKey: string) => Promise<string>): Promise<Device> {
  const existing = await storeGet(userId);
  if (existing) return existing;
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const machineId = await register(toB64u(publicKey));
  const device = { userId, machineId, privateKey: pair.privateKey };
  await storeSet(userId, device);
  return device;
}

export async function forgetDevice(userId: string): Promise<void> {
  await storeSet(userId, undefined);
}

/** Opens a lobby key sealed to this device (HPKE, as the daemon seals it). */
export async function openLobbyKey(privateKey: CryptoKey, lobbyId: string, epoch: number, sealed: string): Promise<CryptoKey> {
  const bytes = fromB64u(sealed);
  const info = new TextEncoder().encode(`agentlobbies/lobby-key/v1\n${lobbyId}\n${epoch}`);
  const raw = await hpke.open({ recipientKey: privateKey, enc: bytes.slice(0, ENC_BYTES), info }, bytes.slice(ENC_BYTES));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
}

/** Decrypts a message's content. Throws if it was changed, moved to another message, or made with another key. */
export async function decryptContent(lobbyKey: CryptoKey, binding: Binding, sealed: Sealed): Promise<Content> {
  const additionalData = new TextEncoder().encode("agentlobbies/sealed/v1\n" + canonicalize(binding));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(sealed.iv), additionalData }, lobbyKey, fromB64u(sealed.data));
  return JSON.parse(new TextDecoder().decode(plain)) as Content;
}
