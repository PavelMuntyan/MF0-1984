/**
 * Local SQLite API for themes, dialogs, and conversation turns.
 * Default port 35184 (5984 is often CouchDB — avoid clash). Vite proxies /api → this server.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  mergeRollingSummary,
  appendDecisionLogLine,
  shouldUpdateRollingSummary,
} from "../src/contextEngine/rollingSummary.js";
import { extractMemoryItemsFromMessages } from "../src/contextEngine/memoryExtraction.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dbPath = process.env.API_SQLITE_PATH
  ? path.resolve(process.cwd(), process.env.API_SQLITE_PATH)
  : path.join(root, "data", "mf-lab.sqlite");
const schemaPath = path.join(root, "db", "schema.sql");
const migration003 = path.join(root, "db", "migrations", "003_context_engine.sql");
const PORT = Number(process.env.API_PORT || 35184, 10);

function applyContextEngineMigration(database) {
  const row = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='rules'`).get();
  if (row) return;
  if (fs.existsSync(migration003)) {
    database.exec(fs.readFileSync(migration003, "utf8"));
  }
}

/** Избранные ответы ассистента: снимок markdown в assistant_favorite_markdown. */
function applyAssistantFavoriteColumns(database) {
  const cols = database.prepare(`PRAGMA table_info(conversation_turns)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("assistant_favorite")) {
    database.exec(
      `ALTER TABLE conversation_turns ADD COLUMN assistant_favorite INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!names.has("assistant_favorite_markdown")) {
    database.exec(`ALTER TABLE conversation_turns ADD COLUMN assistant_favorite_markdown TEXT`);
  }
}

