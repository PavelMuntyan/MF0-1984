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
const migration004 = path.join(root, "db", "migrations", "004_memory_graph.sql");
const migration005 = path.join(root, "db", "migrations", "005_assistant_error.sql");
const migration006 = path.join(root, "db", "migrations", "006_intro_pin_lock.sql");
const migration007 = path.join(root, "db", "migrations", "007_ir_panel_pin_lock.sql");
const migration008 = path.join(root, "db", "migrations", "008_access_external_services.sql");
const PORT = Number(process.env.API_PORT || 35184, 10);

/** Max length for Access `notes` field (DB + JSON import). */
const ACCESS_ENTRY_NOTES_MAX = 12000;

const ANALYTICS_PROVIDER_IDS = ["openai", "perplexity", "gemini-flash", "anthropic"];

function applyContextEngineMigration(database) {
  const row = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='rules'`).get();
  if (row) return;
  if (fs.existsSync(migration003)) {
    database.exec(fs.readFileSync(migration003, "utf8"));
  }
}

/** Assistant favorites: markdown snapshot in assistant_favorite_markdown. */
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

/** Attachment names for LLM / RAG context (not shown in UI). */
function applyUserAttachmentsJsonColumn(database) {
  const cols = database.prepare(`PRAGMA table_info(conversation_turns)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("user_attachments_json")) {
    database.exec(`ALTER TABLE conversation_turns ADD COLUMN user_attachments_json TEXT`);
  }
}

function applyDialogsPurposeColumn(database) {
  const cols = database.prepare(`PRAGMA table_info(dialogs)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("purpose")) {
    database.exec(`ALTER TABLE dialogs ADD COLUMN purpose TEXT`);
  }
}

function applyMemoryGraphMigration(database) {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_graph_nodes'`)
    .get();
  if (row) return;
  if (fs.existsSync(migration004)) {
    database.exec(fs.readFileSync(migration004, "utf8"));
  }
}

function applyAssistantErrorColumn(database) {
  const cols = database.prepare(`PRAGMA table_info(conversation_turns)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("assistant_error")) {
    if (fs.existsSync(migration005)) {
      database.exec(fs.readFileSync(migration005, "utf8"));
    } else {
      database.exec(`ALTER TABLE conversation_turns ADD COLUMN assistant_error INTEGER NOT NULL DEFAULT 0`);
    }
  }
}

function applyIntroPinLockMigration(database) {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='intro_pin_lock'`)
    .get();
  if (row) return;
  if (fs.existsSync(migration006)) {
    database.exec(fs.readFileSync(migration006, "utf8"));
  }
}

/** Intro / Rules / Access — one PIN row per panel (`ir_panel_pin_lock`). Migrates legacy `intro_pin_lock`. */
function applyIrPanelPinLockMigration(database) {
  const hasIr = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ir_panel_pin_lock'`)
    .get();
  if (hasIr) return;
  applyIntroPinLockMigration(database);
  if (!fs.existsSync(migration007)) {
    throw new Error("Missing migration 007_ir_panel_pin_lock.sql");
  }
  database.exec(fs.readFileSync(migration007, "utf8"));
  const legacy = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='intro_pin_lock'`)
    .get();
  if (legacy) {
    const row = database.prepare(`SELECT pin_double_hash FROM intro_pin_lock WHERE singleton = 1`).get();
    if (row?.pin_double_hash) {
      database
        .prepare(`INSERT OR REPLACE INTO ir_panel_pin_lock (panel, pin_double_hash) VALUES ('intro', ?)`)
        .run(row.pin_double_hash);
    }
    database.exec(`DROP TABLE intro_pin_lock`);
  }
}

function applyAccessExternalServicesMigration(database) {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='access_external_services'`)
    .get();
  if (row) return;
  if (!fs.existsSync(migration008)) {
    throw new Error("Missing migration 008_access_external_services.sql");
  }
  database.exec(fs.readFileSync(migration008, "utf8"));
}

/**
 * One-time: import legacy JSON into SQLite when the table is empty, then remove the file.
 * @param {import("better-sqlite3").Database} database
 */
