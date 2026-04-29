/**
 * Theme / dialog / turn DB queries and write helpers.
 * Depends on db from migrations.mjs and node:crypto — no HTTP layer.
 */
import crypto from "node:crypto";
import { db } from "../db/migrations.mjs";

/** Raw timestamp string from SQLite for the client — YY-MM-DD HH:MM is interpreted in the browser (local time). */
function rawDbTimestamp(value) {
  if (value == null || value === "") return "";
  return String(value);
}

/**
 * Inserts normalized analytics_usage_archive rows (one per provider × request_type) for current turns.
 * @param {string} dialogId
 * @param {'ir_thread_cleared' | 'theme_dialog'} sourceKind
 * @param {string | null} [themeIdOverride] — for theme delete, pass theme id so it survives dialog cascade
 */
function archiveConversationTurnAggregatesForDialog(dialogId, sourceKind, themeIdOverride = null) {
  const did = String(dialogId ?? "").trim();
  if (!did) return;
  const drow = db.prepare(`SELECT id, theme_id, IFNULL(purpose, '') AS purpose FROM dialogs WHERE id = ?`).get(did);
  if (!drow) return;
  const themeId =
    themeIdOverride != null && String(themeIdOverride).trim()
      ? String(themeIdOverride).trim()
      : String(drow.theme_id ?? "").trim();
  const purpose = String(drow.purpose ?? "").trim();
  const now = new Date().toISOString();
  const groups = db
    .prepare(
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
    )
    .all(did);
  const ins = db.prepare(
    `INSERT INTO analytics_usage_archive (id, archived_at, source_kind, theme_id, dialog_id, dialog_purpose, provider_id, request_type, turn_count, responses_ok, tokens_prompt, tokens_completion, tokens_total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const g of groups) {
    const pid = String(g.pid ?? "").trim();
    const rt = String(g.request_type ?? "default").trim() || "default";
    const tc = Number(g.turn_count) || 0;
    const rok = Number(g.responses_ok) || 0;
    const tp = Number(g.tokens_prompt) || 0;
    const tcpl = Number(g.tokens_completion) || 0;
    const tt = Number(g.tokens_total) || 0;
    if (!pid || tc <= 0) continue;
    ins.run(
      crypto.randomUUID(),
      now,
      String(sourceKind),
      themeId || null,
      did,
      purpose,
      pid,
      rt,
      tc,
      rok,
      tp,
      tcpl,
      tt,
    );
  }
}

function listThemesWithDialogs() {
  /** Hide Intro / Access service themes — those panels open from their own controls, not the theme list. */
  const themes = db
    .prepare(
      `SELECT id, title, created_at, updated_at FROM themes
       WHERE id NOT IN (SELECT theme_id FROM dialogs WHERE IFNULL(purpose, '') IN ('intro', 'access', 'rules'))
       ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC`,
    )
    .all();
  const dialogsStmt = db.prepare(
    `SELECT id, theme_id, title, created_at, updated_at FROM dialogs WHERE theme_id = ? ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC`,
  );
  return themes.map((t) => {
    const dialogs = dialogsStmt.all(t.id);
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
  });
}

function listTurns(dialogId) {
  return db
    .prepare(
      `SELECT id, user_text, user_attachments_json, assistant_text, requested_provider_id, responding_provider_id, request_type, user_message_at, assistant_message_at,
              assistant_favorite, assistant_favorite_markdown
       FROM conversation_turns WHERE dialog_id = ?
       /* AI talks clones reuse the anchor user_message_at; tie-break by reply time, not UUID id. */
       ORDER BY COALESCE(NULLIF(assistant_message_at, ''), user_message_at) ASC, id ASC`,
    )
    .all(dialogId);
}

function listAssistantFavorites() {
  return db
    .prepare(
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
    )
    .all();
}

/** @returns {null | { error: string, status: number }} */
function updateAssistantTurnFavoriteInDb(turnId, favorite, markdown) {
  const tid = String(turnId ?? "").trim();
  if (!tid) return { error: "turn id required", status: 400 };
  const trow = db.prepare(`SELECT id FROM conversation_turns WHERE id = ?`).get(tid);
  if (!trow) return { error: "Turn not found", status: 404 };
  if (favorite) {
    db.prepare(
      `UPDATE conversation_turns SET assistant_favorite = 1, assistant_favorite_markdown = ? WHERE id = ?`,
    ).run(String(markdown ?? ""), tid);
  } else {
    db.prepare(
      `UPDATE conversation_turns SET assistant_favorite = 0, assistant_favorite_markdown = NULL WHERE id = ?`,
    ).run(tid);
  }
  return null;
}

function hasContextTables() {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='rules'`).get(),
  );
}

/**
 * Deletes a theme and cascades everything that references it (dialogs, threads, RAG by thread_id).
 * @param {string} themeId
 * @returns {{ ok: true, deletedThemeId: string } | { error: string, status: number }}
 */
function deleteThemeFromDb(themeId) {
  const id = String(themeId ?? "").trim();
  if (!id) return { error: "themeId required", status: 400 };
  const row = db.prepare(`SELECT id FROM themes WHERE id = ?`).get(id);
  if (!row) return { error: "Theme not found", status: 404 };
  const dialogs = db.prepare(`SELECT id FROM dialogs WHERE theme_id = ?`).all(id);
  for (const d of dialogs) {
    archiveConversationTurnAggregatesForDialog(String(d.id), "theme_dialog", id);
  }
  db.prepare(`DELETE FROM themes WHERE id = ?`).run(id);
  return { ok: true, deletedThemeId: id };
}

/** @param {string} themeId @param {string} dialogTitle */
function createDialogUnderTheme(themeId, dialogTitle) {
  const dialogId = crypto.randomUUID();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO dialogs (id, theme_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
      dialogId,
      themeId,
      dialogTitle,
      now,
      now,
    );
    db.prepare(`UPDATE themes SET updated_at = ? WHERE id = ?`).run(now, themeId);
  });
  tx();
  return db.prepare(`SELECT * FROM dialogs WHERE id = ?`).get(dialogId);
}

/** @param {Record<string, unknown>} dialog */
function dialogRowToClient(dialog) {
  return {
    id: dialog.id,
    themeId: dialog.theme_id,
    title: dialog.title,
    starterDate: rawDbTimestamp(dialog.created_at),
    lastActionDate: rawDbTimestamp(dialog.updated_at),
  };
}

export {
  rawDbTimestamp,
  archiveConversationTurnAggregatesForDialog,
  listThemesWithDialogs,
  listTurns,
  listAssistantFavorites,
  updateAssistantTurnFavoriteInDb,
  hasContextTables,
  deleteThemeFromDb,
  createDialogUnderTheme,
  dialogRowToClient,
};
