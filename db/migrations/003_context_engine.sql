-- Context pipeline: rules, memory, per-dialog messages mirror, summaries.
-- thread_id = dialogs.id (тред в продукте = диалог в БД).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY NOT NULL,
  rule_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  priority TEXT NOT NULL,
  tags TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rules_active_priority ON rules (is_active, priority);
CREATE INDEX IF NOT EXISTS idx_rules_type ON rules (rule_type);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  thread_id TEXT REFERENCES dialogs (id) ON DELETE CASCADE,
  memory_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  priority TEXT NOT NULL,
  tags TEXT,
  source_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  embedding BLOB,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_memory_scope_active ON memory_items (scope, is_active);
CREATE INDEX IF NOT EXISTS idx_memory_thread_active ON memory_items (thread_id, is_active);

CREATE TABLE IF NOT EXISTS thread_summaries (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL REFERENCES dialogs (id) ON DELETE CASCADE,
  summary_text TEXT NOT NULL,
  summary_type TEXT NOT NULL,
  covered_until_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_summaries_thread_type ON thread_summaries (thread_id, summary_type);

CREATE TABLE IF NOT EXISTS thread_messages (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL REFERENCES dialogs (id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  tokens_estimate INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,
  metadata TEXT,
  source_turn_id TEXT REFERENCES conversation_turns (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_created ON thread_messages (thread_id, created_at);

INSERT OR IGNORE INTO rules (id, rule_type, title, content, priority, tags, is_active)
VALUES (
  'core-default-001',
  'core',
  'Default agent core',
  'You are a helpful assistant. Be concise, accurate, and follow user constraints when stated.',
  'critical',
  '[]',
  1
);

PRAGMA user_version = 3;
