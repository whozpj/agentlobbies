-- Accounts suspended for abuse can't sign in or use the relay.
ALTER TABLE users ADD COLUMN suspended_at INTEGER;
