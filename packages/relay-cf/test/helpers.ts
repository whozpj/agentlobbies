import { generateSeatKeys, signEnvelope, toB64u, webCrypto, type Envelope, type JoinProfile } from "@agentlobbies/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ulid } from "ulid";

/** Runs `fn` against the storage of a brand-new lobby object. */
export function withStorage<T>(fn: (storage: DurableObjectStorage) => T | Promise<T>): Promise<T> {
  const stub = env.LOBBY.get(env.LOBBY.newUniqueId());
  return runInDurableObject(stub, (_instance, state) => fn(state.storage));
}

export const LOBBY_ID = "a".repeat(64);

export async function newAgent(handle: string, client: JoinProfile["client"] = "claude-code") {
  const keys = await generateSeatKeys();
  const profile: JoinProfile = { handle, client, owns: [], workingOn: "", publicKey: toB64u(keys.publicKey) };
  return { agentId: ulid(), profile, keys };
}

export type TestAgent = Awaited<ReturnType<typeof newAgent>>;

/** A signed v2 envelope. The relay never decrypts, so the sealed content here is just opaque bytes. */
export function envelope(from: TestAgent, fields: Partial<Omit<Envelope, "sig">> = {}): Promise<Envelope> {
  return signEnvelope(webCrypto, from.keys.secretKey, {
    v: 2, id: ulid(), lobbyId: LOBBY_ID, from: from.agentId, to: { kind: "broadcast" },
    type: "update", threadDepth: 0, sealed: { epoch: 1, iv: "aXZpdml2aXZpdml2", data: "Y2lwaGVydGV4dA" }, createdAt: Date.now(), ...fields,
  });
}
