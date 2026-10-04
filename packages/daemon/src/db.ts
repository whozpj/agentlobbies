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

  CREATE TABLE IF NOT EXISTS account (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    user_id    TEXT NOT NULL,
    login      TEXT NOT NULL,
    avatar_url TEXT NOT NULL,
    token      TEXT NOT NULL,
    machine_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS local_agents (
    seat_key     TEXT PRIMARY KEY,
    client       TEXT NOT NULL,
    cwd          TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    seat_id     TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    surfaced_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS pending_sends (
    id         TEXT PRIMARY KEY,
    seat_id    TEXT NOT NULL,
    params     TEXT NOT NULL,                -- the message.send parameters, waiting for the user's approval
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lobby_keys (
    lobby_id TEXT NOT NULL,
    epoch    INTEGER NOT NULL,
    key      TEXT NOT NULL,                  -- opened lobby key, base64url (LLD 15.2)
    PRIMARY KEY (lobby_id, epoch)
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
export interface Account {
  user_id: string;
  login: string;
  avatar_url: string;
  token: string;
  machine_id: string;
}

export interface LocalAgent {
  seat_key: string;
  client: string;
  cwd: string;
  last_seen_at: number;
  secure: number;
}

export interface PendingSend {
  id: string;
  seat_id: string;
  params: string;
  created_at: number;
}

export interface Notice {
  id: number;
  body: string;
  created_at: number;
}

export class Db {
  constructor(private readonly db: DatabaseSync) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    // Added in v0.4: a message this machine can't decrypt yet waits, unseen, until the key arrives.
    const inboxColumns = db.prepare("PRAGMA table_info(inbox)").all() as { name: string }[];
    if (!inboxColumns.some((c) => c.name === "locked")) db.exec("ALTER TABLE inbox ADD COLUMN locked INTEGER NOT NULL DEFAULT 0");
    // Added in v0.5: secure mode, per agent.
    const agentColumns = db.prepare("PRAGMA table_info(local_agents)").all() as { name: string }[];
    if (!agentColumns.some((c) => c.name === "secure")) db.exec("ALTER TABLE local_agents ADD COLUMN secure INTEGER NOT NULL DEFAULT 0");
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

  seat(seatId: string): Seat {
    return this.db.prepare("SELECT * FROM seats WHERE seat_id = ?").get(seatId) as unknown as Seat;
  }

  setSeatHandle(seatId: string, handle: string): void {
    this.db.prepare("UPDATE seats SET handle = ? WHERE seat_id = ?").run(handle, seatId);
  }

  setJwt(seatId: string, jwt: string): void {
    this.db.prepare("UPDATE seats SET jwt = ? WHERE seat_id = ?").run(jwt, seatId);
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


  /** Stores events, ignoring any already stored (replays are safe to repeat). `locked` ids wait for their key. */
  ingest(seatId: string, events: LobbyEvent[], locked: Set<string> = new Set()): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO inbox (seat_id, seq, event_id, kind, event_json, locked) VALUES (?, ?, ?, ?, ?, ?)");
    for (const e of events) insert.run(seatId, e.seq, eventId(e), e.kind, JSON.stringify(e), locked.has(eventId(e)) ? 1 : 0);
  }

  /** Messages in a lobby still waiting for their key, across this machine's seats. */
  lockedMessages(lobbyId: string): { seat_id: string; seq: number; event_json: string }[] {
    return this.db.prepare(
      `SELECT i.seat_id, i.seq, i.event_json FROM inbox i JOIN seats s ON s.seat_id = i.seat_id
       WHERE s.lobby_id = ? AND i.locked = 1 ORDER BY i.seq`,
    ).all(lobbyId) as { seat_id: string; seq: number; event_json: string }[];
  }

  unlock(seatId: string, seq: number, eventJson: string): void {
    this.db.prepare("UPDATE inbox SET event_json = ?, locked = 0 WHERE seat_id = ? AND seq = ?").run(eventJson, seatId, seq);
  }

  /** Erases everything this machine keeps about a lobby: its seats' messages, rosters, notices, and keys. */
  forgetLobby(lobbyId: string): void {
    const seatIds = (this.db.prepare("SELECT seat_id FROM seats WHERE lobby_id = ?").all(lobbyId) as { seat_id: string }[]).map((r) => r.seat_id);
    for (const seatId of seatIds) {
      this.db.prepare("DELETE FROM inbox WHERE seat_id = ?").run(seatId);
      this.db.prepare("DELETE FROM roster WHERE seat_id = ?").run(seatId);
      this.db.prepare("DELETE FROM notices WHERE seat_id = ?").run(seatId);
      this.db.prepare("DELETE FROM outbox WHERE seat_id = ?").run(seatId);
      this.db.prepare("DELETE FROM pending_sends WHERE seat_id = ?").run(seatId);
    }
    this.db.prepare("UPDATE seats SET state = 'left' WHERE lobby_id = ? AND state = 'active'").run(lobbyId);
    this.db.prepare("DELETE FROM lobby_keys WHERE lobby_id = ?").run(lobbyId);
  }

  saveLobbyKey(lobbyId: string, epoch: number, key: Uint8Array): void {
    this.db.prepare("INSERT OR IGNORE INTO lobby_keys (lobby_id, epoch, key) VALUES (?, ?, ?)").run(lobbyId, epoch, Buffer.from(key).toString("base64url"));
  }

  lobbyKey(lobbyId: string, epoch: number): Uint8Array | undefined {
    const row = this.db.prepare("SELECT key FROM lobby_keys WHERE lobby_id = ? AND epoch = ?").get(lobbyId, epoch) as { key: string } | undefined;
    return row ? new Uint8Array(Buffer.from(row.key, "base64url")) : undefined;
  }

  /** The newest key this machine holds for a lobby: the one new messages use. */
  latestLobbyKey(lobbyId: string): { epoch: number; key: Uint8Array } | undefined {
    const row = this.db.prepare("SELECT epoch, key FROM lobby_keys WHERE lobby_id = ? ORDER BY epoch DESC LIMIT 1").get(lobbyId) as
      { epoch: number; key: string } | undefined;
    return row ? { epoch: row.epoch, key: new Uint8Array(Buffer.from(row.key, "base64url")) } : undefined;
  }

  /** Records a message this seat sent, so replies can find their parent (G8). */
  recordOwn(seatId: string, e: LobbyEvent): void {
    this.db.prepare("INSERT OR IGNORE INTO inbox (seat_id, seq, event_id, kind, event_json, own, surfaced_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
      .run(seatId, e.seq, eventId(e), e.kind, JSON.stringify(e), Date.now());
  }

  unreadCount(seatId: string): number {
    const messages = (this.db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE seat_id = ? AND kind = 'message' AND own = 0 AND locked = 0 AND surfaced_at IS NULL")
      .get(seatId) as { n: number }).n;
    const notices = (this.db.prepare("SELECT COUNT(*) AS n FROM notices WHERE seat_id = ? AND surfaced_at IS NULL").get(seatId) as { n: number }).n;
    return messages + notices;
  }

  /** Oldest unread messages first; marks exactly those as read. */
  takeUnread(seatId: string, limit: number): LobbyEvent[] {
    const rows = this.db.prepare(
      "SELECT seq, event_json FROM inbox WHERE seat_id = ? AND kind = 'message' AND own = 0 AND locked = 0 AND surfaced_at IS NULL ORDER BY seq LIMIT ?",
    ).all(seatId, limit) as { seq: number; event_json: string }[];
    const mark = this.db.prepare("UPDATE inbox SET surfaced_at = ? WHERE seat_id = ? AND seq = ?");
    for (const r of rows) mark.run(Date.now(), seatId, r.seq);
    return rows.map((r) => JSON.parse(r.event_json));
  }

  /** Messages seen by any of these seats (including their own), each once, oldest first. */
  messagesForSeats(seatIds: string[], limit: number): LobbyEvent[] {
    if (seatIds.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT event_json FROM inbox WHERE kind = 'message' AND seat_id IN (${seatIds.map(() => "?").join(", ")})
       GROUP BY event_id ORDER BY MIN(seq) DESC LIMIT ?`,
    ).all(...seatIds, limit) as { event_json: string }[];
    return rows.map((r) => JSON.parse(r.event_json) as LobbyEvent).reverse();
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

  replaceOutboxFrame(reqId: string, frame: unknown): void {
    this.db.prepare("UPDATE outbox SET frame_json = ? WHERE req_id = ?").run(JSON.stringify(frame), reqId);
  }

  finishOutbox(reqId: string, state: "done" | "failed"): void {
    this.db.prepare("UPDATE outbox SET state = ? WHERE req_id = ?").run(state, reqId);
  }

  account(): Account | undefined {
    return this.db.prepare("SELECT user_id, login, avatar_url, token, machine_id FROM account WHERE id = 1").get() as Account | undefined;
  }

  setAccount(a: Account): void {
    this.db.prepare("INSERT OR REPLACE INTO account (id, user_id, login, avatar_url, token, machine_id) VALUES (1, ?, ?, ?, ?, ?)")
      .run(a.user_id, a.login, a.avatar_url, a.token, a.machine_id);
  }

  setAccountToken(token: string): void {
    this.db.prepare("UPDATE account SET token = ? WHERE id = 1").run(token);
  }

  clearAccount(): void {
    this.db.prepare("DELETE FROM account").run();
  }

  upsertLocalAgent(seatKey: string, client: string, cwd: string): void {
    this.db.prepare(
      `INSERT INTO local_agents (seat_key, client, cwd, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (seat_key) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    ).run(seatKey, client, cwd, Date.now());
  }

  localAgents(): LocalAgent[] {
    return this.db.prepare("SELECT * FROM local_agents ORDER BY last_seen_at DESC").all() as unknown as LocalAgent[];
  }

  localAgent(seatKey: string): LocalAgent | undefined {
    return this.db.prepare("SELECT * FROM local_agents WHERE seat_key = ?").get(seatKey) as LocalAgent | undefined;
  }

  setSecure(seatKey: string, secure: boolean): void {
    this.db.prepare("UPDATE local_agents SET secure = ? WHERE seat_key = ?").run(secure ? 1 : 0, seatKey);
  }

  addPendingSend(id: string, seatId: string, params: unknown): void {
    this.db.prepare("INSERT INTO pending_sends (id, seat_id, params, created_at) VALUES (?, ?, ?, ?)").run(id, seatId, JSON.stringify(params), Date.now());
  }

  pendingSends(): PendingSend[] {
    return this.db.prepare("SELECT * FROM pending_sends ORDER BY created_at").all() as unknown as PendingSend[];
  }

  pendingSend(id: string): PendingSend | undefined {
    return this.db.prepare("SELECT * FROM pending_sends WHERE id = ?").get(id) as PendingSend | undefined;
  }

  removePendingSend(id: string): void {
    this.db.prepare("DELETE FROM pending_sends WHERE id = ?").run(id);
  }

  /** Seats (active) that belong to a seat key, e.g. every lobby an agent is in. */
  seatsFor(seatKey: string): Seat[] {
    return this.db.prepare("SELECT * FROM seats WHERE seat_key = ? AND state = 'active'").all(seatKey) as unknown as Seat[];
  }

  activeSeatIn(seatKey: string, lobbyId: string): Seat | undefined {
    return this.db.prepare("SELECT * FROM seats WHERE seat_key = ? AND lobby_id = ? AND state = 'active'").get(seatKey, lobbyId) as Seat | undefined;
  }

  addNotice(seatId: string, body: string): void {
    this.db.prepare("INSERT INTO notices (seat_id, body, created_at) VALUES (?, ?, ?)").run(seatId, body, Date.now());
  }

  takeNotices(seatId: string): Notice[] {
    const rows = this.db.prepare("SELECT id, body, created_at FROM notices WHERE seat_id = ? AND surfaced_at IS NULL ORDER BY id").all(seatId) as unknown as Notice[];
    const mark = this.db.prepare("UPDATE notices SET surfaced_at = ? WHERE id = ?");
    for (const n of rows) mark.run(Date.now(), n.id);
    return rows;
  }

  replaceRoster(seatId: string, agents: AgentProfile[]): void {
    this.db.prepare("DELETE FROM roster WHERE seat_id = ?").run(seatId);
    this.upsertRoster(seatId, agents);
  }

  /** Adds a member only if unknown, so a replayed join never overwrites fresher presence. */
  addToRoster(seatId: string, agent: AgentProfile): void {
    this.db.prepare("INSERT OR IGNORE INTO roster (seat_id, agent_id, profile_json) VALUES (?, ?, ?)")
      .run(seatId, agent.agentId, JSON.stringify(agent));
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
