import { toB64u } from "@agentlobbies/protocol";
import { describe, expect, it } from "vitest";
import { decryptContent, encryptContent, generateBoxKeys, newLobbyKey, openLobbyKey, sealLobbyKey } from "../src/encryption";

const LOBBY = "a".repeat(64);
const binding = { lobbyId: LOBBY, id: "01J00000000000000000000000", from: "01J00000000000000000000001", type: "question" as const, epoch: 1 };

describe("lobby keys", () => {
  it("seals a lobby key that only the recipient machine can open", async () => {
    const laptop = await generateBoxKeys();
    const other = await generateBoxKeys();
    const key = newLobbyKey();
    const sealed = await sealLobbyKey(toB64u(laptop.publicKey), LOBBY, 1, key);
    expect(await openLobbyKey(laptop.privateKey, LOBBY, 1, sealed)).toEqual(key);
    await expect(openLobbyKey(other.privateKey, LOBBY, 1, sealed)).rejects.toThrow();
  });

  it("won't open a key presented as another lobby's or another epoch's", async () => {
    const laptop = await generateBoxKeys();
    const sealed = await sealLobbyKey(toB64u(laptop.publicKey), LOBBY, 1, newLobbyKey());
    await expect(openLobbyKey(laptop.privateKey, "b".repeat(64), 1, sealed)).rejects.toThrow();
    await expect(openLobbyKey(laptop.privateKey, LOBBY, 2, sealed)).rejects.toThrow();
  });
});

describe("message content", () => {
  it("round-trips a body and attachments", () => {
    const key = newLobbyKey();
    const content = { body: "What field holds the ETA?", attachments: [{ kind: "text" as const, name: "note", content: "see orders.ts" }] };
    expect(decryptContent(key, binding, encryptContent(key, binding, content))).toEqual(content);
  });

  it("uses a fresh IV each time, so the same text never encrypts the same way", () => {
    const key = newLobbyKey();
    const a = encryptContent(key, binding, { body: "same" });
    const b = encryptContent(key, binding, { body: "same" });
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("refuses the wrong key, a changed ciphertext, and a ciphertext moved to another message", () => {
    const key = newLobbyKey();
    const sealed = encryptContent(key, binding, { body: "deploy at 5" });
    expect(() => decryptContent(newLobbyKey(), binding, sealed)).toThrow();

    const flipped = Buffer.from(sealed.data, "base64url");
    flipped[0]! ^= 1;
    expect(() => decryptContent(key, binding, { ...sealed, data: flipped.toString("base64url") })).toThrow();

    expect(() => decryptContent(key, { ...binding, id: "01J00000000000000000000002" }, sealed)).toThrow();
    expect(() => decryptContent(key, { ...binding, type: "answer" }, sealed)).toThrow();
  });
});
