/**
 * Theme / dialog / turn DB queries and write helpers.
 * Uses the shared DbAdapter — swap the import line to switch from SQLite to Postgres.
 */
import crypto from "node:crypto";
import { db, adapter } from "./migrations.mjs";

/** Raw timestamp string from SQLite for the client — YY-MM-DD HH:MM is interpreted in the browser (local time). */
export function rawDbTimestamp(value) {
  if (value == null || value === "") return "";
  return String(value);
}

/**
 * Inserts normalized analytics_usage_archive rows (one per provider × request_type) for current turns.
 * @param {string} dialogId
 * @param {'ir_thread_cleared' | 'theme_dialog'} sourceKind
 * @param {string | null} [themeIdOverride]
 */
export async function archiveConversationTurnAggregatesForDialog(dialogId, sourceKind, themeIdOverride = null) {
  const did = String(dialogId ?? "").trim();
  if (!did) return;
  const drow = await adapter.get(
    `SELECT id, theme_id, IFNULL(purpose, '') AS purpose FROM dialogs WHERE id = ?`,
    [did],
  );
  if (!drow) return;
  const themeId =
    themeIdOverride != null && String(themeIdOverride).trim()
      ? String(themeIdOverride).trim()
      : String(drow.theme_id ?? "").trim();
  const purpose = String(drow.purpose ?? "").trim();
  const now = new Date().toISOString();
  const groups = await adapter.all(
    `SELECT
       COALESCE(NULLIF(TRIM(responding_provider_id), ''), requested_provider_id) AS pid,
       request_type,
       COUNT(*) AS turn_count,
       SUM(CASE WHEN assistant_message_at IS NOT NULL AND IFNULL(assistant_error, 0) = 0 THEN 1 ELSE 0 END) AS responses_ok,
       SUM(COALESCE(llm_prompt_tokens, 0)) AS tokens_prompt,
       SUM(COALESCE(llm_completion_tokens, 0)) AS tokens_completion,
       SUM(COALESCE(llm_total_tokens, 0)) AS tokens_total
     FROM conversation_turns
     WHERE dialog_id = ?
     GROUP BY pid, request_type`,
    [did],
  );
  const sql = `INSERT INTO analytics_usage_archive (id, archived_at, source_kind, theme_id, dialog_id, dialog_purpose, provider_id, request_type, turn_count, responses_ok, tokens_prompt, tokens_completion, tokens_total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  for (const g of groups) {
    const pid = String(g.pid ?? "").trim();
    const rt = String(g.request_type ?? "default").trim() || "default";
    const tc = Number(g.turn_count) || 0;
    const rok = Number(g.responses_ok) || 0;
    const tp = Number(g.tokens_prompt) || 0;
    const tcpl = Number(g.tokens_completion) || 0;
    const tt = Number(g.tokens_total) || 0;
    if (!pid || tc <= 0) continue;
    await adapter.run(sql, [crypto.randomUUID(), now, String(sourceKind), themeId || null, did, purpose, pid, rt, tc, rok, tp, tcpl, tt]);
  }
}

export async function listThemesWithDialogs() {
  const themes = await adapter.all(
    `SELECT id, title, created_at, updated_at FROM themes
     WHERE id NOT IN (SELECT theme_id FROM dialogs WHERE IFNULL(purpose, '') IN ('intro', 'access', 'rules'))
     ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC`,
  );
  return Promise.all(
    themes.map(async (t) => {
      const dialogs = await adapter.all(
        `SELECT id, theme_id, title, created_at, updated_at FROM dialogs WHERE theme_id = ? ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC`,
        [t.id],
      );
      return {
        id: t.id,
        title: t.title,
        starterDate: rawDbTimestamp(t.created_at),
        lastActionDate: rawDbTimestamp(t.updated_at),
        dialogs: dialogs.map((d) => ({
          id: d.id,
          themeId: d.theme_id,
          title: d.title,
          starterDate: rawDbTimestamp(d.created_at),
          lastActionDate: rawDbTimestamp(d.updated_at),
        })),
      };
    }),
  );
}

export async function listTurns(dialogId) {
  return adapter.all(
    `SELECT id, user_text, user_attachments_json, assistant_text, requested_provider_id, responding_provider_id, request_type, user_message_at, assistant_message_at,
            assistant_favorite, assistant_favorite_markdown
     FROM conversation_turns WHERE dialog_id = ?
     /* AI talks clones reuse the anchor user_message_at; tie-break by reply time, not UUID id. */
     ORDER BY COALESCE(NULLIF(assistant_message_at, ''), user_message_at) ASC, id ASC`,
    [dialogId],
  );
}

export async function listAssistantFavorites() {
  return adapter.all(
    `SELECT
       t.id AS turn_id,
       t.dialog_id,
       d.theme_id AS theme_id,
       t.user_text,
       t.user_attachments_json,
       t.assistant_favorite_markdown,
       t.assistant_message_at,
       d.title AS dialog_title,
       th.title AS theme_title
     FROM conversation_turns t
     JOIN dialogs d ON d.id = t.dialog_id
     JOIN themes th ON th.id = d.theme_id
     WHERE t.assistant_favorite = 1
     ORDER BY datetime(COALESCE(NULLIF(t.assistant_message_at, ''), t.user_message_at)) DESC, t.id DESC`,
  );
}

/** @returns {Promise<null | { error: string, status: number }>} */
export async function updateAssistantTurnFavoriteInDb(turnId, favorite, markdown) {
  const tid = String(turnId ?? "").trim();
  if (!tid) return { error: "turn id required", status: 400 };
  const trow = await adapter.get(`SELECT id FROM conversation_turns WHERE id = ?`, [tid]);
  if (!trow) return { error: "Turn not found", status: 404 };
  if (favorite) {
    await adapter.run(
      `UPDATE conversation_turns SET assistant_favorite = 1, assistant_favorite_markdown = ? WHERE id = ?`,
      [String(markdown ?? ""), tid],
    );
  } else {
    await adapter.run(
      `UPDATE conversation_turns SET assistant_favorite = 0, assistant_favorite_markdown = NULL WHERE id = ?`,
      [tid],
    );
  }
  return null;
}

export async function hasContextTables() {
  const row = await adapter.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='rules'`);
  return Boolean(row);
}

