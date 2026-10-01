import { canonical, fromB64u, toB64u, type Attachment, type Envelope, type Sealed } from "@agentlobbies/protocol";
import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Lobby keys are sealed to each member machine with HPKE (RFC 9180); messages use AES-256-GCM (LLD 15.2, 15.5).
const hpke = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const ENC_BYTES = 32; // the X25519 public key HPKE puts in front of the ciphertext
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface BoxKeys {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** What gets encrypted: everything an agent reads. */
export interface Content {
  body: string;
  attachments?: Attachment[];
}

/** The envelope fields a ciphertext is bound to, so it can't be moved to another message. */
type Binding = Pick<Envelope, "lobbyId" | "id" | "from" | "type"> & { epoch: number };

const utf8 = (s: string) => new TextEncoder().encode(s);

export async function generateBoxKeys(): Promise<BoxKeys> {
  const pair = await hpke.kem.generateKeyPair();
  return {
    publicKey: new Uint8Array(await hpke.kem.serializePublicKey(pair.publicKey)),
    privateKey: new Uint8Array(await hpke.kem.serializePrivateKey(pair.privateKey)),
  };
}

export function newLobbyKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

function keyInfo(lobbyId: string, epoch: number): Uint8Array {
  return utf8(`agentlobbies/lobby-key/v1\n${lobbyId}\n${epoch}`);
}

/** Seals a lobby key so only the machine with `boxPublicKey` can open it. */
export async function sealLobbyKey(boxPublicKey: string, lobbyId: string, epoch: number, lobbyKey: Uint8Array): Promise<string> {
  const recipientPublicKey = await hpke.kem.deserializePublicKey(fromB64u(boxPublicKey));
  const { enc, ct } = await hpke.seal({ recipientPublicKey, info: keyInfo(lobbyId, epoch) }, lobbyKey);
  const out = new Uint8Array(enc.byteLength + ct.byteLength);
  out.set(new Uint8Array(enc));
  out.set(new Uint8Array(ct), enc.byteLength);
  return toB64u(out);
}

/** Opens a lobby key sealed to this machine. Throws if it was sealed to another key or changed. */
export async function openLobbyKey(privateKey: Uint8Array, lobbyId: string, epoch: number, sealed: string): Promise<Uint8Array> {
  const bytes = fromB64u(sealed);
  const recipientKey = await hpke.kem.deserializePrivateKey(privateKey);
  const plain = await hpke.open({ recipientKey, enc: bytes.slice(0, ENC_BYTES), info: keyInfo(lobbyId, epoch) }, bytes.slice(ENC_BYTES));
  return new Uint8Array(plain);
}

function additionalData(binding: Binding): Uint8Array {
  return utf8("agentlobbies/sealed/v1\n" + canonical(binding));
}

export function encryptContent(lobbyKey: Uint8Array, binding: Binding, content: Content): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", lobbyKey, iv);
  cipher.setAAD(additionalData(binding));
  const data = Buffer.concat([cipher.update(JSON.stringify(content), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { epoch: binding.epoch, iv: toB64u(iv), data: toB64u(data) };
}

/** Throws if the ciphertext was changed, moved to another message, or made with another key. */
export function decryptContent(lobbyKey: Uint8Array, binding: Binding, sealed: Sealed): Content {
  const data = Buffer.from(fromB64u(sealed.data));
  const decipher = createDecipheriv("aes-256-gcm", lobbyKey, fromB64u(sealed.iv));
  decipher.setAAD(additionalData(binding));
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as Content;
}