function migrateAccessExternalServicesFromJsonIfNeeded(database) {
  const accessExternalServicesPath = path.join(root, "data", "access-external-services.json");
  const n = database.prepare(`SELECT COUNT(*) AS c FROM access_external_services`).get();
  const count = Number(n?.c ?? 0);
  if (count > 0) return;
  if (!fs.existsSync(accessExternalServicesPath)) return;
  let raw;
  try {
    raw = fs.readFileSync(accessExternalServicesPath, "utf8");
  } catch {
    return;
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    console.warn("[mf-lab-api] access-external-services.json: invalid JSON, skipping migration");
    return;
  }
  const entries = sanitizeAccessExternalEntries(j.entries);
  if (entries.length === 0) {
    try {
      fs.unlinkSync(accessExternalServicesPath);
    } catch {
      /* ignore */
    }
    return;
  }
  const ins = database.prepare(
    `INSERT INTO access_external_services (id, name, description, endpoint_url, access_key, notes, updated_at)
     VALUES (@id, @name, @description, @endpointUrl, @accessKey, @notes, @updatedAt)`,
  );
  const tx = database.transaction((rows) => {
    for (const e of rows) {
      ins.run({
        id: e.id,
        name: e.name,
        description: e.description,
        endpointUrl: e.endpointUrl,
        accessKey: e.accessKey,
        notes: e.notes,
        updatedAt: e.updatedAt,
      });
    }
  });
  tx(entries);
  try {
    fs.unlinkSync(accessExternalServicesPath);
    console.log(
      "[mf-lab-api] Migrated access-external-services.json → access_external_services table; legacy file removed.",
    );
  } catch (e) {
    console.warn(
      "[mf-lab-api] Migrated access JSON to DB but could not remove file:",
      e instanceof Error ? e.message : String(e),
    );
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
  applyDialogsPurposeColumn(database);
  applyMemoryGraphMigration(database);
  applyAssistantErrorColumn(database);
  applyIrPanelPinLockMigration(database);
  applyAccessExternalServicesMigration(database);
  migrateAccessExternalServicesFromJsonIfNeeded(database);
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

/** Raw timestamp string from SQLite for the client — YY-MM-DD HH:MM is interpreted in the browser (local time). */
function rawDbTimestamp(value) {
  if (value == null || value === "") return "";
  return String(value);
}

function sanitizeAccessExternalEntries(entries) {
  const now = new Date().toISOString();
  /** @type {Array<{ id: string, name: string, description: string, endpointUrl: string, accessKey: string, notes: string, updatedAt: string }>} */
  const out = [];
  const arr = Array.isArray(entries) ? entries : [];
  for (const e of arr.slice(0, 200)) {
    if (!e || typeof e !== "object") continue;
    const id = String(e.id ?? "").trim() || crypto.randomUUID();
    const name = String(e.name ?? "").trim().slice(0, 200);
    if (!name) continue;
    out.push({
      id,
      name,
      description: String(e.description ?? "").trim().slice(0, 2000),
      endpointUrl: String(e.endpointUrl ?? e.endpoint_or_url ?? "").trim().slice(0, 2000),
      accessKey: String(e.accessKey ?? e.access_key ?? "").trim().slice(0, 2000),
      notes: String(e.notes ?? "").trim().slice(0, ACCESS_ENTRY_NOTES_MAX),
      updatedAt: String(e.updatedAt ?? e.updated_at ?? now).slice(0, 40),
    });
  }
  return out;
}

function readAccessExternalServicesPayload() {
  const rows = db
    .prepare(
      `SELECT id, name, description, endpoint_url AS endpointUrl, access_key AS accessKey, notes, updated_at AS updatedAt
       FROM access_external_services ORDER BY name COLLATE NOCASE`,
    )
    .all();
  /** @type {Array<{ id: string, name: string, description: string, endpointUrl: string, accessKey: string, notes: string, updatedAt: string }>} */
  const entries = (rows ?? []).map((r) => ({
    id: String(r.id ?? "").trim(),
    name: String(r.name ?? "").trim(),
    description: String(r.description ?? "").trim(),
    endpointUrl: String(r.endpointUrl ?? "").trim(),
    accessKey: String(r.accessKey ?? "").trim(),
    notes: String(r.notes ?? "").trim(),
    updatedAt: String(r.updatedAt ?? "").trim(),
  }));
  return { entries: sanitizeAccessExternalEntries(entries) };
}

/**
 * #data / Access data: optional live JSON GET for each row’s `endpointUrl`.
 * - **Always:** host must be the same as that row’s URL hostname **or** match optional global suffix rules (env).
 * - **Optional:** `ACCESS_DATA_DUMP_ALLOW_HOST_SUFFIXES` — comma-separated host suffixes (e.g. CDN parents) in addition to self-host.
 * No per-vendor URLs are hardcoded in code.
 */
function getAccessDataDumpAllowHostSuffixes() {
  const raw = String(process.env.ACCESS_DATA_DUMP_ALLOW_HOST_SUFFIXES ?? "").trim();
  if (!raw) return [];
  return raw
    .split(/[,;]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\.+/, ""))
    .filter((s) => s.length > 1 && /^[a-z0-9.-]+$/.test(s));
}

/** Hostname from this row’s stored URL (lowercase), or empty if invalid. */
function rowEndpointHostname(entry) {
  try {
    return new URL(String(entry?.endpointUrl ?? "").trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Live GET allowed for this row if public HTTPS host matches **this row’s** endpoint hostname,
 * or matches any configured global suffix (parent/CDN domains).
 * @param {string} hostname
 * @param {{ endpointUrl?: string }} entry
 */
function hostnameAllowedForDataDumpRow(hostname, entry) {
  const h = String(hostname ?? "").toLowerCase();
  const self = rowEndpointHostname(entry);
  if (self && h === self) return true;
  const host = h.replace(/\.$/, "");
  for (const suf of getAccessDataDumpAllowHostSuffixes()) {
    if (host === suf || host.endsWith("." + suf)) return true;
  }
  return false;
}

function isSafePublicHttpsUrlForDataDump(urlStr) {
  try {
    const u = new URL(String(urlStr ?? "").trim());
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (!h || h === "localhost" || h === "[::1]") return false;
    if (h.endsWith(".local")) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(h)) return false;
    const ipv4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4) {
      const a = Number(ipv4[1]);
      const b = Number(ipv4[2]);
      if (a === 0 || a === 127) return false;
      if (a === 10) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Generic JSON trim for LLM context (no product-specific field lists).
 * @param {unknown} value
 * @param {number} depth
 * @param {WeakSet<object>} seen
 */
function genericPruneJsonForDataDump(value, depth = 0, seen = new WeakSet()) {
  const maxDepth = 7;
  const maxStr = 1800;
  const maxKeys = 72;
  const maxArr = 48;
  if (depth > maxDepth) return "[truncated-depth]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length > maxStr ? `${value.slice(0, maxStr)}…` : value;
  }
  if (typeof value !== "object") return value;
  if (seen.has(/** @type {object} */ (value))) return "[circular]";
  seen.add(/** @type {object} */ (value));
  if (Array.isArray(value)) {
    const out = value.slice(0, maxArr).map((x) => genericPruneJsonForDataDump(x, depth + 1, seen));
    if (value.length > maxArr) out.push(`[…+${value.length - maxArr} items]`);
    return out;
  }
  const o = /** @type {Record<string, unknown>} */ ({});
  const keys = Object.keys(value).slice(0, maxKeys);
  for (const k of keys) {
    o[k] = genericPruneJsonForDataDump(value[k], depth + 1, seen);
  }
  if (Object.keys(value).length > maxKeys) o._truncatedKeys = true;
  return o;
}

/**
 * @param {{ id?: string, name?: string, endpointUrl?: string }} entry
 */
async function fetchSafeAllowlistedJsonSnapshotForEntry(entry) {
  const url = String(entry?.endpointUrl ?? "").trim();
  if (!url) return { skipped: true, reason: "no endpointUrl" };
  if (!isSafePublicHttpsUrlForDataDump(url)) {
    return { skipped: true, reason: "only public HTTPS URLs (non-loopback) are allowed" };
  }
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return { skipped: true, reason: "invalid URL" };
  }
  if (!hostnameAllowedForDataDumpRow(hostname, entry)) {
    return {
      skipped: true,
      reason:
        "hostname does not match this row’s endpointUrl host and does not match ACCESS_DATA_DUMP_ALLOW_HOST_SUFFIXES",
    };
  }
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 9000);
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "MF0-1984-local-api/data-dump",
      },
    });
    clearTimeout(tid);
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, error: text.slice(0, 500) };
    }
    if (text.length > 1_200_000) {
      return { ok: false, error: "response body too large" };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, httpStatus: res.status, error: "non-JSON body", snippet: text.slice(0, 400) };
    }
    const pruned = genericPruneJsonForDataDump(parsed);
    return {
      ok: true,
      httpStatus: res.status,
      fetchedAt: new Date().toISOString(),
      body: pruned,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function getAccessDataDumpMaxLiveFetches() {
  const n = Number(process.env.ACCESS_DATA_DUMP_MAX_LIVE_FETCHES);
  if (Number.isFinite(n) && n >= 1 && n <= 120) return Math.floor(n);
  return 48;
}

/**
 * Prefer likely air-quality rows first so a small fetch budget still hits relevant JSON APIs.
 * @param {Array<{ name?: string, endpointUrl?: string }>} list
 */
function sortEntriesForDataDumpFetchPriority(list) {
  /** @param {{ name?: string, endpointUrl?: string }} e */
  const score = (e) => {
    const u = String(e?.endpointUrl ?? "").toLowerCase();
    const n = String(e?.name ?? "").toLowerCase();
    const h = `${u} ${n}`;
    let p = 0;
    if (/air-quality|airquality|aqi|pm2|pm10|pollution|smog|чистот|воздух|качеств/i.test(h)) p += 8;
    if (/marine|wave|морск/i.test(h)) p += 2;
    if (/forecast|current_weather|погод|weather/i.test(h)) p += 1;
    return p;
  };
  return [...list].sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    return String(a?.name ?? "").localeCompare(String(b?.name ?? ""), "und", { sensitivity: "base" });
  });
}

