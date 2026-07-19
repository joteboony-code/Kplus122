CREATE TABLE IF NOT EXISTS service_area_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  technician_name TEXT NOT NULL,
  line_user_id TEXT NOT NULL,
  province TEXT NOT NULL,
  district TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_area_mentions_unique
  ON service_area_mentions(line_user_id, province, district);

CREATE INDEX IF NOT EXISTS idx_service_area_mentions_enabled_area
  ON service_area_mentions(enabled, province, district);

INSERT INTO service_area_mentions
  (technician_name, line_user_id, province, district, enabled)
VALUES
  ('ผู้ดูแลพานทอง', 'U285cef534729ee5bcfa1bf4d8e84e323', 'ชลบุรี', 'พานทอง', 1)
ON CONFLICT(line_user_id, province, district) DO NOTHING;
