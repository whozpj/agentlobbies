-- X25519 public key each machine's lobby keys are sealed to (LLD 15.2).
ALTER TABLE machines ADD COLUMN box_public_key TEXT;
