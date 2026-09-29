import { LIMITS, type LobbyEvent, type Recipient } from "@agentlobbies/protocol";
import { ulid } from "ulid";
import { roleOf } from "./membership";
import { getMeta, getSettings, setMeta } from "./meta";
import { VISIBLE_SQL, visibleSqlParams } from "./visibility";

type EventBody =
  | Omit<Extract<LobbyEvent, { kind: "message" }>, "seq" | "committedAt">
  | Omit<Extract<LobbyEvent, { kind: "board" }>, "seq" | "committedAt">
  | Omit<Extract<LobbyEvent, { kind: "system" }>, "seq" | "committedAt">;

interface Columns {
  id?: string;
  from?: string;
  to?: Recipient;
  depth?: number;
}

/** Highest committed seq. Read from storage every time, never cached (G7). */
export function headSeq(storage: DurableObjectStorage): number {
  return Number(getMeta(storage.sql, "last_seq") ?? 0);
}

/** Appends an event with the next seq (I1). Callers fan out only after this returns (I2). */
export function commit(storage: DurableObjectStorage, body: EventBody, cols: Columns, now: number): LobbyEvent {
  return storage.transactionSync(() => {
    const seq = headSeq(storage) + 1;
    const event = { ...body, seq, committedAt: now } as LobbyEvent;
    const target = cols.to?.kind === "direct" ? cols.to.agentId : cols.to?.kind === "topic" ? cols.to.topic : null;
    storage.sql.exec(
      `INSERT INTO events (seq, id, kind, from_agent, to_kind, to_target, thread_depth, committed_at, event_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      seq, cols.id ?? ulid(), body.kind, cols.from ?? null, cols.to?.kind ?? null, target, cols.depth ?? null, now,
      JSON.stringify(event),
    );
    setMeta(storage.sql, "last_seq", seq);
    setMeta(storage.sql, "last_activity_at", now);
    return event;
  });
}

/** One replay page: up to `limit` events and `maxBytes`, always at least one event (G15). */
export function pageFor(
  storage: DurableObjectStorage, agentId: string, after: number, limit: number, maxBytes: number = LIMITS.replayPageMaxBytes,
): { events: LobbyEvent[]; more: boolean } {
  const viewer = { agentId, role: roleOf(storage.sql, agentId) ?? "member", observersSeeDirects: getSettings(storage.sql).observersSeeDirects };
  const rows = storage.sql.exec<{ event_json: string }>(
    `SELECT event_json FROM events WHERE seq > ? AND ${VISIBLE_SQL} ORDER BY seq LIMIT ?`,
    after, ...visibleSqlParams(viewer), limit + 1,
  ).toArray();

  const events: LobbyEvent[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    bytes += new TextEncoder().encode(row.event_json).length;
    if (events.length > 0 && bytes > maxBytes) break;
    events.push(JSON.parse(row.event_json));
  }
  return { events, more: rows.length > events.length };
}
