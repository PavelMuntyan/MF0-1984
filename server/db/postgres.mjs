/**
 * Postgres pool creation and schema migrations.
 * Imported dynamically by migrations.mjs only when DB_ADAPTER=postgres.
 *
 * All tables are created with CREATE TABLE IF NOT EXISTS so the function
 * is idempotent on every startup. ADD COLUMN IF NOT EXISTS handles columns
 * that were added in later SQLite migrations.
 *
 * Timestamp columns use TEXT (same as SQLite) — the app always provides
 * ISO-8601 strings explicitly; the DEFAULT is only a safeguard.
 */
import { createPostgresAdapter } from "./adapter.mjs";

const ISO_NOW = `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

async function q(pool, sql, params) {
  await pool.query(sql, params);
}

async function columnExists(pool, table, column) {
  const res = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return res.rows.length > 0;
}

async function addColumnIfMissing(pool, table, column, definition) {
  if (!(await columnExists(pool, table, column))) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export async function runPostgresMigrations(pool) {
  await q(pool, `
    CREATE TABLE IF NOT EXISTS themes (
      id          TEXT PRIMARY KEY NOT NULL,
      title       TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (${ISO_NOW}),
      updated_at  TEXT NOT NULL DEFAULT (${ISO_NOW})
    )
  `);

  await q(pool, `
    CREATE TABLE IF NOT EXISTS dialogs (
      id          TEXT PRIMARY KEY NOT NULL,
      theme_id    TEXT NOT NULL REFERENCES themes (id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      purpose     TEXT,
      created_at  TEXT NOT NULL DEFAULT (${ISO_NOW}),
      updated_at  TEXT NOT NULL DEFAULT (${ISO_NOW})
    )
  `);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_dialogs_theme_id ON dialogs (theme_id)`);

  await q(pool, `
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id                          TEXT PRIMARY KEY NOT NULL,
      dialog_id                   TEXT NOT NULL REFERENCES dialogs (id) ON DELETE CASCADE,
      user_text                   TEXT NOT NULL,
      user_attachments_json       TEXT,
      assistant_text              TEXT,
      requested_provider_id       TEXT NOT NULL,
      responding_provider_id      TEXT,
      request_type                TEXT NOT NULL,
      user_message_at             TEXT NOT NULL,
      assistant_message_at        TEXT,
      assistant_favorite          INTEGER NOT NULL DEFAULT 0,
      assistant_favorite_markdown TEXT,
      assistant_error             INTEGER NOT NULL DEFAULT 0,
      llm_prompt_tokens           INTEGER,
      llm_completion_tokens       INTEGER,
      llm_total_tokens            INTEGER
    )
  `);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_turns_dialog_user_at ON conversation_turns (dialog_id, user_message_at)`);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_turns_dialog_id ON conversation_turns (dialog_id)`);

  await q(pool, `
    CREATE TABLE IF NOT EXISTS rule_blocks (
      id               TEXT PRIMARY KEY NOT NULL,
      priority         TEXT NOT NULL,
      scope            TEXT NOT NULL,
      rule_trigger     TEXT NOT NULL,
      rule_text        TEXT NOT NULL,
      examples         TEXT,
      negative_examples TEXT,
      validation       TEXT,
      created_at       TEXT NOT NULL DEFAULT (${ISO_NOW}),
      updated_at       TEXT NOT NULL DEFAULT (${ISO_NOW})
    )
  `);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_rule_blocks_scope ON rule_blocks (scope)`);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_rule_blocks_priority ON rule_blocks (priority)`);

  await q(pool, `
    CREATE TABLE IF NOT EXISTS rules (
      id         TEXT PRIMARY KEY NOT NULL,
      rule_type  TEXT NOT NULL,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      priority   TEXT NOT NULL,
      tags       TEXT,
      is_active  INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (${ISO_NOW}),
      updated_at TEXT NOT NULL DEFAULT (${ISO_NOW})
    )
  `);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_rules_active_priority ON rules (is_active, priority)`);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_rules_type ON rules (rule_type)`);
  await q(pool, `
    INSERT INTO rules (id, rule_type, title, content, priority, tags, is_active)
    VALUES ('core-default-001', 'core', 'Default agent core',
            'You are a helpful assistant. Be concise, accurate, and follow user constraints when stated.',
            'critical', '[]', 1)
    ON CONFLICT DO NOTHING
  `);

  await q(pool, `
    CREATE TABLE IF NOT EXISTS memory_items (
      id                TEXT PRIMARY KEY NOT NULL,
      scope             TEXT NOT NULL,
      thread_id         TEXT REFERENCES dialogs (id) ON DELETE CASCADE,
      memory_type       TEXT NOT NULL,
      title             TEXT NOT NULL,
      content           TEXT NOT NULL,
      priority          TEXT NOT NULL,
      tags              TEXT,
      source_message_id TEXT,
      created_at        TEXT NOT NULL DEFAULT (${ISO_NOW}),
      updated_at        TEXT NOT NULL DEFAULT (${ISO_NOW}),
      embedding         BYTEA,
      is_active         INTEGER NOT NULL DEFAULT 1
    )
  `);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_memory_scope_active ON memory_items (scope, is_active)`);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_memory_thread_active ON memory_items (thread_id, is_active)`);

  await q(pool, `
    CREATE TABLE IF NOT EXISTS thread_summaries (
      id                       TEXT PRIMARY KEY NOT NULL,
      thread_id                TEXT NOT NULL REFERENCES dialogs (id) ON DELETE CASCADE,
      summary_text             TEXT NOT NULL,
      summary_type             TEXT NOT NULL,
      covered_until_message_id TEXT,
      created_at               TEXT NOT NULL DEFAULT (${ISO_NOW}),
      updated_at               TEXT NOT NULL DEFAULT (${ISO_NOW})
    )
  `);
  await q(pool, `CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_summaries_thread_type ON thread_summaries (thread_id, summary_type)`);

  await q(pool, `
    CREATE TABLE IF NOT EXISTS thread_messages (
      id              TEXT PRIMARY KEY NOT NULL,
      thread_id       TEXT NOT NULL REFERENCES dialogs (id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      tokens_estimate INTEGER NOT NULL DEFAULT 0,
      embedding       BYTEA,
      metadata        TEXT,
      source_turn_id  TEXT REFERENCES conversation_turns (id) ON DELETE SET NULL
    )
  `);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_created ON thread_messages (thread_id, created_at)`);

  await q(pool, `
    CREATE TABLE IF NOT EXISTS memory_graph_nodes (
      id         TEXT PRIMARY KEY NOT NULL,
      category   TEXT NOT NULL,
      label      TEXT NOT NULL,
      blob       TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (${ISO_NOW}),
      updated_at TEXT NOT NULL DEFAULT (${ISO_NOW})
    )
  `);
  await q(pool, `CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_graph_nodes_cat_label ON memory_graph_nodes (category, label)`);

  await q(pool, `
    CREATE TABLE IF NOT EXISTS memory_graph_edges (
      id             TEXT PRIMARY KEY NOT NULL,
      source_node_id TEXT NOT NULL REFERENCES memory_graph_nodes (id) ON DELETE CASCADE,
      target_node_id TEXT NOT NULL REFERENCES memory_graph_nodes (id) ON DELETE CASCADE,
      relation       TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL DEFAULT (${ISO_NOW})
    )
  `);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_src ON memory_graph_edges (source_node_id)`);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_tgt ON memory_graph_edges (target_node_id)`);

  await q(pool, `
    CREATE TABLE IF NOT EXISTS ir_panel_pin_lock (
      panel          TEXT PRIMARY KEY CHECK (panel IN ('intro', 'rules', 'access')),
      pin_double_hash TEXT NOT NULL
    )
  `);

  await q(pool, `
    CREATE TABLE IF NOT EXISTS access_external_services (
      id           TEXT PRIMARY KEY NOT NULL,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      endpoint_url TEXT NOT NULL DEFAULT '',
      access_key   TEXT NOT NULL DEFAULT '',
      notes        TEXT NOT NULL DEFAULT '',
      updated_at   TEXT NOT NULL DEFAULT (${ISO_NOW})
    )
  `);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_access_external_services_name ON access_external_services (name)`);

  await q(pool, `
    CREATE TABLE IF NOT EXISTS analytics_usage_archive (
      id             TEXT PRIMARY KEY NOT NULL,
      archived_at    TEXT NOT NULL,
      source_kind    TEXT NOT NULL,
      theme_id       TEXT,
      dialog_id      TEXT NOT NULL,
      dialog_purpose TEXT NOT NULL,
      provider_id    TEXT NOT NULL,
      request_type   TEXT NOT NULL,
      turn_count     INTEGER NOT NULL,
      responses_ok   INTEGER NOT NULL,
      tokens_prompt  INTEGER NOT NULL DEFAULT 0,
      tokens_completion INTEGER NOT NULL DEFAULT 0,
      tokens_total   INTEGER NOT NULL DEFAULT 0
    )
  `);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_analytics_usage_archive_archived_at ON analytics_usage_archive (archived_at)`);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_analytics_usage_archive_dialog_id ON analytics_usage_archive (dialog_id)`);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_analytics_usage_archive_theme_id ON analytics_usage_archive (theme_id)`);

  await q(pool, `
    CREATE TABLE IF NOT EXISTS analytics_aux_llm_usage (
      id                    TEXT PRIMARY KEY NOT NULL,
      created_at            TEXT NOT NULL DEFAULT (${ISO_NOW}),
      provider_id           TEXT NOT NULL,
      request_kind          TEXT NOT NULL,
      llm_prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      llm_completion_tokens INTEGER NOT NULL DEFAULT 0,
      llm_total_tokens      INTEGER NOT NULL DEFAULT 0,
      conversation_turn_id  TEXT,
      dialog_id             TEXT
    )
  `);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_analytics_aux_llm_usage_created  ON analytics_aux_llm_usage (created_at)`);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_analytics_aux_llm_usage_provider ON analytics_aux_llm_usage (provider_id)`);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_analytics_aux_llm_usage_turn     ON analytics_aux_llm_usage (conversation_turn_id)`);
  await q(pool, `CREATE INDEX IF NOT EXISTS idx_analytics_aux_llm_usage_dialog   ON analytics_aux_llm_usage (dialog_id)`);
}

/**
 * Create a pg Pool from DATABASE_URL and return a fully migrated DbAdapter.
 * @returns {Promise<import("./adapter.mjs").DbAdapter>}
 */
export async function createPostgresSetup() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DB_ADAPTER=postgres requires DATABASE_URL to be set");

  let pg;
  try {
    pg = (await import("pg")).default;
  } catch {
    throw new Error('DB_ADAPTER=postgres requires the "pg" package — run: npm install pg');
  }

  const pool = new pg.Pool({ connectionString: url });
  // Verify connectivity before running migrations.
  await pool.query("SELECT 1");
  await runPostgresMigrations(pool);
  console.log("[mf-lab-db] Postgres connected and migrations applied");
  return createPostgresAdapter(pool);
}
