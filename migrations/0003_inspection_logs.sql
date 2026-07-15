CREATE TABLE IF NOT EXISTS inspection_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  webhook_event_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  conversation_id TEXT,
  sender_user_id TEXT,
  reference_code TEXT,
  outcome TEXT NOT NULL,
  stage TEXT,
  provider_chain TEXT,
  provider_timings TEXT,
  observed_amounts TEXT,
  has_kplus INTEGER,
  has_settlement INTEGER,
  queue_delay_ms INTEGER,
  processing_ms INTEGER NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_inspection_logs_created_at
  ON inspection_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inspection_logs_reference_code
  ON inspection_logs(reference_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inspection_logs_outcome
  ON inspection_logs(outcome, created_at DESC);