async function getAccessDataDumpEnrichmentPayload() {
  const { entries: entriesRaw } = readAccessExternalServicesPayload();
  const entries = sortEntriesForDataDumpFetchPriority(entriesRaw);
  /** @type {unknown[]} */
  const snapshots = [];
  let fetchCount = 0;
  const suffixes = getAccessDataDumpAllowHostSuffixes();
  const maxFetches = getAccessDataDumpMaxLiveFetches();
  for (const e of entries) {
    const url = String(e?.endpointUrl ?? "").trim();
    if (!url) {
      snapshots.push({
        entryId: e.id,
        entryName: e.name,
        skipped: true,
        reason: "no endpointUrl",
      });
      continue;
    }
    if (!isSafePublicHttpsUrlForDataDump(url)) {
      snapshots.push({
        entryId: e.id,
        entryName: e.name,
        endpointUrl: url,
        skipped: true,
        reason: "only public HTTPS URLs are considered for live fetch",
      });
      continue;
    }
    let hostname = "";
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      snapshots.push({
        entryId: e.id,
        entryName: e.name,
        endpointUrl: url,
        skipped: true,
        reason: "invalid URL",
      });
      continue;
    }
    if (!hostnameAllowedForDataDumpRow(hostname, e)) {
      snapshots.push({
        entryId: e.id,
        entryName: e.name,
        endpointUrl: url,
        skipped: true,
        reason:
          "hostname not allowed for live fetch (must match this row’s endpointUrl host, or a suffix from ACCESS_DATA_DUMP_ALLOW_HOST_SUFFIXES)",
      });
      continue;
    }
    if (fetchCount >= maxFetches) {
      snapshots.push({
        entryId: e.id,
        entryName: e.name,
        endpointUrl: url,
        skipped: true,
        reason: `not fetched this round — server snapshot budget (${maxFetches} GETs per request; set ACCESS_DATA_DUMP_MAX_LIVE_FETCHES up to 120 to raise)`,
      });
      continue;
    }
    fetchCount += 1;
    const snap = await fetchSafeAllowlistedJsonSnapshotForEntry(e);
    snapshots.push({
      entryId: e.id,
      entryName: e.name,
      endpointUrl: url,
      ...snap,
    });
  }
  return {
    ok: true,
    entries,
    snapshots,
    meta: {
      globalHostSuffixRuleCount: suffixes.length,
      rowSelfHostnameFetch: true,
      maxLiveFetches: maxFetches,
      entryRowCount: entries.length,
    },
  };
}

/** Prompt-safe catalog: names, descriptions, URLs only — never credentials. */
function readAccessExternalServicesCatalogPayload() {
  const { entries } = readAccessExternalServicesPayload();
  return {
    entries: entries.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      endpointUrl: e.endpointUrl,
      /* notes omitted from catalog — may echo secrets; full store still has them */
    })),
  };
}

function writeAccessExternalServicesPayload(body) {
  const entries = sanitizeAccessExternalEntries(body?.entries);
  const del = db.prepare(`DELETE FROM access_external_services`);
  const ins = db.prepare(
    `INSERT INTO access_external_services (id, name, description, endpoint_url, access_key, notes, updated_at)
     VALUES (@id, @name, @description, @endpointUrl, @accessKey, @notes, @updatedAt)`,
  );
  const tx = db.transaction((rows) => {
    del.run();
    for (const e of rows) {
      ins.run({
        id: e.id,
        name: e.name,
        description: e.description,
        endpointUrl: e.endpointUrl,
        accessKey: e.accessKey,
        notes: e.notes,
        updatedAt: e.updatedAt,
      });
    }
  });
  tx(entries);
  return { entries };
}

