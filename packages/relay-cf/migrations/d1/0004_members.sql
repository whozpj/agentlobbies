CREATE TABLE lobby_members (
  lobby_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  role     TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (lobby_id, user_id)
);
CREATE INDEX lobby_members_user ON lobby_members (user_id);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  lobby_id   TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('member', 'viewer')),
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses   INTEGER,
  uses       INTEGER NOT NULL DEFAULT 0
);
