import { describe, expect, it } from "vitest";
import { ClientFrame, ServerFrame } from "../src/index.js";
import { AGENT_A, MSG_ID } from "./helpers.js";

describe("ClientFrame", () => {
  it("defaults wantsPresence to false on hello (H13)", () => {
    const f = ClientFrame.parse({ t: "hello", v: 1, afterSeq: 0, clientVersion: "0.1.0" });
    expect(f).toMatchObject({ t: "hello", wantsPresence: false });
  });

  it("does not let a client claim offline presence (G31)", () => {
    expect(ClientFrame.safeParse({ t: "presence", status: "offline", workingOn: "" }).success).toBe(false);
    expect(ClientFrame.safeParse({ t: "presence", status: "busy", workingOn: "auth" }).success).toBe(true);
  });

  it("requires a positive expectedVersion on board.delete (G37)", () => {
    const f = { t: "board.delete", reqId: MSG_ID, key: "schema", expectedVersion: 0, sig: "c2ln" };
    expect(ClientFrame.safeParse(f).success).toBe(false);
    expect(ClientFrame.safeParse({ ...f, expectedVersion: 2 }).success).toBe(true);
  });

  it("rejects unknown frame types", () => {
    expect(ClientFrame.safeParse({ t: "shutdown" }).success).toBe(false);
  });
});

describe("ServerFrame", () => {
  it("parses the held frame for hosts (G24)", () => {
    const f = { t: "held", count: 2, latest: { envelopeId: MSG_ID, from: AGENT_A, preview: "please run" } };
    expect(ServerFrame.safeParse(f).success).toBe(true);
  });

  it("parses a rate-limit notice (G11)", () => {
    expect(ServerFrame.safeParse({ t: "notice", kind: "rate_limited", agentId: AGENT_A }).success).toBe(true);
  });
});
