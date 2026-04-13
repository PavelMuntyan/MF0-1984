-- Per-turn LLM token counts when the provider returns usage (optional).

PRAGMA foreign_keys = ON;

ALTER TABLE conversation_turns ADD COLUMN llm_prompt_tokens INTEGER;
ALTER TABLE conversation_turns ADD COLUMN llm_completion_tokens INTEGER;
ALTER TABLE conversation_turns ADD COLUMN llm_total_tokens INTEGER;

-- Archive buckets: summed when threads are cleared / themes deleted.
ALTER TABLE analytics_usage_archive ADD COLUMN tokens_prompt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE analytics_usage_archive ADD COLUMN tokens_completion INTEGER NOT NULL DEFAULT 0;
ALTER TABLE analytics_usage_archive ADD COLUMN tokens_total INTEGER NOT NULL DEFAULT 0;
