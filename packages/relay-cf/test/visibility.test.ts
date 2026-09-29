import fc from "fast-check";
import type { LobbyEvent, Recipient, Role } from "@agentlobbies/protocol";
import { describe, expect, it } from "vitest";
import { commit, pageFor } from "../src/lobby/events";
import { setMeta } from "../src/lobby/meta";
import { migrate } from "../src/lobby/schema";
import { isVisible } from "../src/lobby/visibility";
import { withStorage } from "./helpers";

const agents = ["01J9Z3K8M4N5P6Q7R8S9T0V1A1", "01J9Z3K8M4N5P6Q7R8S9T0V1A2", "01J9Z3K8M4N5P6Q7R8S9T0V1A3"];
const viewer = agents[0]!;
const topics = ["api", "web"];

const recipient = fc.oneof(
  fc.record({ kind: fc.constant("broadcast" as const) }),
  fc.record({ kind: fc.constant("direct" as const), agentId: fc.constantFrom(...agents) }),
  fc.record({ kind: fc.constant("topic" as const), topic: fc.constantFrom(...topics) }),
);

/** Replaces the lobby's agents, subscriptions, and events with the given scenario. */
function seed(storage: DurableObjectStorage, role: Role, observersSeeDirects: boolean,
              subs: { agent: string; topic: string }[], sent: { from: string; to: Recipient }[]): LobbyEvent[] {
  const { sql } = storage;
  sql.exec("DELETE FROM events; DELETE FROM agents; DELETE FROM subscriptions;");
  setMeta(sql, "last_seq", 0);
  setMeta(sql, "settings", JSON.stringify({ observersSeeDirects }));
  for (const id of agents) {
    sql.exec(`INSERT INTO agents (agent_id, handle, client, role, public_key, joined_at, last_seen_at) VALUES (?, ?, 'cli', ?, 'cHVi', 0, 0)`,
      id, `h${id.slice(-2).toLowerCase()}`, id === viewer ? role : "member");
  }
  for (const s of subs) sql.exec("INSERT OR IGNORE INTO subscriptions VALUES (?, ?)", s.topic, s.agent);
  return sent.map((s, i) => commit(storage, {
    kind: "message",
    envelope: { v: 1, id: `01J9Z3K8M4N5P6Q7R8S9T0V${String(i).padStart(3, "0")}`, lobbyId: "a".repeat(64), from: s.from, to: s.to,
                type: "update", threadDepth: 0, body: "x", createdAt: 0, sig: "c2ln" },
  }, { id: `01J9Z3K8M4N5P6Q7R8S9T0V${String(i).padStart(3, "0")}`, from: s.from, to: s.to, depth: 0 }, 0));
}

describe("visibility", () => {
  it("replay (SQL) and live fan-out (isVisible) agree for every event and viewer (I10)", async () => {
    await withStorage((storage) => {
      migrate(storage.sql);
      fc.assert(fc.property(
        fc.array(fc.record({ from: fc.constantFrom(...agents), to: recipient }), { minLength: 1, maxLength: 20 }),
        fc.array(fc.record({ agent: fc.constantFrom(...agents), topic: fc.constantFrom(...topics) })),
        fc.constantFrom<Role>("host", "member", "observer"),
        fc.boolean(),
        (sent, subs, role, observersSeeDirects) => {
          const events = seed(storage, role, observersSeeDirects, subs, sent);
          const viewerTopics = new Set(subs.filter((s) => s.agent === viewer).map((s) => s.topic));
          const live = events.filter((e) => isVisible(e, { agentId: viewer, role, topics: viewerTopics, observersSeeDirects }));
          const replay = pageFor(storage, viewer, 0, 1000).events;
          expect(replay.map((e) => e.seq)).toEqual(live.map((e) => e.seq));
        },
      ), { numRuns: 200 });
    });
  });

  it("hides directs from observers unless observersSeeDirects is on (G43)", () => {
    const e = { kind: "message", seq: 1, committedAt: 0, envelope: { from: agents[1], to: { kind: "direct", agentId: agents[2] } } } as LobbyEvent;
    const observer = { agentId: viewer, role: "observer" as const, topics: new Set<string>() };
    expect(isVisible(e, { ...observer, observersSeeDirects: false })).toBe(false);
    expect(isVisible(e, { ...observer, observersSeeDirects: true })).toBe(true);
  });
});