/** Имена вложений для контекста LLM / RAG (в UI не показывается). */
function applyUserAttachmentsJsonColumn(database) {
  const cols = database.prepare(`PRAGMA table_info(conversation_turns)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("user_attachments_json")) {
    database.exec(`ALTER TABLE conversation_turns ADD COLUMN user_attachments_json TEXT`);
  }
}

function parseTurnUserAttachmentsJson(raw) {
  if (raw == null || String(raw).trim() === "") return [];
  try {
    const j = JSON.parse(String(raw));
    if (!Array.isArray(j)) return [];
    return j
      .filter((x) => x && typeof x === "object")
      .slice(0, 10)
      .map((x) => ({
        name: String(x.name ?? "file").slice(0, 512),
        kind: ["image", "document", "code", "other"].includes(String(x.kind)) ? String(x.kind) : "other",
      }));
  } catch {
    return [];
  }
}

function attachmentHintForModelFromJson(jsonStr) {
  const rows = parseTurnUserAttachmentsJson(jsonStr);
  if (rows.length === 0) return "";
  const names = rows.map((r) => r.name).filter(Boolean);
  if (names.length === 0) return "";
  return `[Attached: ${names.join(", ")}]`;
}

function userTextForContextPipeline(storedUserText, attachmentsJson) {
  const base = String(storedUserText ?? "").trim();
  const hint = attachmentHintForModelFromJson(attachmentsJson);
  if (!hint) return base;
  return base ? `${base}\n\n${hint}` : hint;
}

function ensureDatabase() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new Database(dbPath);
  database.pragma("foreign_keys = ON");
  const ver = database.prepare("PRAGMA user_version").pluck().get();
  if (ver === 0) {
    const sql = fs.readFileSync(schemaPath, "utf8");
    database.exec(sql);
  }
  applyContextEngineMigration(database);
  applyAssistantFavoriteColumns(database);
  applyUserAttachmentsJsonColumn(database);
  return database;
}

const db = ensureDatabase();

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Сырая метка из SQLite для клиента — формат YY-MM-DD HH:MM считается в браузере (локальное время). */
function rawDbTimestamp(value) {
  if (value == null || value === "") return "";
  return String(value);
}

function listThemesWithDialogs() {
  const themes = db
    .prepare(
      `SELECT id, title, created_at, updated_at FROM themes ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC`,
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
       FROM conversation_turns WHERE dialog_id = ? ORDER BY datetime(user_message_at) ASC, id ASC`,
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

function listContextPack(dialogId, userQuery) {
  const drow = db
    .prepare(
      `SELECT d.id, d.title AS dialog_title, t.title AS theme_title
       FROM dialogs d JOIN themes t ON t.id = d.theme_id WHERE d.id = ?`,
    )
    .get(dialogId);
  if (!drow) return null;
  const turns = listTurns(dialogId);
  if (!hasContextTables()) {
    return {
      threadId: dialogId,
      dialogTitle: drow.dialog_title,
      themeTitle: drow.theme_title,
      rules: [],
      memoryItems: [],
      summaries: [],
      threadMessages: [],
      turns,
      userQuery: userQuery || "",
    };
  }
  const rules = db
    .prepare(`SELECT id, rule_type, title, content, priority, tags, is_active FROM rules WHERE is_active = 1`)
    .all();
  const memoryItems = db
    .prepare(
      `SELECT id, scope, thread_id, memory_type, title, content, priority, tags, is_active
       FROM memory_items WHERE is_active = 1 AND (
         scope = 'global'
         OR (scope = 'project' AND (thread_id IS NULL OR thread_id = ?))
         OR (scope = 'thread' AND thread_id = ?)
       )
       ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
    )
    .all(dialogId, dialogId);
  const summaries = db
    .prepare(
      `SELECT id, thread_id, summary_text, summary_type, covered_until_message_id FROM thread_summaries WHERE thread_id = ?`,
    )
    .all(dialogId);
  const threadMessages = db
    .prepare(
      `SELECT id, role, content, created_at FROM thread_messages WHERE thread_id = ? ORDER BY datetime(created_at) ASC, id ASC`,
    )
    .all(dialogId);
  return {
    threadId: dialogId,
    dialogTitle: drow.dialog_title,
    themeTitle: drow.theme_title,
    rules,
    memoryItems,
    summaries,
    threadMessages,
    turns,
    userQuery: userQuery || "",
  };
}

function runAfterTurnPipeline(dialogId, turnId, userText, assistantText, userMessageAt, assistantMessageAt) {
  if (!hasContextTables()) return;
  const now = new Date().toISOString();
  const uid = crypto.randomUUID();
  const aid = crypto.randomUUID();
  const estU = Math.max(1, Math.ceil(String(userText).length / 4));
  const estA = Math.max(0, Math.ceil(String(assistantText ?? "").length / 4));
  db.prepare(
    `INSERT INTO thread_messages (id, thread_id, role, content, created_at, tokens_estimate, embedding, metadata, source_turn_id)
     VALUES (?, ?, 'user', ?, ?, ?, NULL, NULL, ?)`,
  ).run(uid, dialogId, userText, userMessageAt, estU, turnId);
  db.prepare(
    `INSERT INTO thread_messages (id, thread_id, role, content, created_at, tokens_estimate, embedding, metadata, source_turn_id)
     VALUES (?, ?, 'assistant', ?, ?, ?, NULL, NULL, ?)`,
  ).run(aid, dialogId, String(assistantText ?? ""), assistantMessageAt || now, estA, turnId);

  const cnt = db.prepare(`SELECT COUNT(*) AS c FROM thread_messages WHERE thread_id = ?`).get(dialogId).c;
  if (shouldUpdateRollingSummary(cnt)) {
    const rolling = db
      .prepare(`SELECT summary_text FROM thread_summaries WHERE thread_id = ? AND summary_type = 'rolling'`)
      .get(dialogId);
    const nextRolling = mergeRollingSummary(rolling?.summary_text, userText, assistantText || "");
    db.prepare(`DELETE FROM thread_summaries WHERE thread_id = ? AND summary_type = 'rolling'`).run(dialogId);
    db
      .prepare(
        `INSERT INTO thread_summaries (id, thread_id, summary_text, summary_type, covered_until_message_id, created_at, updated_at)
         VALUES (?, ?, ?, 'rolling', ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), dialogId, nextRolling, turnId, now, now);

    const dlog = db
      .prepare(`SELECT summary_text FROM thread_summaries WHERE thread_id = ? AND summary_type = 'decision_log'`)
      .get(dialogId);
    const nextDec = appendDecisionLogLine(dlog?.summary_text, userText, assistantText || "");
    if (nextDec && nextDec !== String(dlog?.summary_text ?? "").trim()) {
      db.prepare(`DELETE FROM thread_summaries WHERE thread_id = ? AND summary_type = 'decision_log'`).run(dialogId);
      db
        .prepare(
          `INSERT INTO thread_summaries (id, thread_id, summary_text, summary_type, covered_until_message_id, created_at, updated_at)
           VALUES (?, ?, ?, 'decision_log', ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), dialogId, nextDec, turnId, now, now);
    }
  }

  const drafts = extractMemoryItemsFromMessages(dialogId, [
    { role: "user", content: userText },
    { role: "assistant", content: String(assistantText ?? "") },
  ]);
  const ins = db.prepare(
    `INSERT INTO memory_items (id, scope, thread_id, memory_type, title, content, priority, tags, source_message_id, created_at, updated_at, embedding, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
  );
  for (const d of drafts) {
    ins.run(
      crypto.randomUUID(),
      d.scope,
      d.thread_id,
      d.memory_type,
      d.title,
      d.content,
      d.priority,
      d.tags ?? "[]",
      turnId,
      now,
      now,
    );
  }
}

/**
 * Удаляет тему и каскадом всё, что на неё ссылается (диалоги, треды, RAG по thread_id).
 * @param {string} themeId
 * @returns {{ ok: true, deletedThemeId: string } | { error: string, status: number }}
 */
function deleteThemeFromDb(themeId) {
  const id = String(themeId ?? "").trim();
  if (!id) return { error: "themeId required", status: 400 };
  const row = db.prepare(`SELECT id FROM themes WHERE id = ?`).get(id);
  if (!row) return { error: "Theme not found", status: 404 };
  db.prepare(`DELETE FROM themes WHERE id = ?`).run(id);
  return { ok: true, deletedThemeId: id };
}

function normalizePathname(pathname) {
  const s = String(pathname || "/");
  const collapsed = s.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) return collapsed.slice(0, -1);
  return collapsed;
}

/**
 * Прокси (Apache и т.д.) часто передаёт pathname вида /mf-lab/api/... — роутер ждёт /api/...
 * Опционально: API_PATH_PREFIX=/mf-lab чтобы снять один сегмент с начала.
 */
function canonicalApiPath(pathname) {
  const normalized = normalizePathname(pathname);
  const envPre = process.env.API_PATH_PREFIX
    ? normalizePathname(process.env.API_PATH_PREFIX)
    : "";
  let p = normalized;
  if (envPre && (p === envPre || p.startsWith(`${envPre}/`))) {
    p = p.slice(envPre.length) || "/";
    if (!p.startsWith("/")) p = `/${p}`;
  }
  const idx = p.indexOf("/api/");
  if (idx > 0) {
    p = p.slice(idx);
  }
  while (p.includes("/api/api/")) {
    p = p.replace("/api/api/", "/api/");
  }
  return normalizePathname(p);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const rawPath = normalizePathname(url.pathname);
  const p = canonicalApiPath(url.pathname);

  try {
    if (req.method === "GET" && p === "/api/health") {
      return json(res, 200, { ok: true, mfLabApi: true, port: PORT });
    }

    if (
      req.method === "GET" &&
      (p === "/api/assistant-favorites" || p === "/api/dialogs/assistant-favorites")
    ) {
      const rows = listAssistantFavorites();
      const favorites = rows.map((r) => {
        const line = String(r.user_text ?? "")
          .trim()
          .split(/\r?\n/)
          .find((x) => x.trim().length > 0)
          ?.trim();
        const fromFiles = parseTurnUserAttachmentsJson(r.user_attachments_json)
          .map((x) => x.name)
          .filter(Boolean)
          .join(", ");
        const userPreview = (line && line.slice(0, 120)) || (fromFiles && fromFiles.slice(0, 120)) || "";
        return {
          turnId: r.turn_id,
          dialogId: r.dialog_id,
          themeId: r.theme_id,
          themeTitle: r.theme_title,
          dialogTitle: r.dialog_title,
          userPreview,
          markdown: r.assistant_favorite_markdown ?? "",
          assistantMessageAt: rawDbTimestamp(r.assistant_message_at),
        };
      });
      return json(res, 200, { favorites });
    }

    /** Избранное: короткий путь + вариант под /api/dialogs/ (дубли /api/api/ снимает canonicalApiPath). */
    if (
      req.method === "POST" &&
      (p === "/api/assistant-favorite" || p === "/api/dialogs/assistant-favorite")
    ) {
      const body = await readBody(req);
      const turnId = String(body.turnId ?? body.turn_id ?? "").trim();
      const favorite = Boolean(body.favorite);
      const markdown = body.markdown != null ? String(body.markdown) : "";
      const errOut = updateAssistantTurnFavoriteInDb(turnId, favorite, markdown);
      if (errOut) return json(res, errOut.status, { error: errOut.error });
      return json(res, 200, { ok: true });
    }

    const turnFavoriteMatch = p.match(/^\/api\/turns\/([^/]+)\/favorite$/);
    if (req.method === "POST" && turnFavoriteMatch) {
      const turnId = decodeURIComponent(turnFavoriteMatch[1]).trim();
      const body = await readBody(req);
      const favorite = Boolean(body.favorite);
      const markdown = body.markdown != null ? String(body.markdown) : "";
      const errOut = updateAssistantTurnFavoriteInDb(turnId, favorite, markdown);
      if (errOut) return json(res, errOut.status, { error: errOut.error });
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && p === "/api/themes") {
      return json(res, 200, { themes: listThemesWithDialogs() });
    }

    /**
     * Удаление темы: каскадом из БД уходят все dialogs этой темы, conversation_turns,
     * а также RAG-слой по тредам — thread_messages (в т.ч. embedding), thread_summaries,
     * memory_items с привязкой thread_id к этим диалогам. Глобальные rules и прочее без FK на тему не трогаем.
     *
     * POST — основной путь для UI (как /api/themes/new-dialog): часть прокси/старых процессов API
     * отвечает 404 на DELETE без актуального кода. DELETE оставлен для совместимости.
     */
    if (req.method === "POST" && (p === "/api/themes/delete" || p === "/api/theme-delete")) {
      const body = await readBody(req);
      const themeId = String(body.themeId ?? body.theme_id ?? "").trim();
      const out = deleteThemeFromDb(themeId);
      if (out.error) return json(res, out.status, { error: out.error });
      console.log(`[mf-lab-api] theme deleted: ${out.deletedThemeId}`);
      return json(res, 200, out);
    }

    const themeDeleteMatch = p.match(/^\/api\/themes\/([^/]+)$/);
    if (req.method === "DELETE" && themeDeleteMatch) {
      const themeId = decodeURIComponent(themeDeleteMatch[1]).trim();
      const out = deleteThemeFromDb(themeId);
      if (out.error) return json(res, out.status, { error: out.error });
      console.log(`[mf-lab-api] theme deleted (DELETE): ${out.deletedThemeId}`);
      return json(res, 200, out);
    }

    if (req.method === "POST" && (p === "/api/themes/rename" || p === "/api/theme-rename")) {
      const body = await readBody(req);
      const themeId = String(body.themeId ?? body.theme_id ?? "").trim();
      const title = String(body.title ?? "").trim();
      if (!themeId) return json(res, 400, { error: "themeId required" });
      if (!title) return json(res, 400, { error: "title required" });
      const row = db.prepare(`SELECT id FROM themes WHERE id = ?`).get(themeId);
      if (!row) return json(res, 404, { error: "Theme not found" });
      const now = new Date().toISOString();
      db.prepare(`UPDATE themes SET title = ?, updated_at = ? WHERE id = ?`).run(title, now, themeId);
      return json(res, 200, { ok: true, themeId, title });
    }

    if (req.method === "GET" && p.startsWith("/api/dialogs/") && p.endsWith("/turns")) {
      const dialogId = decodeURIComponent(p.slice("/api/dialogs/".length, -"/turns".length));
      if (!dialogId) return json(res, 400, { error: "Missing dialog id" });
      const row = db.prepare(`SELECT id FROM dialogs WHERE id = ?`).get(dialogId);
      if (!row) return json(res, 404, { error: "Dialog not found" });
      return json(res, 200, { turns: listTurns(dialogId) });
    }

    const contextPackMatch = p.match(/^\/api\/dialogs\/([^/]+)\/context-pack$/);
    if (req.method === "GET" && contextPackMatch) {
      const dialogId = decodeURIComponent(contextPackMatch[1]);
      if (!dialogId) return json(res, 400, { error: "Missing dialog id" });
      const q = url.searchParams.get("q") ?? url.searchParams.get("userQuery") ?? "";
      const pack = listContextPack(dialogId, String(q));
      if (!pack) return json(res, 404, { error: "Dialog not found" });
      return json(res, 200, pack);
    }

    if (req.method === "POST" && p === "/api/themes/bootstrap") {
      const body = await readBody(req);
      const title = String(body.title ?? "").trim() || "New conversation";
      const themeId = crypto.randomUUID();
      const dialogId = crypto.randomUUID();
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        db.prepare(`INSERT INTO themes (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
          themeId,
          title,
          now,
          now,
        );
        db.prepare(`INSERT INTO dialogs (id, theme_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
          dialogId,
          themeId,
          title,
          now,
          now,
        );
      });
      tx();
      const theme = db.prepare(`SELECT * FROM themes WHERE id = ?`).get(themeId);
      const dialog = db.prepare(`SELECT * FROM dialogs WHERE id = ?`).get(dialogId);
      return json(res, 201, {
        theme: {
          id: theme.id,
          title: theme.title,
          starterDate: rawDbTimestamp(theme.created_at),
          lastActionDate: rawDbTimestamp(theme.updated_at),
        },
        dialog: {
          id: dialog.id,
          themeId: dialog.theme_id,
          title: dialog.title,
          starterDate: rawDbTimestamp(dialog.created_at),
          lastActionDate: rawDbTimestamp(dialog.updated_at),
        },
      });
    }

    /** Плоский путь — как /api/themes/bootstrap; надёжнее при прокси и без UUID в сегменте URL. */
    if (req.method === "POST" && p === "/api/themes/new-dialog") {
      const body = await readBody(req);
      const themeId = String(body.themeId ?? body.theme_id ?? "").trim();
      if (!themeId) return json(res, 400, { error: "themeId required" });
      const trow = db.prepare(`SELECT id FROM themes WHERE id = ?`).get(themeId);
      if (!trow) return json(res, 404, { error: "Theme not found" });
      const title = String(body.title ?? "").trim() || "New conversation";
      const dialogId = crypto.randomUUID();
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        db.prepare(`INSERT INTO dialogs (id, theme_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
          dialogId,
          themeId,
          title,
          now,
          now,
        );
        db.prepare(`UPDATE themes SET updated_at = ? WHERE id = ?`).run(now, themeId);
      });
      tx();
      const dialog = db.prepare(`SELECT * FROM dialogs WHERE id = ?`).get(dialogId);
      return json(res, 201, {
        dialog: {
          id: dialog.id,
          themeId: dialog.theme_id,
          title: dialog.title,
          starterDate: rawDbTimestamp(dialog.created_at),
          lastActionDate: rawDbTimestamp(dialog.updated_at),
        },
      });
    }

    const themeDialogsPost = p.match(/^\/api\/themes\/([^/]+)\/dialogs$/);
    if (req.method === "POST" && themeDialogsPost) {
      const themeId = decodeURIComponent(themeDialogsPost[1]);
      if (!themeId.trim()) return json(res, 400, { error: "themeId required" });
      const trow = db.prepare(`SELECT id FROM themes WHERE id = ?`).get(themeId);
      if (!trow) return json(res, 404, { error: "Theme not found" });
      const body = await readBody(req);
      const title = String(body.title ?? "").trim() || "New conversation";
      const dialogId = crypto.randomUUID();
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        db.prepare(`INSERT INTO dialogs (id, theme_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
          dialogId,
          themeId,
          title,
          now,
          now,
        );
        db.prepare(`UPDATE themes SET updated_at = ? WHERE id = ?`).run(now, themeId);
      });
      tx();
      const dialog = db.prepare(`SELECT * FROM dialogs WHERE id = ?`).get(dialogId);
      return json(res, 201, {
        dialog: {
          id: dialog.id,
          themeId: dialog.theme_id,
          title: dialog.title,
          starterDate: rawDbTimestamp(dialog.created_at),
          lastActionDate: rawDbTimestamp(dialog.updated_at),
        },
      });
    }

    if (req.method === "POST" && p.startsWith("/api/dialogs/") && p.endsWith("/turns")) {
      const dialogId = decodeURIComponent(p.slice("/api/dialogs/".length, -"/turns".length));
      if (!dialogId) return json(res, 400, { error: "Missing dialog id" });
      const drow = db.prepare(`SELECT id, theme_id FROM dialogs WHERE id = ?`).get(dialogId);
      if (!drow) return json(res, 404, { error: "Dialog not found" });

      const body = await readBody(req);
      const turnId = crypto.randomUUID();
      const userText = String(body.user_text ?? "");
      const userAttachmentsJson =
        body.user_attachments_json != null ? String(body.user_attachments_json) : "";
      const assistantText = body.assistant_text != null ? String(body.assistant_text) : null;
      const requestedProviderId = String(body.requested_provider_id ?? "");
      const respondingProviderId =
        body.responding_provider_id != null ? String(body.responding_provider_id) : null;
      const requestType = String(body.request_type ?? "default");
      const userMessageAt = String(body.user_message_at ?? "");
      const assistantMessageAt =
        body.assistant_message_at != null ? String(body.assistant_message_at) : null;

      const attachRows = parseTurnUserAttachmentsJson(userAttachmentsJson);
      const hasUserChars = String(userText).trim().length > 0;
      const hasAttach = attachRows.length > 0;
      if ((!hasUserChars && !hasAttach) || !requestedProviderId || !userMessageAt) {
        return json(res, 400, {
          error: "user_text (or attachments), requested_provider_id, user_message_at required",
        });
      }

      const attachJsonToStore = hasAttach ? JSON.stringify(attachRows) : null;
      const pipelineUserText = userTextForContextPipeline(userText, attachJsonToStore);

      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO conversation_turns (
            id, dialog_id, user_text, user_attachments_json, assistant_text, requested_provider_id, responding_provider_id,
            request_type, user_message_at, assistant_message_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          turnId,
          dialogId,
          userText,
          attachJsonToStore,
          assistantText,
          requestedProviderId,
          respondingProviderId,
          requestType,
          userMessageAt,
          assistantMessageAt,
        );
        db.prepare(`UPDATE dialogs SET updated_at = ? WHERE id = ?`).run(now, dialogId);
        db.prepare(`UPDATE themes SET updated_at = ? WHERE id = ?`).run(now, drow.theme_id);
      });
      tx();
      try {
        runAfterTurnPipeline(
          dialogId,
          turnId,
          pipelineUserText,
          assistantText,
          userMessageAt,
          assistantMessageAt || now,
        );
      } catch (e) {
        console.error("context pipeline after turn:", e);
      }
      return json(res, 201, { id: turnId });
    }

    if (req.method === "POST" && rawPath.includes("theme") && rawPath.includes("delete")) {
      console.warn(`[mf-lab-api] 404 POST delete-theme: canonical=${JSON.stringify(p)} raw=${JSON.stringify(rawPath)}`);
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`MF0-1984 API http://127.0.0.1:${PORT}/ (SQLite: ${dbPath})`);
  if (process.env.API_PATH_PREFIX) {
    console.log(`[mf-lab-api] API_PATH_PREFIX=${process.env.API_PATH_PREFIX}`);
  }
});
