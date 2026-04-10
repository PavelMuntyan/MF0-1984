-- Apply to an existing v1 DB: sqlite3 data/mf-lab.sqlite < db/migrations/002_rule_blocks.sql

PRAGMA foreign_keys = ON;

CREATE TABLE rule_blocks (
  id TEXT PRIMARY KEY NOT NULL,
  priority TEXT NOT NULL,
  scope TEXT NOT NULL,
  rule_trigger TEXT NOT NULL,
  rule_text TEXT NOT NULL,
  examples TEXT,
  negative_examples TEXT,
  validation TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_rule_blocks_scope ON rule_blocks (scope);
CREATE INDEX idx_rule_blocks_priority ON rule_blocks (priority);

PRAGMA user_version = 2;
