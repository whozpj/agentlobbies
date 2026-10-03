-- Browser sign-ins, so signing out or revoking a browser ends its session.
CREATE TABLE web_sessions (
  session_id TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX web_sessions_user ON web_sessions (user_id);
-- The browser session a browser device was registered from.
ALTER TABLE machines ADD COLUMN session_id TEXT;
