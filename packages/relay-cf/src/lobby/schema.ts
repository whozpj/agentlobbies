// Append-only: never edit a released migration.
const MIGRATIONS = [
  `
  CREATE TABLE lobby_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE agents (
    agent_id       TEXT PRIMARY KEY,
    handle         TEXT NOT NULL COLLATE NOCASE,
    client         TEXT NOT NULL,
    model          TEXT,
    owns           TEXT NOT NULL DEFAULT '[]',
    working_on     TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'offline',
    role           TEXT NOT NULL,
    public_key     TEXT NOT NULL,
    last_acked_seq INTEGER NOT NULL DEFAULT 0,
    joined_seq     INTEGER NOT NULL DEFAULT 0,
    joined_at      INTEGER NOT NULL,
    last_seen_at   INTEGER NOT NULL,
    left_at        INTEGER,
    kicked_at      INTEGER
  );
  CREATE UNIQUE INDEX agents_handle_active ON agents (handle COLLATE NOCASE)
    WHERE left_at IS NULL AND kicked_at IS NULL;

  CREATE TABLE events (
    seq          INTEGER PRIMARY KEY,
    id           TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL,
    from_agent   TEXT,
    to_kind      TEXT,
    to_target    TEXT,
    thread_depth INTEGER,
    committed_at INTEGER NOT NULL,
    event_json   TEXT NOT NULL
  );
  CREATE INDEX events_committed ON events (committed_at);

  CREATE TABLE subscriptions (topic TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY (topic, agent_id));
  CREATE INDEX subscriptions_agent ON subscriptions (agent_id);

  CREATE TABLE board (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, author TEXT NOT NULL,
    version INTEGER NOT NULL, seq INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE board_history (
    key TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, author TEXT NOT NULL,
    seq INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key, version)
  );

  CREATE TABLE held (envelope_id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, envelope_json TEXT NOT NULL, received_at INTEGER NOT NULL);
  CREATE TABLE rejected (envelope_id TEXT PRIMARY KEY, rejected_at INTEGER NOT NULL);

  CREATE TABLE rate_state (
    agent_id TEXT PRIMARY KEY, tokens REAL NOT NULL, refilled_at INTEGER NOT NULL,
    hour_start INTEGER NOT NULL, hour_count INTEGER NOT NULL, last_notice_at INTEGER
  );

  CREATE TABLE jobs (name TEXT PRIMARY KEY, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
  `,
];

/** True once init() has created this lobby. Stray requests must not create tables (G17). */
export function lobbyExists(sql: SqlStorage): boolean {
  return sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lobby_meta'").toArray().length > 0;
}

export function migrate(sql: SqlStorage): void {
  let version = lobbyExists(sql)
    ? Number(sql.exec("SELECT value FROM lobby_meta WHERE key = 'schema_version'").toArray()[0]?.value ?? 0)
    : 0;
  while (version < MIGRATIONS.length) {
    sql.exec(MIGRATIONS[version]!);
    version++;
    sql.exec("INSERT OR REPLACE INTO lobby_meta VALUES ('schema_version', ?)", String(version));
  }
}
