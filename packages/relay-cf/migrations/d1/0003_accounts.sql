CREATE TABLE users (
  user_id    TEXT PRIMARY KEY,
  github_id  INTEGER NOT NULL UNIQUE,
  login      TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE machines (
  machine_id TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(user_id),
  public_key TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX machines_user ON machines (user_id);