function listThemesWithDialogs() {
  /** Hide Intro / Access service themes — those panels open from their own controls, not the theme list. */
  const themes = db
    .prepare(
      `SELECT id, title, created_at, updated_at FROM themes
       WHERE id NOT IN (SELECT theme_id FROM dialogs WHERE IFNULL(purpose, '') IN ('intro', 'access'))
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

function userTextTriggersAccessDataDumpLockdown(userText) {
  const t = String(userText ?? "").trim();
  if (!t) return false;
  if (t === "#data") return true;
  return /(?:^|\s)#data(?:\s|$)/.test(t);
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
 * Deletes a theme and cascades everything that references it (dialogs, threads, RAG by thread_id).
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

const MEMORY_GRAPH_CATEGORIES = new Set([
  "People",
  "Dates",
  "Cities",
  "Countries",
  "Companies",
  "Projects",
  "Interests",
  "Documents",
  "Data",
  "Other",
]);

/** Default graph anchors (empty DB): profile and thematic interests. */
const MEMORY_GRAPH_HUB_USER_LABEL = "User";
const MEMORY_GRAPH_HUB_INTERESTS_LABEL = "Interests";

function normalizeMemoryGraphCategory(raw) {
  const s = String(raw ?? "").trim();
  if (MEMORY_GRAPH_CATEGORIES.has(s)) return s;
  return "Other";
}

/**
 * Ensures two canonical hubs (People/User, Interests/Interests) and an edge between them,
 * even when the graph is non-empty — otherwise chat ingest cannot attach links to Interests.
 */
function ensureMemoryGraphHubAnchorsPresent(database) {
  applyMemoryGraphMigration(database);
  const tbl = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_graph_nodes'`)
    .get();
  if (!tbl) return;
  const now = new Date().toISOString();
  const userBlob =
    "- Anchor for Intro and self facts: attach profile details here.\n" +
    "- Prefer linking other Intro entities to this node rather than duplicating a separate “self” person node.";
  const interestsBlob =
    "- Hub for themes from regular chats: store broad umbrellas first (e.g. Astronomy, Music).\n" +
    "- Add narrower topics as children linked to these umbrellas and to this hub.";

  let userRow = database
    .prepare(`SELECT id FROM memory_graph_nodes WHERE category = ? AND label = ?`)
    .get("People", MEMORY_GRAPH_HUB_USER_LABEL);
  let userId = userRow?.id;
  if (!userId) {
    userId = crypto.randomUUID();
    database
      .prepare(
        `INSERT INTO memory_graph_nodes (id, category, label, blob, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, "People", MEMORY_GRAPH_HUB_USER_LABEL, userBlob, now, now);
  }

  let intRow = database
    .prepare(`SELECT id FROM memory_graph_nodes WHERE category = ? AND label = ?`)
    .get("Interests", MEMORY_GRAPH_HUB_INTERESTS_LABEL);
  let interestsId = intRow?.id;
  if (!interestsId) {
    interestsId = crypto.randomUUID();
    database
      .prepare(
        `INSERT INTO memory_graph_nodes (id, category, label, blob, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(interestsId, "Interests", MEMORY_GRAPH_HUB_INTERESTS_LABEL, interestsBlob, now, now);
  }

  const edge = database
    .prepare(
      `SELECT id FROM memory_graph_edges WHERE
        (source_node_id = ? AND target_node_id = ?) OR (source_node_id = ? AND target_node_id = ?)`,
    )
    .get(userId, interestsId, interestsId, userId);
  if (!edge) {
    database
      .prepare(
        `INSERT INTO memory_graph_edges (id, source_node_id, target_node_id, relation, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), userId, interestsId, "profile and interests", now);
  }
}

function memoryGraphNodeKey(category, label) {
  return `${category}\n${normGraphLabel(label)}`;
}

/** Single normalization path for node labels in the DB (no domain heuristics). */
function normGraphLabel(raw) {
  return String(raw ?? "")
    .normalize("NFC")
    .trim()
    .slice(0, 200);
}

function appendGraphBlob(blob, notes) {
  const lineRaw = String(notes ?? "").trim();
  if (!lineRaw) return String(blob ?? "").trim();
  const line = lineRaw.startsWith("-") ? lineRaw : `- ${lineRaw}`;
  let b = String(blob ?? "").trim();
  b = b ? `${b}\n${line}` : line;
  if (b.length > 32000) b = `${b.slice(0, 31997)}…`;
  return b;
}

/** SHA256(hex of MD5(6-digit PIN)) — verify by recomputing; PIN is not stored. */
function doubleHashIrPanelPin6(pin) {
  const raw = String(pin ?? "").replace(/\D/g, "");
  if (!/^[0-9]{6}$/.test(raw)) return null;
  const md5hex = crypto.createHash("md5").update(raw, "utf8").digest("hex");
  return crypto.createHash("sha256").update(md5hex, "utf8").digest("hex");
}

function getIrPanelLocksPayload() {
  applyIrPanelPinLockMigration(db);
  const rows = db.prepare(`SELECT panel FROM ir_panel_pin_lock`).all();
  const set = new Set(rows.map((r) => String(r.panel)));
  return {
    intro: { locked: set.has("intro") },
    rules: { locked: set.has("rules") },
    access: { locked: set.has("access") },
  };
}

function getOrCreateIntroSession() {
  applyDialogsPurposeColumn(db);
  applyMemoryGraphMigration(db);
  const row = db
    .prepare(`SELECT d.id AS dialog_id, d.theme_id AS theme_id FROM dialogs d WHERE d.purpose = 'intro' LIMIT 1`)
    .get();
  if (row) {
    return { themeId: row.theme_id, dialogId: row.dialog_id };
  }
  const themeId = crypto.randomUUID();
  const dialogId = crypto.randomUUID();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO themes (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
      themeId,
      "Intro",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO dialogs (id, theme_id, title, created_at, updated_at, purpose) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(dialogId, themeId, "Self profile", now, now, "intro");
  });
  tx();
  return { themeId, dialogId };
}

function getOrCreateAccessSession() {
  applyDialogsPurposeColumn(db);
  applyMemoryGraphMigration(db);
  const row = db
    .prepare(`SELECT d.id AS dialog_id, d.theme_id AS theme_id FROM dialogs d WHERE d.purpose = 'access' LIMIT 1`)
    .get();
  if (row) {
    return { themeId: row.theme_id, dialogId: row.dialog_id };
  }
  const themeId = crypto.randomUUID();
  const dialogId = crypto.randomUUID();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO themes (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
      themeId,
      "Access",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO dialogs (id, theme_id, title, created_at, updated_at, purpose) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(dialogId, themeId, "External services", now, now, "access");
  });
  tx();
  return { themeId, dialogId };
}

function memoryGraphIsProtectedHubNode(category, label) {
  const c = normalizeMemoryGraphCategory(category);
  const lab = normGraphLabel(label);
  return (
    (c === "People" && lab === MEMORY_GRAPH_HUB_USER_LABEL) ||
    (c === "Interests" && lab === MEMORY_GRAPH_HUB_INTERESTS_LABEL)
  );
}

function memoryGraphGetNodeRow(database, category, label) {
  const c = normalizeMemoryGraphCategory(category);
  const lab = normGraphLabel(label);
  return database.prepare(`SELECT id, blob FROM memory_graph_nodes WHERE category = ? AND label = ?`).get(c, lab) ?? null;
}

function memoryGraphMergeTwoNodes(database, fromCat, fromLab, intoCat, intoLab, now) {
  const fromRow = memoryGraphGetNodeRow(database, fromCat, fromLab);
  const intoRow = memoryGraphGetNodeRow(database, intoCat, intoLab);
  if (!fromRow?.id || !intoRow?.id || fromRow.id === intoRow.id) return false;
  const fromId = fromRow.id;
  const intoId = intoRow.id;
  const ob = String(fromRow.blob ?? "").trim();
  if (ob) {
    const intoBlobRow = database.prepare(`SELECT blob FROM memory_graph_nodes WHERE id = ?`).get(intoId);
    const merged = appendGraphBlob(
      String(intoBlobRow?.blob ?? "").trim(),
      `Merged from “${normGraphLabel(fromLab)}” (${normalizeMemoryGraphCategory(fromCat)}):\n${ob}`,
    );
    const b = merged.length > 32000 ? `${merged.slice(0, 31997)}…` : merged;
    database.prepare(`UPDATE memory_graph_nodes SET blob = ?, updated_at = ? WHERE id = ?`).run(b, now, intoId);
  }
  const edges = database
    .prepare(
      `SELECT id, source_node_id AS src, target_node_id AS tgt, relation FROM memory_graph_edges WHERE source_node_id = ? OR target_node_id = ?`,
    )
    .all(fromId, fromId);
  for (const e of edges) {
    const ns = e.src === fromId ? intoId : e.src;
    const nt = e.tgt === fromId ? intoId : e.tgt;
    if (ns === nt) {
      database.prepare(`DELETE FROM memory_graph_edges WHERE id = ?`).run(e.id);
      continue;
    }
    const dup = database
      .prepare(
        `SELECT id FROM memory_graph_edges WHERE source_node_id = ? AND target_node_id = ? AND relation = ?`,
      )
      .get(ns, nt, e.relation);
    if (dup) {
      database.prepare(`DELETE FROM memory_graph_edges WHERE id = ?`).run(e.id);
    } else {
      database
        .prepare(`UPDATE memory_graph_edges SET source_node_id = ?, target_node_id = ? WHERE id = ?`)
        .run(ns, nt, e.id);
    }
  }
  database.prepare(`DELETE FROM memory_graph_nodes WHERE id = ?`).run(fromId);
  return true;
}

function applyMemoryGraphCommandsFromBody(database, rawCommands, now) {
  const stats = {
    mergeNodes: 0,
    deleteNode: 0,
    renameNode: 0,
    deleteEdge: 0,
    moveEdge: 0,
    skipped: 0,
  };
  if (!Array.isArray(rawCommands) || rawCommands.length === 0) return stats;
  for (const c of rawCommands.slice(0, 50)) {
    if (!c || typeof c !== "object") continue;
    const op = String(c.op ?? "").trim();
    try {
      if (op === "mergeNodes") {
        const fc = normalizeMemoryGraphCategory(c.from?.category);
        const fl = normGraphLabel(c.from?.label);
        const tc = normalizeMemoryGraphCategory(c.into?.category);
        const tl = normGraphLabel(c.into?.label);
        if (!fl || !tl) {
          stats.skipped += 1;
          continue;
        }
        if (memoryGraphMergeTwoNodes(database, fc, fl, tc, tl, now)) stats.mergeNodes += 1;
        else stats.skipped += 1;
      } else if (op === "deleteNode") {
        const cat = normalizeMemoryGraphCategory(c.category);
        const lab = normGraphLabel(c.label);
        if (!lab || memoryGraphIsProtectedHubNode(cat, lab)) {
          stats.skipped += 1;
          continue;
        }
        const row = memoryGraphGetNodeRow(database, cat, lab);
        if (!row?.id) {
          stats.skipped += 1;
          continue;
        }
        database.prepare(`DELETE FROM memory_graph_edges WHERE source_node_id = ? OR target_node_id = ?`).run(
          row.id,
          row.id,
        );
        database.prepare(`DELETE FROM memory_graph_nodes WHERE id = ?`).run(row.id);
        stats.deleteNode += 1;
      } else if (op === "renameNode") {
        const cat = normalizeMemoryGraphCategory(c.category);
        const fromLab = normGraphLabel(c.fromLabel);
        const toLab = normGraphLabel(c.toLabel);
        if (!fromLab || !toLab || fromLab === toLab || memoryGraphIsProtectedHubNode(cat, fromLab)) {
          stats.skipped += 1;
          continue;
        }
        const row = memoryGraphGetNodeRow(database, cat, fromLab);
        if (!row?.id) {
          stats.skipped += 1;
          continue;
        }
        const collision = memoryGraphGetNodeRow(database, cat, toLab);
        if (collision?.id && collision.id !== row.id) {
          if (memoryGraphMergeTwoNodes(database, cat, fromLab, cat, toLab, now)) stats.renameNode += 1;
          else stats.skipped += 1;
          continue;
        }
        database
          .prepare(`UPDATE memory_graph_nodes SET label = ?, updated_at = ? WHERE id = ?`)
          .run(toLab, now, row.id);
        stats.renameNode += 1;
      } else if (op === "deleteEdge") {
        const fc = normalizeMemoryGraphCategory(c.from?.category);
        const fl = normGraphLabel(c.from?.label);
        const tc = normalizeMemoryGraphCategory(c.to?.category);
        const tl = normGraphLabel(c.to?.label);
        const relOpt = c.relation != null ? String(c.relation).trim().slice(0, 200) : "";
        if (!fl || !tl) {
          stats.skipped += 1;
          continue;
        }
        const s = memoryGraphGetNodeRow(database, fc, fl);
        const t = memoryGraphGetNodeRow(database, tc, tl);
        if (!s?.id || !t?.id) {
          stats.skipped += 1;
          continue;
        }
        if (relOpt) {
          const r = database
            .prepare(
              `DELETE FROM memory_graph_edges WHERE source_node_id = ? AND target_node_id = ? AND relation = ?`,
            )
            .run(s.id, t.id, relOpt);
          stats.deleteEdge += r.changes;
        } else {
          const r = database
            .prepare(`DELETE FROM memory_graph_edges WHERE source_node_id = ? AND target_node_id = ?`)
            .run(s.id, t.id);
          stats.deleteEdge += r.changes;
        }
      } else if (op === "moveEdge") {
        const rel = String(c.relation ?? "").trim().slice(0, 200) || "related";
        const ofc = normalizeMemoryGraphCategory(c.oldFrom?.category);
        const ofl = normGraphLabel(c.oldFrom?.label);
        const otc = normalizeMemoryGraphCategory(c.oldTo?.category);
        const otl = normGraphLabel(c.oldTo?.label);
        const nfc = normalizeMemoryGraphCategory(c.newFrom?.category);
        const nfl = normGraphLabel(c.newFrom?.label);
        const ntc = normalizeMemoryGraphCategory(c.newTo?.category);
        const ntl = normGraphLabel(c.newTo?.label);
        if (!ofl || !otl || !nfl || !ntl) {
          stats.skipped += 1;
          continue;
        }
        const os = memoryGraphGetNodeRow(database, ofc, ofl);
        const ot = memoryGraphGetNodeRow(database, otc, otl);
        const ns = memoryGraphGetNodeRow(database, nfc, nfl);
        const nt = memoryGraphGetNodeRow(database, ntc, ntl);
        if (!os?.id || !ot?.id || !ns?.id || !nt?.id) {
          stats.skipped += 1;
          continue;
        }
        database
          .prepare(`DELETE FROM memory_graph_edges WHERE source_node_id = ? AND target_node_id = ? AND relation = ?`)
          .run(os.id, ot.id, rel);
        const dup = database
          .prepare(
            `SELECT id FROM memory_graph_edges WHERE source_node_id = ? AND target_node_id = ? AND relation = ?`,
          )
          .get(ns.id, nt.id, rel);
        if (!dup && ns.id !== nt.id) {
          database
            .prepare(
              `INSERT INTO memory_graph_edges (id, source_node_id, target_node_id, relation, created_at) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(crypto.randomUUID(), ns.id, nt.id, rel, now);
        }
        stats.moveEdge += 1;
      }
    } catch {
      stats.skipped += 1;
    }
  }
  return stats;
}

