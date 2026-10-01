import { describe, expect, it } from "vitest";
import { Envelope, Handle, JoinProfile, LobbyEvent, LobbySettings, Topic } from "../src/index.js";
import { AGENT_A, AGENT_B, LOBBY, MSG_ID } from "./helpers.js";

const envelope = {
  v: 1, id: MSG_ID, lobbyId: LOBBY, from: AGENT_A, to: { kind: "broadcast" },
  type: "update", threadDepth: 0, body: "Renamed etaMinutes to estimatedArrival", createdAt: 1, sig: "c2ln",
};

describe("primitives", () => {
  it("accepts handles of 2 to 32 lowercase characters", () => {
    expect(Handle.safeParse("backend-codex").success).toBe(true);
    expect(Handle.safeParse("a".repeat(32)).success).toBe(true);
    expect(Handle.safeParse("a".repeat(33)).success).toBe(false);
    expect(Handle.safeParse("Backend").success).toBe(false);
    expect(Handle.safeParse("-lead").success).toBe(false);
  });

  it("accepts topics with dots and underscores", () => {
    expect(Topic.safeParse("api.orders_v2").success).toBe(true);
    expect(Topic.safeParse("#api").success).toBe(false);
  });
});

describe("Envelope", () => {
  it("accepts a valid broadcast", () => {
    expect(Envelope.safeParse(envelope).success).toBe(true);
  });

  it("accepts a v2 envelope that carries only sealed content", () => {
    const { body: _, ...rest } = envelope;
    expect(Envelope.safeParse({ ...rest, v: 2, sealed: { epoch: 1, iv: "aXY", data: "Y2lwaGVy" } }).success).toBe(true);
  });

  it("rejects a v2 envelope with a readable body, and a v1 envelope without one", () => {
    const sealed = { epoch: 1, iv: "aXY", data: "Y2lwaGVy" };
    expect(Envelope.safeParse({ ...envelope, v: 2, sealed }).success).toBe(false);
    const { body: _, ...rest } = envelope;
    expect(Envelope.safeParse({ ...rest, v: 2 }).success).toBe(false);
    expect(Envelope.safeParse({ ...rest, v: 1, sealed }).success).toBe(false);
  });

  it("rejects an empty body", () => {
    expect(Envelope.safeParse({ ...envelope, body: "" }).success).toBe(false);
  });

  it("rejects thread depth above the ceiling of 12", () => {
    expect(Envelope.safeParse({ ...envelope, threadDepth: 13 }).success).toBe(false);
  });

  it("rejects more than 8 attachments", () => {
    const a = { kind: "text", name: "n", content: "c" };
    expect(Envelope.safeParse({ ...envelope, attachments: Array(9).fill(a) }).success).toBe(false);
  });

  it("rejects a direct recipient without an agent id", () => {
    expect(Envelope.safeParse({ ...envelope, to: { kind: "direct" } }).success).toBe(false);
  });
});

describe("LobbyEvent", () => {
  it("parses a system event without a rate_limited type (G11)", () => {
    const joined = { kind: "system", seq: 1, committedAt: 1, system: { type: "lobby_created", hostId: AGENT_A } };
    expect(LobbyEvent.safeParse(joined).success).toBe(true);
    const limited = { kind: "system", seq: 2, committedAt: 1, system: { type: "rate_limited", agentId: AGENT_B } };
    expect(LobbyEvent.safeParse(limited).success).toBe(false);
  });

  it("requires a reason on approval_rejected (H12)", () => {
    const base = { kind: "system", seq: 3, committedAt: 1, system: { type: "approval_rejected", envelopeId: MSG_ID, from: AGENT_A } };
    expect(LobbyEvent.safeParse(base).success).toBe(false);
    expect(LobbyEvent.safeParse({ ...base, system: { ...base.system, reason: "sender_inactive" } }).success).toBe(true);
  });

  it("parses a board delete event (G37)", () => {
    const ev = { kind: "board", seq: 4, committedAt: 1, entry: { key: "schema", value: "", author: AGENT_A, version: 3, seq: 4, updatedAt: 1, deleted: true } };
    expect(LobbyEvent.safeParse(ev).success).toBe(true);
  });
});

describe("defaults", () => {
  it("fills lobby settings defaults", () => {
    expect(LobbySettings.parse({})).toEqual({
      approvalMode: "off", maxThreadDepth: 6, sendPerMinute: 30, historyOnJoin: "full", observersSeeDirects: false,
    });
  });

  it("defaults workingOn to empty on join", () => {
    const p = JoinProfile.parse({ handle: "web-claude", client: "claude-code", owns: ["web"], publicKey: "cHVi" });
    expect(p.workingOn).toBe("");
  });
});
