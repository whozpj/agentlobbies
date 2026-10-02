-- When an invite was made, for the per-account daily invite limit.
ALTER TABLE invites ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
