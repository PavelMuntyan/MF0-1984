-- Normalized usage preserved when threads are cleared or dialogs are deleted with the theme.
-- One row per (archived_at event, dialog_id, provider_id, request_type) bucket.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS analytics_usage_archive (
  id TEXT PRIMARY KEY NOT NULL,
  archived_at TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  theme_id TEXT,
  dialog_id TEXT NOT NULL,
  dialog_purpose TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  request_type TEXT NOT NULL,
  turn_count INTEGER NOT NULL,
  responses_ok INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_usage_archive_archived_at ON analytics_usage_archive (archived_at);
CREATE INDEX IF NOT EXISTS idx_analytics_usage_archive_dialog_id ON analytics_usage_archive (dialog_id);
CREATE INDEX IF NOT EXISTS idx_analytics_usage_archive_theme_id ON analytics_usage_archive (theme_id);
