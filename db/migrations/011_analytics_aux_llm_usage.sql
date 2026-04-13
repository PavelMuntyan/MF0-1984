-- Auxiliary LLM calls (Memory tree router, interest sketch, graph normalize/extract) for analytics token totals.

CREATE TABLE IF NOT EXISTS analytics_aux_llm_usage (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  provider_id TEXT NOT NULL,
  request_kind TEXT NOT NULL,
  llm_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  llm_completion_tokens INTEGER NOT NULL DEFAULT 0,
  llm_total_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_analytics_aux_llm_usage_created ON analytics_aux_llm_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_aux_llm_usage_provider ON analytics_aux_llm_usage(provider_id);
