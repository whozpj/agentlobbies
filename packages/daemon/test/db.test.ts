import type { LobbyEvent } from "@agentlobbies/protocol";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";

const SEAT = "seat-1";

function message(seq: number, id: string): LobbyEvent {
  return {
    kind: "message", seq, committedAt: seq,
    envelope: { v: 1, id, lobbyId: "a".repeat(64), from: "01J9Z3K8M4N5P6Q7R8S9T0V1A1", to: { kind: "broadcast" },
                type: "update", threadDepth: 0, body: `message ${seq}`, createdAt: seq, sig: "c2ln" },
  };
}

describe("inbox", () => {
  it("stores each event once, even when replayed again", () => {
    const db = openDb(":memory:");
    db.ingest(SEAT, [message(1, "01J9Z3K8M4N5P6Q7R8S9T0V001")]);
    db.ingest(SEAT, [message(1, "01J9Z3K8M4N5P6Q7R8S9T0V001")]);
    expect(db.unreadCount(SEAT)).toBe(1);
  });

  it("returns unread messages oldest first and marks them read", () => {
    const db = openDb(":memory:");
    db.ingest(SEAT, [message(2, "01J9Z3K8M4N5P6Q7R8S9T0V002"), message(1, "01J9Z3K8M4N5P6Q7R8S9T0V001")]);
    expect(db.takeUnread(SEAT, 10).map((e) => e.seq)).toEqual([1, 2]);
    expect(db.unreadCount(SEAT)).toBe(0);
  });

  it("counts only messages as unread, not system events", () => {
    const db = openDb(":memory:");
    db.ingest(SEAT, [{ kind: "system", seq: 1, committedAt: 1, system: { type: "closing" } }]);
    expect(db.unreadCount(SEAT)).toBe(0);
  });

  it("never shows an agent its own sent messages (G8)", () => {
    const db = openDb(":memory:");
    db.recordOwn(SEAT, message(3, "01J9Z3K8M4N5P6Q7R8S9T0V003"));
    expect(db.unreadCount(SEAT)).toBe(0);
    expect(db.findEnvelope(SEAT, "01J9Z3K8M4N5P6Q7R8S9T0V003")?.threadDepth).toBe(0);
  });
});
