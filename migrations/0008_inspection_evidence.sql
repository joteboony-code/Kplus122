ALTER TABLE inspection_logs ADD COLUMN image_set_id TEXT;
ALTER TABLE inspection_logs ADD COLUMN image_set_index INTEGER;
ALTER TABLE inspection_logs ADD COLUMN image_set_total INTEGER;
ALTER TABLE inspection_logs ADD COLUMN evidence_json TEXT;

CREATE INDEX IF NOT EXISTS idx_inspection_logs_image_set
  ON inspection_logs(image_set_id, created_at DESC);
