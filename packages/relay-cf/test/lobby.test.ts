import { describe, expect, it } from "vitest";
import { admit, initLobby, roster } from "../src/lobby/membership";
import { headSeq, pageFor } from "../src/lobby/events";
import { doSend } from "../src/lobby/send";
import { LOBBY_ID, envelope, newAgent, withStorage } from "./helpers";

async function lobbyWithHost(storage: DurableObjectStorage) {
  const host = await newAgent("host");
  initLobby(storage, { lobbyId: LOBBY_ID, host: { ...host.profile, agentId: host.agentId }, settings: {}, now: 1 });
  return host;
}

describe("initLobby", () => {
  it("records lobby_created then the host's joined event", async () => {
    await withStorage(async (storage) => {
      const host = await lobbyWithHost(storage);
      expect(headSeq(storage)).toBe(2);
      const { events } = pageFor(storage, host.agentId, 0, 100);
      expect(events.map((e) => e.kind === "system" && e.system.type)).toEqual(["lobby_created", "joined"]);
      expect(roster(storage)[0]).toMatchObject({ handle: "host", role: "host" });
    });
  });
});

describe("admit", () => {
  it("adds a member and commits a joined event", async () => {
    await withStorage(async (storage) => {
      await lobbyWithHost(storage);
      const b = await newAgent("backend");
      const r = admit(storage, { ...b.profile, agentId: b.agentId }, "member", 2);
      expect(r).toMatchObject({ handle: "backend" });
      expect(headSeq(storage)).toBe(3);
    });
  });

  it("suffixes a taken handle, keeping it within 32 characters (G4)", async () => {
    await withStorage(async (storage) => {
      await lobbyWithHost(storage);
      const long = "x".repeat(32);
      const a = await newAgent(long);
      const b = await newAgent(long);
      admit(storage, { ...a.profile, agentId: a.agentId }, "member", 2);
      const r = admit(storage, { ...b.profile, agentId: b.agentId }, "member", 3);
      expect(r).toMatchObject({ handle: "x".repeat(29) + "-2" });
    });
  });

  it("refuses the 33rd agent", async () => {
    await withStorage(async (storage) => {
      await lobbyWithHost(storage);
      for (let i = 0; i < 31; i++) {
        const a = await newAgent(`agent-${i}`);
        admit(storage, { ...a.profile, agentId: a.agentId }, "member", 2);
      }
      const extra = await newAgent("one-too-many");
      expect(admit(storage, { ...extra.profile, agentId: extra.agentId }, "member", 3)).toEqual({ error: "lobby_full" });
    });
  });
});

describe("doSend", () => {
  it("commits a broadcast with the next seq", async () => {
    await withStorage(async (storage) => {
      const host = await lobbyWithHost(storage);
      expect(doSend(storage, host.agentId, await envelope(host), 5)).toMatchObject({ seq: 3 });
    });
  });

  it("returns the original seq when the same envelope is sent again (I5)", async () => {
    await withStorage(async (storage) => {
      const host = await lobbyWithHost(storage);
      const e = await envelope(host);
      const first = doSend(storage, host.agentId, e, 5);
      expect(doSend(storage, host.agentId, e, 6)).toEqual({ seq: (first as { seq: number }).seq });
      expect(headSeq(storage)).toBe(3);
    });
  });

  it("rejects an answer with no parent", async () => {
    await withStorage(async (storage) => {
      const host = await lobbyWithHost(storage);
      expect(doSend(storage, host.agentId, await envelope(host, { type: "answer" }), 5)).toEqual({ error: "bad_reply" });
    });
  });

  it("lets an agent reply in its own thread (G8)", async () => {
    await withStorage(async (storage) => {
      const host = await lobbyWithHost(storage);
      const q = await envelope(host, { type: "question" });
      doSend(storage, host.agentId, q, 5);
      const followUp = await envelope(host, { type: "update", inReplyTo: q.id, threadDepth: 1 });
      expect(doSend(storage, host.agentId, followUp, 6)).toMatchObject({ seq: 4 });
    });
  });

  it("rejects a direct message to someone not in the lobby", async () => {
    await withStorage(async (storage) => {
      const host = await lobbyWithHost(storage);
      const stranger = await newAgent("stranger");
      const e = await envelope(host, { to: { kind: "direct", agentId: stranger.agentId } });
      expect(doSend(storage, host.agentId, e, 5)).toEqual({ error: "unknown_recipient" });
    });
  });

  it("rate limits after 30 sends in a minute and says when to retry", async () => {
    await withStorage(async (storage) => {
      const host = await lobbyWithHost(storage);
      for (let i = 0; i < 30; i++) expect(doSend(storage, host.agentId, await envelope(host), 1000)).toHaveProperty("seq");
      const r = doSend(storage, host.agentId, await envelope(host), 1000);
      expect(r).toMatchObject({ error: "rate_limited" });
      expect((r as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    });
  });

  it("does not spend a token on a send that fails validation (G10)", async () => {
    await withStorage(async (storage) => {
      const host = await lobbyWithHost(storage);
      for (let i = 0; i < 40; i++) doSend(storage, host.agentId, await envelope(host, { type: "answer" }), 1000);
      expect(doSend(storage, host.agentId, await envelope(host), 1000)).toHaveProperty("seq");
    });
  });
});

describe("pageFor", () => {
  it("never returns an agent's own messages, and pages with a more flag", async () => {
    await withStorage(async (storage) => {
      const host = await lobbyWithHost(storage);
      const b = await newAgent("backend");
      admit(storage, { ...b.profile, agentId: b.agentId }, "member", 2);
      for (let i = 0; i < 3; i++) doSend(storage, b.agentId, await envelope(b), 10);

      expect(pageFor(storage, b.agentId, 0, 100).events.filter((e) => e.kind === "message")).toHaveLength(0);
      const page = pageFor(storage, host.agentId, 0, 2);
      expect(page.events.map((e) => e.seq)).toEqual([1, 2]);
      expect(page.more).toBe(true);
    });
  });

  it("stops a page before it passes the byte limit, but always returns one event (G15)", async () => {
    await withStorage(async (storage) => {
      const host = await lobbyWithHost(storage);
      const page = pageFor(storage, host.agentId, 0, 100, 10);
      expect(page.events).toHaveLength(1);
      expect(page.more).toBe(true);
    });
  });
});
