ALTER TABLE inspection_logs
  ADD COLUMN line_delivery_status TEXT NOT NULL DEFAULT 'not_applicable';

ALTER TABLE inspection_logs
  ADD COLUMN line_delivery_method TEXT;

ALTER TABLE inspection_logs
  ADD COLUMN line_delivery_updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_inspection_logs_message_id
  ON inspection_logs(message_id);