/**
 * Deletes a theme and cascades everything that references it (dialogs, threads, RAG by thread_id).
 * @param {string} themeId
 * @returns {Promise<{ ok: true, deletedThemeId: string } | { error: string, status: number }>}
 */
export async function deleteThemeFromDb(themeId) {
  const id = String(themeId ?? "").trim();
  if (!id) return { error: "themeId required", status: 400 };
  const row = await adapter.get(`SELECT id FROM themes WHERE id = ?`, [id]);
  if (!row) return { error: "Theme not found", status: 404 };
  const dialogs = await adapter.all(`SELECT id FROM dialogs WHERE theme_id = ?`, [id]);
  for (const d of dialogs) {
    await archiveConversationTurnAggregatesForDialog(String(d.id), "theme_dialog", id);
  }
  await adapter.run(`DELETE FROM themes WHERE id = ?`, [id]);
  return { ok: true, deletedThemeId: id };
}

/** @param {string} themeId @param {string} dialogTitle */
export async function createDialogUnderTheme(themeId, dialogTitle) {
  const dialogId = crypto.randomUUID();
  const now = new Date().toISOString();
  await adapter.transaction(async (tx) => {
    await tx.run(`INSERT INTO dialogs (id, theme_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [dialogId, themeId, dialogTitle, now, now]);
    await tx.run(`UPDATE themes SET updated_at = ? WHERE id = ?`, [now, themeId]);
  });
  return adapter.get(`SELECT * FROM dialogs WHERE id = ?`, [dialogId]);
}

/** @param {Record<string, unknown>} dialog */
export function dialogRowToClient(dialog) {
  return {
    id: dialog.id,
    themeId: dialog.theme_id,
    title: dialog.title,
    starterDate: rawDbTimestamp(dialog.created_at),
    lastActionDate: rawDbTimestamp(dialog.updated_at),
  };
}
