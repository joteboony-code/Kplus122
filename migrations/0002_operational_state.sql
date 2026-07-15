ALTER TABLE control_state ADD COLUMN expires_at INTEGER;

CREATE INDEX IF NOT EXISTS control_state_expires_at_idx
ON control_state(expires_at);