/** Dialogs excluded from analytics (Intro / Rules / Access). */
function analyticsDialogWhereSql(alias = "d") {
  return `IFNULL(${alias}.purpose, '') NOT IN ('intro', 'rules', 'access')`;
}

/**
 * @returns {{
 *   providers: Record<string, { requestsSent: number, responsesOk: number, imageRequests: number, researchRequests: number, webRequests: number, accessRequests: number }>,
 *   dailyUsage: Array<{ date: string, byProvider: Record<string, number> }>,
 *   themesCount: number,
 *   dialogsCount: number,
 *   memoryGraph: { nodes: number, edges: number, groups: number }
 * }}
 */
function getAnalyticsPayload() {
  /** @type {Record<string, { requestsSent: number, responsesOk: number, imageRequests: number, researchRequests: number, webRequests: number, accessRequests: number }>} */
  const providers = {};
  for (const id of ANALYTICS_PROVIDER_IDS) {
    providers[id] = {
      requestsSent: 0,
      responsesOk: 0,
      imageRequests: 0,
      researchRequests: 0,
      webRequests: 0,
      accessRequests: 0,
    };
  }

  const aggRows = db
    .prepare(
      `SELECT
         COALESCE(NULLIF(TRIM(t.responding_provider_id), ''), t.requested_provider_id) AS pid,
         COUNT(*) AS requests_sent,
         SUM(CASE WHEN t.assistant_message_at IS NOT NULL AND IFNULL(t.assistant_error, 0) = 0 THEN 1 ELSE 0 END) AS responses_ok,
         SUM(CASE WHEN t.request_type = 'image' THEN 1 ELSE 0 END) AS image_requests,
         SUM(CASE WHEN t.request_type = 'research' THEN 1 ELSE 0 END) AS research_requests,
         SUM(CASE WHEN t.request_type = 'web' THEN 1 ELSE 0 END) AS web_requests,
         SUM(CASE WHEN t.request_type = 'access_data' THEN 1 ELSE 0 END) AS access_requests
       FROM conversation_turns t
       INNER JOIN dialogs d ON d.id = t.dialog_id
       WHERE ${analyticsDialogWhereSql("d")}
       GROUP BY pid`,
    )
    .all();
  for (const row of aggRows) {
    const pid = String(row.pid ?? "").trim();
    if (!providers[pid]) continue;
    providers[pid].requestsSent = Number(row.requests_sent) || 0;
    providers[pid].responsesOk = Number(row.responses_ok) || 0;
    providers[pid].imageRequests = Number(row.image_requests) || 0;
    providers[pid].researchRequests = Number(row.research_requests) || 0;
    providers[pid].webRequests = Number(row.web_requests) || 0;
    providers[pid].accessRequests = Number(row.access_requests) || 0;
  }

  const dayRows = db
    .prepare(
      `SELECT
         DATE(t.user_message_at) AS day,
         COALESCE(NULLIF(TRIM(t.responding_provider_id), ''), t.requested_provider_id) AS pid,
         COUNT(*) AS cnt
       FROM conversation_turns t
       INNER JOIN dialogs d ON d.id = t.dialog_id
       WHERE ${analyticsDialogWhereSql("d")}
         AND DATETIME(t.user_message_at) >= DATETIME('now', '-30 days')
       GROUP BY day, pid
       ORDER BY day ASC`,
    )
    .all();

  /** @type {Map<string, Record<string, number>>} */
  const dayMap = new Map();
  for (const r of dayRows) {
    const day = String(r.day ?? "").trim();
    const pid = String(r.pid ?? "").trim();
    if (!day || !ANALYTICS_PROVIDER_IDS.includes(pid)) continue;
    if (!dayMap.has(day)) {
      const o = {};
      for (const id of ANALYTICS_PROVIDER_IDS) o[id] = 0;
      dayMap.set(day, o);
    }
    dayMap.get(day)[pid] = Number(r.cnt) || 0;
  }

  const dailyUsage = [];
  for (let i = 29; i >= 0; i -= 1) {
    const row = db.prepare(`SELECT DATE(DATETIME('now', ?)) AS d`).get(`-${i} days`);
    const day = String(row?.d ?? "").trim();
    const byProvider = dayMap.get(day) ?? Object.fromEntries(ANALYTICS_PROVIDER_IDS.map((id) => [id, 0]));
    dailyUsage.push({ date: day, byProvider: { ...byProvider } });
  }

  const themesRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM themes WHERE id NOT IN (
         SELECT DISTINCT theme_id FROM dialogs WHERE IFNULL(purpose, '') IN ('intro', 'access')
       )`,
    )
    .get();
  const dialogsRow = db
    .prepare(`SELECT COUNT(*) AS n FROM dialogs d WHERE ${analyticsDialogWhereSql("d")}`)
    .get();

  let memoryGraph = { nodes: 0, edges: 0, groups: 0 };
  const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_graph_nodes'`).get();
  if (tbl) {
    const nodesRow = db.prepare(`SELECT COUNT(*) AS n FROM memory_graph_nodes`).get();
    const edgesRow = db.prepare(`SELECT COUNT(*) AS n FROM memory_graph_edges`).get();
    const groupsRow = db.prepare(`SELECT COUNT(DISTINCT category) AS n FROM memory_graph_nodes`).get();
    memoryGraph = {
      nodes: Number(nodesRow?.n) || 0,
      edges: Number(edgesRow?.n) || 0,
      groups: Number(groupsRow?.n) || 0,
    };
  }

  return {
    providers,
    dailyUsage,
    themesCount: Number(themesRow?.n) || 0,
    dialogsCount: Number(dialogsRow?.n) || 0,
    memoryGraph,
  };
}

