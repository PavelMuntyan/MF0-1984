-- Track assistant failures per turn for analytics (0 = success or legacy unknown).
ALTER TABLE conversation_turns ADD COLUMN assistant_error INTEGER NOT NULL DEFAULT 0;
