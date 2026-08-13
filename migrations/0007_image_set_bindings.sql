CREATE TABLE IF NOT EXISTS image_set_bindings (
  conversation_id TEXT NOT NULL,
  sender_user_id TEXT NOT NULL,
  image_set_id TEXT NOT NULL,
  reference_code TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, sender_user_id, image_set_id)
);

CREATE INDEX IF NOT EXISTS idx_image_set_bindings_expiry
  ON image_set_bindings(expires_at);