function getMemoryGraphPayload() {
  ensureMemoryGraphHubAnchorsPresent(db);
  const tbl = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_graph_nodes'`)
    .get();
  if (!tbl) {
    return { nodes: [], links: [] };
  }
  const nodes = db
    .prepare(
      `SELECT id, category, label, blob FROM memory_graph_nodes ORDER BY category ASC, label COLLATE NOCASE ASC`,
    )
    .all();
  const links = db
    .prepare(
      `SELECT id, source_node_id AS source, target_node_id AS target, relation AS label FROM memory_graph_edges`,
    )
    .all();
  return { nodes, links };
}

/**
 * @param {unknown} body
 * @returns {{ ok: true, upsertedEntities: number, insertedLinks: number, commandsApplied: Record<string, number> }}
 */
function ingestMemoryGraphFromBody(body) {
  ensureMemoryGraphHubAnchorsPresent(db);
  applyMemoryGraphMigration(db);
  const entities = Array.isArray(body?.entities) ? body.entities : [];
  const links = Array.isArray(body?.links) ? body.links : [];
  const commands = Array.isArray(body?.commands) ? body.commands : [];
  const now = new Date().toISOString();
  /** @type {Map<string, string>} */
  const keyToId = new Map();
  let upserted = 0;
  /** @type {Record<string, number>} */
  let commandsApplied = {};

  const tx = db.transaction(() => {
    for (const e of entities) {
      if (!e || typeof e !== "object") continue;
      const category = normalizeMemoryGraphCategory(e.category);
      const label = normGraphLabel(e.label);
      const notes = String(e.notes ?? "").trim().slice(0, 4000);
      if (!label) continue;
      const nk = memoryGraphNodeKey(category, label);
      const existing = db
        .prepare(`SELECT id, blob FROM memory_graph_nodes WHERE category = ? AND label = ?`)
        .get(category, label);
      if (existing) {
        const blob = appendGraphBlob(existing.blob, notes);
        db.prepare(`UPDATE memory_graph_nodes SET blob = ?, updated_at = ? WHERE id = ?`).run(blob, now, existing.id);
        keyToId.set(nk, existing.id);
      } else {
        const id = crypto.randomUUID();
        const blob0 = notes ? (notes.startsWith("-") ? notes : `- ${notes}`) : "";
        db.prepare(
          `INSERT INTO memory_graph_nodes (id, category, label, blob, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, category, label, blob0.slice(0, 32000), now, now);
        keyToId.set(nk, id);
      }
      upserted += 1;
    }

    let insertedLinks = 0;
    for (const ln of links) {
      if (!ln || typeof ln !== "object") continue;
      const from = ln.from;
      const to = ln.to;
      if (!from || !to || typeof from !== "object" || typeof to !== "object") continue;
      const fc = normalizeMemoryGraphCategory(from.category);
      const fl = normGraphLabel(from.label);
      const tc = normalizeMemoryGraphCategory(to.category);
      const tl = normGraphLabel(to.label);
      if (!fl || !tl) continue;
      const kf = memoryGraphNodeKey(fc, fl);
      const kt = memoryGraphNodeKey(tc, tl);
      let sid = keyToId.get(kf);
      let tid = keyToId.get(kt);
      if (!sid) {
        const r = db.prepare(`SELECT id FROM memory_graph_nodes WHERE category = ? AND label = ?`).get(fc, fl);
        sid = r?.id;
      }
      if (!tid) {
        const r = db.prepare(`SELECT id FROM memory_graph_nodes WHERE category = ? AND label = ?`).get(tc, tl);
        tid = r?.id;
      }
      if (!sid || !tid || sid === tid) continue;
      const rel = String(ln.relation ?? "").trim().slice(0, 200) || "related";
      db.prepare(
        `INSERT INTO memory_graph_edges (id, source_node_id, target_node_id, relation, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(crypto.randomUUID(), sid, tid, rel, now);
      insertedLinks += 1;
    }
    commandsApplied = applyMemoryGraphCommandsFromBody(db, commands, now);
    return insertedLinks;
  });

  const insertedLinks = tx();
  return { ok: true, upsertedEntities: upserted, insertedLinks, commandsApplied };
}

function normalizePathname(pathname) {
  const s = String(pathname || "/");
  const collapsed = s.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) return collapsed.slice(0, -1);
  return collapsed;
}

/**
 * Proxies (Apache, etc.) often pass pathnames like /mf-lab/api/... while the router expects /api/...
 * Optional: API_PATH_PREFIX=/mf-lab strips one leading path segment.
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

    if (req.method === "GET" && p === "/api/intro/session") {
      const s = getOrCreateIntroSession();
      return json(res, 200, { ok: true, themeId: s.themeId, dialogId: s.dialogId });
    }

    if (req.method === "GET" && p === "/api/access/session") {
      const s = getOrCreateAccessSession();
      return json(res, 200, { ok: true, themeId: s.themeId, dialogId: s.dialogId });
    }

    if (req.method === "GET" && p === "/api/access/external-services") {
      return json(res, 200, { ok: true, ...readAccessExternalServicesPayload() });
    }

    if (req.method === "GET" && p === "/api/access/external-services/catalog") {
      return json(res, 200, { ok: true, ...readAccessExternalServicesCatalogPayload() });
    }

    if (req.method === "GET" && p === "/api/access/data-dump-enrichment") {
      try {
        const out = await getAccessDataDumpEnrichmentPayload();
        return json(res, 200, out);
      } catch (e) {
        console.error("[mf-lab-api] data-dump-enrichment:", e);
        return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (req.method === "PUT" && p === "/api/access/external-services") {
      const body = await readBody(req);
      const out = writeAccessExternalServicesPayload(body);
      return json(res, 200, { ok: true, ...out });
    }

    if (req.method === "GET" && p === "/api/ir-panel-lock") {
      return json(res, 200, { ok: true, ...getIrPanelLocksPayload() });
    }

    const irLockSetMatch = p.match(/^\/api\/ir-panel-lock\/(intro|rules|access)\/set$/);
    if (req.method === "POST" && irLockSetMatch) {
      const panel = irLockSetMatch[1];
      const body = await readBody(req);
      const h = doubleHashIrPanelPin6(body.pin ?? body.PIN);
      if (!h) {
        return json(res, 400, { ok: false, error: "PIN must be exactly 6 digits." });
      }
      applyIrPanelPinLockMigration(db);
      db.prepare(
        `INSERT INTO ir_panel_pin_lock (panel, pin_double_hash) VALUES (?, ?) ON CONFLICT(panel) DO UPDATE SET pin_double_hash = excluded.pin_double_hash`,
      ).run(panel, h);
      return json(res, 200, { ok: true, panel, locked: true });
    }

    const irLockUnlockMatch = p.match(/^\/api\/ir-panel-lock\/(intro|rules|access)\/unlock$/);
    if (req.method === "POST" && irLockUnlockMatch) {
      const panel = irLockUnlockMatch[1];
      const body = await readBody(req);
      const h = doubleHashIrPanelPin6(body.pin ?? body.PIN);
      if (!h) {
        return json(res, 400, { ok: false, error: "PIN must be exactly 6 digits." });
      }
      applyIrPanelPinLockMigration(db);
      const row = db.prepare(`SELECT pin_double_hash FROM ir_panel_pin_lock WHERE panel = ?`).get(panel);
      if (!row?.pin_double_hash) {
        const label = panel === "intro" ? "Intro" : panel === "rules" ? "Rules" : "Access";
        return json(res, 400, { ok: false, error: `${label} is not locked.` });
      }
      if (row.pin_double_hash !== h) {
        return json(res, 403, { ok: false, error: "Incorrect PIN." });
      }
      db.prepare(`DELETE FROM ir_panel_pin_lock WHERE panel = ?`).run(panel);
      return json(res, 200, { ok: true, panel, locked: false });
    }

    if (req.method === "GET" && p === "/api/memory-graph") {
      return json(res, 200, getMemoryGraphPayload());
    }

    if (req.method === "GET" && p === "/api/analytics") {
      return json(res, 200, { ok: true, ...getAnalyticsPayload() });
    }

    if (req.method === "POST" && p === "/api/memory-graph/ingest") {
      const body = await readBody(req);
      try {
        const out = ingestMemoryGraphFromBody(body);
        return json(res, 200, out);
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
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

    /** Favorites: short path plus /api/dialogs/ variant (canonicalApiPath strips duplicate /api/api/). */
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
     * Theme delete: cascades all dialogs of that theme, conversation_turns,
     * and per-thread RAG — thread_messages (including embeddings), thread_summaries,
     * memory_items whose thread_id points at those dialogs. Global rules and rows without FK to the theme are untouched.
     *
     * POST is the primary UI path (like /api/themes/new-dialog): some proxies/old API builds return 404 on DELETE.
     * DELETE is kept for compatibility.
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

    /** Flat path like /api/themes/bootstrap; safer behind proxies and without a UUID in the URL segment. */
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
      const drow = db
        .prepare(`SELECT id, theme_id, IFNULL(purpose, '') AS purpose FROM dialogs WHERE id = ?`)
        .get(dialogId);
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
      const assistantError = body.assistant_error === 1 || body.assistant_error === true ? 1 : 0;

      const attachRows = parseTurnUserAttachmentsJson(userAttachmentsJson);
      const hasUserChars = String(userText).trim().length > 0;
      const hasAttach = attachRows.length > 0;
      const allowEmptyUserText = requestType === "access_data";
      if ((!hasUserChars && !hasAttach && !allowEmptyUserText) || !requestedProviderId || !userMessageAt) {
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
            request_type, user_message_at, assistant_message_at, assistant_error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          assistantError,
        );
        db.prepare(`UPDATE dialogs SET updated_at = ? WHERE id = ?`).run(now, dialogId);
        db.prepare(`UPDATE themes SET updated_at = ? WHERE id = ?`).run(now, drow.theme_id);
      });
      tx();
      try {
        /** Access thread, #data in text, or Access data menu: persist turns only; no RAG / memory extraction side lane. */
        const dataDumpLockdown =
          userTextTriggersAccessDataDumpLockdown(userText) || requestType === "access_data";
        if (String(drow.purpose ?? "") !== "access" && !dataDumpLockdown) {
          runAfterTurnPipeline(
            dialogId,
            turnId,
            pipelineUserText,
            assistantText,
            userMessageAt,
            assistantMessageAt || now,
          );
        }
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
