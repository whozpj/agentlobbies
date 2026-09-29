import type { AgentProfile, Envelope, LobbyEvent, Role } from "@agentlobbies/protocol";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS seats (
    seat_id        TEXT PRIMARY KEY,
    seat_key       TEXT NOT NULL,
    lobby_id       TEXT NOT NULL,
    lobby_name     TEXT,
    agent_id       TEXT NOT NULL,
    handle         TEXT NOT NULL,
    role           TEXT NOT NULL,
    relay_url      TEXT NOT NULL,
    jwt            TEXT NOT NULL,
    last_acked_seq INTEGER NOT NULL DEFAULT 0,
    state          TEXT NOT NULL,              -- active | kicked | left | closed | upgrade_required
    created_at     INTEGER NOT NULL,
    last_used_at   INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS seats_active ON seats (seat_key, lobby_id) WHERE state = 'active';

  CREATE TABLE IF NOT EXISTS inbox (
    seat_id     TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    event_id    TEXT NOT NULL,
    kind        TEXT NOT NULL,
    event_json  TEXT NOT NULL,
    own         INTEGER NOT NULL DEFAULT 0,  -- sent by this seat; never shown to it (G8)
    surfaced_at INTEGER,
    PRIMARY KEY (seat_id, seq),
    UNIQUE (seat_id, event_id)
  );

  CREATE TABLE IF NOT EXISTS outbox (
    req_id     TEXT PRIMARY KEY,
    seat_id    TEXT NOT NULL,
    frame_json TEXT NOT NULL,
    state      TEXT NOT NULL,                -- pending | done | failed
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS join_requests (
    id         TEXT PRIMARY KEY,
    seat_key   TEXT NOT NULL,
    client     TEXT NOT NULL,
    code       TEXT NOT NULL,
    handle     TEXT NOT NULL,
    owns_json  TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS roster (
    seat_id      TEXT NOT NULL,
    agent_id     TEXT NOT NULL,
    profile_json TEXT NOT NULL,
    PRIMARY KEY (seat_id, agent_id)
  );
`;

export interface Seat {
  seat_id: string;
  seat_key: string;
  lobby_id: string;
  lobby_name: string | null;
  agent_id: string;
  handle: string;
  role: Role;
  relay_url: string;
  jwt: string;
  last_acked_seq: number;
  state: string;
}

function eventId(e: LobbyEvent): string {
  if (e.kind === "message") return e.envelope.id;
  return `${e.kind}:${e.seq}`;
}

/** The daemon's local SQLite: seats, inbox, outbox, and a roster cache per seat (LLD 7.2). */
export interface JoinRequest {
  id: string;
  seat_key: string;
  client: string;
  code: string;
  handle: string;
  owns: string[];
}

export class Db {
  constructor(private readonly db: DatabaseSync) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }


  insertSeat(seat: Omit<Seat, "last_acked_seq" | "state">, now: number): void {
    this.db.prepare(
      `INSERT INTO seats (seat_id, seat_key, lobby_id, lobby_name, agent_id, handle, role, relay_url, jwt, state, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(seat.seat_id, seat.seat_key, seat.lobby_id, seat.lobby_name, seat.agent_id, seat.handle, seat.role,
          seat.relay_url, seat.jwt, now, now);
  }

  /** The most recently used active seat for a seat key. */
  activeSeat(seatKey: string): Seat | undefined {
    return this.db.prepare("SELECT * FROM seats WHERE seat_key = ? AND state = 'active' ORDER BY last_used_at DESC LIMIT 1")
      .get(seatKey) as Seat | undefined;
  }

  activeSeats(): Seat[] {
    return this.db.prepare("SELECT * FROM seats WHERE state = 'active'").all() as unknown as Seat[];
  }

  setSeatState(seatId: string, state: string): void {
    this.db.prepare("UPDATE seats SET state = ? WHERE seat_id = ?").run(state, seatId);
  }

  touchSeat(seatId: string, now: number): void {
    this.db.prepare("UPDATE seats SET last_used_at = ? WHERE seat_id = ?").run(now, seatId);
  }

  /** Moves the cursor forward only (I6). Written before the ack is sent (I13). */
  setCursor(seatId: string, seq: number): void {
    this.db.prepare("UPDATE seats SET last_acked_seq = MAX(last_acked_seq, ?) WHERE seat_id = ?").run(seq, seatId);
  }

  cursor(seatId: string): number {
    return (this.db.prepare("SELECT last_acked_seq FROM seats WHERE seat_id = ?").get(seatId) as { last_acked_seq: number }).last_acked_seq;
  }


  /** Stores events, ignoring any already stored (replays are safe to repeat). */
  ingest(seatId: string, events: LobbyEvent[]): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO inbox (seat_id, seq, event_id, kind, event_json) VALUES (?, ?, ?, ?, ?)");
    for (const e of events) insert.run(seatId, e.seq, eventId(e), e.kind, JSON.stringify(e));
  }

  /** Records a message this seat sent, so replies can find their parent (G8). */
  recordOwn(seatId: string, e: LobbyEvent): void {
    this.db.prepare("INSERT OR IGNORE INTO inbox (seat_id, seq, event_id, kind, event_json, own, surfaced_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
      .run(seatId, e.seq, eventId(e), e.kind, JSON.stringify(e), Date.now());
  }

  unreadCount(seatId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE seat_id = ? AND kind = 'message' AND own = 0 AND surfaced_at IS NULL")
      .get(seatId) as { n: number }).n;
  }

  /** Oldest unread messages first; marks exactly those as read. */
  takeUnread(seatId: string, limit: number): LobbyEvent[] {
    const rows = this.db.prepare(
      "SELECT seq, event_json FROM inbox WHERE seat_id = ? AND kind = 'message' AND own = 0 AND surfaced_at IS NULL ORDER BY seq LIMIT ?",
    ).all(seatId, limit) as { seq: number; event_json: string }[];
    const mark = this.db.prepare("UPDATE inbox SET surfaced_at = ? WHERE seat_id = ? AND seq = ?");
    for (const r of rows) mark.run(Date.now(), seatId, r.seq);
    return rows.map((r) => JSON.parse(r.event_json));
  }

  findEvent(seatId: string, eventId: string): LobbyEvent | undefined {
    const row = this.db.prepare("SELECT event_json FROM inbox WHERE seat_id = ? AND event_id = ?").get(seatId, eventId) as
      { event_json: string } | undefined;
    return row && JSON.parse(row.event_json);
  }

  findEnvelope(seatId: string, envelopeId: string): Envelope | undefined {
    const event = this.findEvent(seatId, envelopeId);
    return event?.kind === "message" ? event.envelope : undefined;
  }

  markSurfaced(seatId: string, eventId: string): void {
    this.db.prepare("UPDATE inbox SET surfaced_at = ? WHERE seat_id = ? AND event_id = ? AND surfaced_at IS NULL").run(Date.now(), seatId, eventId);
  }


  addOutbox(reqId: string, seatId: string, frame: unknown): void {
    this.db.prepare("INSERT INTO outbox (req_id, seat_id, frame_json, state, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .run(reqId, seatId, JSON.stringify(frame), Date.now());
  }

  pendingOutbox(seatId: string): unknown[] {
    return (this.db.prepare("SELECT frame_json FROM outbox WHERE seat_id = ? AND state = 'pending' ORDER BY created_at, req_id")
      .all(seatId) as { frame_json: string }[]).map((r) => JSON.parse(r.frame_json));
  }

  outboxFrame(reqId: string): unknown {
    const row = this.db.prepare("SELECT frame_json FROM outbox WHERE req_id = ?").get(reqId) as { frame_json: string } | undefined;
    return row && JSON.parse(row.frame_json);
  }

  finishOutbox(reqId: string, state: "done" | "failed"): void {
    this.db.prepare("UPDATE outbox SET state = ? WHERE req_id = ?").run(state, reqId);
  }

  addJoinRequest(r: JoinRequest): void {
    this.db.prepare("INSERT INTO join_requests (id, seat_key, client, code, handle, owns_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(r.id, r.seat_key, r.client, r.code, r.handle, JSON.stringify(r.owns), Date.now());
  }

  joinRequests(): JoinRequest[] {
    const rows = this.db.prepare("SELECT id, seat_key, client, code, handle, owns_json FROM join_requests ORDER BY created_at").all() as
      { id: string; seat_key: string; client: string; code: string; handle: string; owns_json: string }[];
    return rows.map(({ owns_json, ...r }) => ({ ...r, owns: JSON.parse(owns_json) }));
  }

  deleteJoinRequest(id: string): void {
    this.db.prepare("DELETE FROM join_requests WHERE id = ?").run(id);
  }


  upsertRoster(seatId: string, agents: AgentProfile[]): void {
    const upsert = this.db.prepare("INSERT OR REPLACE INTO roster (seat_id, agent_id, profile_json) VALUES (?, ?, ?)");
    for (const a of agents) upsert.run(seatId, a.agentId, JSON.stringify(a));
  }

  removeFromRoster(seatId: string, agentId: string): void {
    this.db.prepare("DELETE FROM roster WHERE seat_id = ? AND agent_id = ?").run(seatId, agentId);
  }

  roster(seatId: string): AgentProfile[] {
    return (this.db.prepare("SELECT profile_json FROM roster WHERE seat_id = ?").all(seatId) as { profile_json: string }[])
      .map((r) => JSON.parse(r.profile_json));
  }
}

export function openDb(path: string): Db {
  return new Db(new DatabaseSync(path));
}
