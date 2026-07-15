CREATE TABLE IF NOT EXISTS control_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO control_state (key, value)
VALUES ('control:processing-enabled', 'false')
ON CONFLICT(key) DO NOTHING;
