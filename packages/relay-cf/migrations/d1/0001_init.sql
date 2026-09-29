CREATE TABLE lobbies (
  lobby_id        TEXT PRIMARY KEY,
  name            TEXT,
  created_at      INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('creating', 'open', 'closing', 'closed')),
  closed_at       INTEGER,
  archive_key     TEXT,
  creator_ip_hash TEXT
);

CREATE TABLE lobby_codes (
  code       TEXT PRIMARY KEY,
  lobby_id   TEXT NOT NULL REFERENCES lobbies(lobby_id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('member', 'observer')),
  expires_at INTEGER NOT NULL,
  max_uses   INTEGER,
  uses       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX lobby_codes_expiry ON lobby_codes (expires_at);
CREATE INDEX lobby_codes_lobby ON lobby_codes (lobby_id);
