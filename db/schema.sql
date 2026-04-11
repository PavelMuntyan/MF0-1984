-- MF0-1984 — SQLite schema (initial)
-- Hierarchy: theme → dialog (thread in the UI). Each turn = user message + assistant reply.

PRAGMA foreign_keys = ON;

CREATE TABLE themes (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE dialogs (
  id TEXT PRIMARY KEY NOT NULL,
  theme_id TEXT NOT NULL REFERENCES themes (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_dialogs_theme_id ON dialogs (theme_id);

-- One row per exchange: user prompt and model reply (same ordering field for chronological chat).
-- requested_provider_id / responding_provider_id: e.g. openai, perplexity, gemini-flash, anthropic
-- request_type: matches attach menu — default | image | research | web (add values as product grows)
CREATE TABLE conversation_turns (
  id TEXT PRIMARY KEY NOT NULL,
  dialog_id TEXT NOT NULL REFERENCES dialogs (id) ON DELETE CASCADE,
  user_text TEXT NOT NULL,
  user_attachments_json TEXT,
  assistant_text TEXT,
  requested_provider_id TEXT NOT NULL,
  responding_provider_id TEXT,
  request_type TEXT NOT NULL,
  user_message_at TEXT NOT NULL,
  assistant_message_at TEXT,
  assistant_favorite INTEGER NOT NULL DEFAULT 0,
  assistant_favorite_markdown TEXT
);

CREATE INDEX idx_turns_dialog_user_at ON conversation_turns (dialog_id, user_message_at);
CREATE INDEX idx_turns_dialog_id ON conversation_turns (dialog_id);

-- Structured agent rules (atomic blocks, not one long prose sheet).
-- examples / negative_examples: JSON array of strings recommended, or plain text.
-- rule_trigger: when the rule applies (SQL column name; avoids reserved TRIGGER).
-- validation: machine-oriented hook, e.g. edit_blocked_if_full_read_not_confirmed
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
