import { toB64u } from "@agentlobbies/protocol";
import { describe, expect, it } from "vitest";
import { decryptContent, openLobbyKey } from "../../dashboard/src/crypto";
import { encryptContent, newLobbyKey, sealLobbyKey } from "../src/encryption";

const LOBBY = "a".repeat(64);
const binding = { lobbyId: LOBBY, id: "01J00000000000000000000000", from: "01J00000000000000000000001", type: "question" as const, epoch: 1 };

/** A browser's device key, made the way the dashboard makes it: X25519 with a private half that can't be read out. */
async function browserDevice() {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toB64u(publicKey) };
}

describe("the browser reads what a machine encrypts", () => {
  it("opens a lobby key a machine sealed to it, and decrypts a message the machine encrypted", async () => {
    const device = await browserDevice();
    const lobbyKey = newLobbyKey();
    const sealed = await sealLobbyKey(device.publicKey, LOBBY, 1, lobbyKey);
    const opened = await openLobbyKey(device.privateKey, LOBBY, 1, sealed);

    const content = { body: "What field holds the ETA?", attachments: [{ kind: "text" as const, name: "note", content: "see orders.ts" }] };
    expect(await decryptContent(opened, binding, encryptContent(lobbyKey, binding, content))).toEqual(content);
  });

  it("refuses a key sealed to another device, and a message moved to another id", async () => {
    const device = await browserDevice();
    const other = await browserDevice();
    const lobbyKey = newLobbyKey();
    const sealedToOther = await sealLobbyKey(other.publicKey, LOBBY, 1, lobbyKey);
    await expect(openLobbyKey(device.privateKey, LOBBY, 1, sealedToOther)).rejects.toThrow();

    const opened = await openLobbyKey(device.privateKey, LOBBY, 1, await sealLobbyKey(device.publicKey, LOBBY, 1, lobbyKey));
    const message = encryptContent(lobbyKey, binding, { body: "deploy at 5" });
    await expect(decryptContent(opened, { ...binding, id: "01J00000000000000000000002" }, message)).rejects.toThrow();
  });

  it("keeps the browser's private key unreadable", async () => {
    const device = await browserDevice();
    await expect(crypto.subtle.exportKey("pkcs8", device.privateKey)).rejects.toThrow();
  });
});
