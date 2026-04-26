/**
 * Local SQLite API for themes, dialogs, and conversation turns.
 * Default port 35184 (5984 is often CouchDB — avoid clash). Vite proxies /api → this server.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { resolveApiPort } from "./resolveApiPort.mjs";
import { buildAccessDataDumpEnrichmentFromEntries } from "./accessDataDump.mjs";
import {
  mergeRollingSummary,
  appendDecisionLogLine,
  shouldUpdateRollingSummary,
} from "../src/contextEngine/rollingSummary.js";
import { extractMemoryItemsFromMessages } from "../src/contextEngine/memoryExtraction.js";
import {
  decodeImportBodyFromBuffer,
  normalizeImportPayload,
  replaceMemoryGraphInDatabase,
} from "./memoryGraphImport.mjs";
import { buildProjectProfileMf7zBuffer, projectProfileMfFilename } from "./projectProfileExport.mjs";
import { importProjectProfileFromMfBuffer } from "./projectProfileImport.mjs";
import {
  sanitizeAccessExternalEntries,
  replaceAccessExternalServicesInDatabase,
} from "./accessExternalServicesDb.mjs";
import {
  readAccessDataDumpEnrichmentImportCacheIfPresent,
  clearAccessDataDumpEnrichmentImportCache,
} from "./accessDataDumpImportCache.mjs";
import {
  scheduleMemoryGraphKeeperIngestForChatApiTurn,
  shouldRunMemoryGraphKeeperForApiTurnBody,
} from "./memoryGraphApiTurnKeeper.mjs";
import { extractAttachmentText } from "./attachmentTextExtract.mjs";

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
const migration009 = path.join(root, "db", "migrations", "009_analytics_usage_archive.sql");
const migration010 = path.join(root, "db", "migrations", "010_llm_token_usage.sql");
const migration011 = path.join(root, "db", "migrations", "011_analytics_aux_llm_usage.sql");
const aiModelListsCachePath = path.join(root, "data", "ai-model-lists-cache.json");
const PORT = resolveApiPort(process.env.API_PORT);

/** Default max JSON body size for POST/PUT (bytes). Override with API_MAX_BODY_BYTES. */
const DEFAULT_API_MAX_BODY_BYTES = 48 * 1024 * 1024;
const MIN_API_MAX_BODY_BYTES = 1024 * 1024;
const MAX_API_MAX_BODY_BYTES = 100 * 1024 * 1024;

function getApiMaxBodyBytes() {
  const raw = process.env.API_MAX_BODY_BYTES;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_API_MAX_BODY_BYTES;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < MIN_API_MAX_BODY_BYTES || n > MAX_API_MAX_BODY_BYTES) {
    return DEFAULT_API_MAX_BODY_BYTES;
  }
  return n;
}


const ANALYTICS_PROVIDER_IDS = ["openai", "perplexity", "gemini-flash", "anthropic"];

/** Allowed `request_kind` values for POST /api/analytics/aux-llm-usage */
const AUX_LLM_USAGE_KINDS = new Set([
  "memory_tree_router",
  "interests_sketch",
  "memory_graph_normalize",
  "intro_graph_extract",
  "ai_talks_round",
  "voice_transcription",
  "voice_reply_tts",
  "optimizer_record_linkage",
  "optimizer_llm_check",
  "theme_dialog_title",
  "help_chat_turn",
  "rules_keeper_extract",
  "access_keeper2_extract",
]);

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

const MAX_PERSIST_IMAGE_BASE64_CHARS = 14_000_000;
const MAX_PERSIST_TEXT_INLINE_CHARS = 120_000;

/**
 * Client normally sends `user_attachments_json` as a JSON string; accept array/object too.
 * @param {Record<string, unknown>} body
 * @returns {string}
 */
function userAttachmentsJsonFromTurnPostBody(body) {
  const v = body?.user_attachments_json;
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return "";
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
      .map((x) => {
        const name = String(x.name ?? "file").slice(0, 512);
        const kind = ["image", "document", "code", "other"].includes(String(x.kind)) ? String(x.kind) : "other";
        /** @type {Record<string, unknown>} */
        const out = { name, kind };

        const mimeRaw = String(x.mimeType ?? x.mime ?? "")
          .trim()
          .slice(0, 128);
        if (/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+\/-]*$/i.test(mimeRaw)) {
          out.mimeType = mimeRaw;
        }

        const b64src = x.imageBase64 != null ? String(x.imageBase64) : x.base64 != null ? String(x.base64) : "";
        const b64 = b64src.replace(/\s/g, "");
        if (kind === "image" && b64.length > 0 && b64.length <= MAX_PERSIST_IMAGE_BASE64_CHARS) {
          if (/^[A-Za-z0-9+/]+=*$/.test(b64)) {
            out.imageBase64 = b64;
          }
        }

        const textRaw =
          x.textInline != null
            ? String(x.textInline)
            : x.textSnapshot != null
              ? String(x.textSnapshot)
              : "";
        if (textRaw.length > 0 && textRaw.length <= MAX_PERSIST_TEXT_INLINE_CHARS) {
          out.textInline = textRaw;
        }

        return out;
      });
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
  applyAnalyticsUsageArchiveMigration(database);
  applyLlmTokenUsageMigration(database);
  applyAnalyticsAuxLlmUsageMigration(database);
  return database;
}

function applyAnalyticsAuxLlmUsageMigration(database) {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_aux_llm_usage'`)
    .get();
  if (row) return;
  if (fs.existsSync(migration011)) {
    database.exec(fs.readFileSync(migration011, "utf8"));
  }
}

function applyLlmTokenUsageMigration(database) {
  const cols = database.prepare(`PRAGMA table_info(conversation_turns)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (names.has("llm_total_tokens")) return;
  if (fs.existsSync(migration010)) {
    database.exec(fs.readFileSync(migration010, "utf8"));
  }
}

function applyAnalyticsUsageArchiveMigration(database) {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_usage_archive'`)
    .get();
  if (row) return;
  if (fs.existsSync(migration009)) {
    database.exec(fs.readFileSync(migration009, "utf8"));
  }
}

const db = ensureDatabase();

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

/** Standard API error body (`error` for clients; `ok: false` when success checks use `data.ok === true`). */
function apiErrorBody(message) {
  return { ok: false, error: String(message ?? "") };
}

const AI_MODEL_CACHE_PROVIDERS = new Set(["openai", "perplexity", "gemini", "anthropic"]);
const AI_MODEL_CACHE_ROLES = new Set(["dialogue", "images", "search", "research"]);

function sanitizeAiModelListsCache(raw) {
  const out = { version: 1, updatedAt: "", lists: {} };
  const src = raw && typeof raw === "object" ? raw : {};
  out.updatedAt = String(src.updatedAt ?? "").trim().slice(0, 64);
  const lists = src.lists && typeof src.lists === "object" ? src.lists : {};
  for (const [provider, roles] of Object.entries(lists)) {
    if (!AI_MODEL_CACHE_PROVIDERS.has(provider)) continue;
    const roleObj = roles && typeof roles === "object" ? roles : {};
    const cleanRoleObj = {};
    for (const [role, ids] of Object.entries(roleObj)) {
      if (!AI_MODEL_CACHE_ROLES.has(role) || !Array.isArray(ids)) continue;
      const unique = [];
      const seen = new Set();
      for (const id of ids) {
        const v = String(id ?? "").trim().slice(0, 200);
        if (!v || seen.has(v)) continue;
        seen.add(v);
        unique.push(v);
        if (unique.length >= 500) break;
      }
      cleanRoleObj[role] = unique;
    }
    out.lists[provider] = cleanRoleObj;
  }
  return out;
}

function readAiModelListsCachePayload() {
  if (!fs.existsSync(aiModelListsCachePath)) {
    return { version: 1, updatedAt: "", lists: {} };
  }
  try {
    const raw = fs.readFileSync(aiModelListsCachePath, "utf8");
    const parsed = JSON.parse(raw);
    return sanitizeAiModelListsCache(parsed);
  } catch {
    return { version: 1, updatedAt: "", lists: {} };
  }
}

function writeAiModelListsCachePayload(body) {
  const src = body && typeof body === "object" ? body.cache : null;
  const base = sanitizeAiModelListsCache(src);
  base.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(aiModelListsCachePath), { recursive: true });
  fs.writeFileSync(aiModelListsCachePath, `${JSON.stringify(base, null, 2)}\n`, "utf8");
  return base;
}

class BodyTooLargeError extends Error {
  /** @param {number} maxBytes */
  constructor(maxBytes) {
    super(`Request body exceeds maximum size (${maxBytes} bytes).`);
    this.name = "BodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

function readBody(req) {
  const maxBytes = getApiMaxBodyBytes();
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const ok = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(new BodyTooLargeError(maxBytes));
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        ok({});
        return;
      }
      try {
        ok(JSON.parse(raw));
      } catch (e) {
        fail(e);
      }
    });
    req.on("error", fail);
  });
}

/** Raw request body as a single Buffer (gzip / binary import). Same size cap as {@link readBody}. */
function readBodyBuffer(req) {
  const maxBytes = getApiMaxBodyBytes();
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const ok = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(new BodyTooLargeError(maxBytes));
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      ok(Buffer.concat(chunks));
    });
    req.on("error", fail);
  });
}

function normalizeAudioMimeType(raw) {
  const t = String(raw ?? "")
    .trim()
    .toLowerCase()
    .split(";")[0]
    .trim();
  return t || "audio/webm";
}

function decodeBase64Audio(rawBase64) {
  const compact = String(rawBase64 ?? "").replace(/\s/g, "");
  if (!compact) throw new Error("audioBase64 is required.");
  let buf;
  try {
    buf = Buffer.from(compact, "base64");
  } catch {
    throw new Error("audioBase64 is not valid base64.");
  }
  if (!buf.length) throw new Error("Decoded audio is empty.");
  return buf;
}

function extractGeminiTextFromGenerateContent(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const c of candidates) {
    const parts = Array.isArray(c?.content?.parts) ? c.content.parts : [];
    const txt = parts
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("\n")
      .trim();
    if (txt) return txt;
  }
  return "";
}

async function transcribeWithGemini(audioBuffer, mimeType, apiKey) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "Transcribe this audio exactly. Return only the plain transcript text in the detected language. No explanations.",
          },
          {
            inline_data: {
              mime_type: mimeType,
              data: audioBuffer.toString("base64"),
            },
          },
        ],
      },
    ],
  };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      String(data?.error?.message ?? "").trim() || `Gemini transcription failed (${res.status})`;
    throw new Error(msg);
  }
  const text = extractGeminiTextFromGenerateContent(data).trim();
  if (!text) throw new Error("Gemini returned empty transcription.");
  return text;
}

async function transcribeWithOpenAi(audioBuffer, mimeType, apiKey) {
  const form = new FormData();
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("response_format", "json");
  form.append("file", new Blob([audioBuffer], { type: mimeType }), `voice.${mimeType.split("/")[1] || "webm"}`);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(data?.error?.message ?? "").trim() || `OpenAI transcription failed (${res.status})`;
    throw new Error(msg);
  }
  const text = String(data?.text ?? "").trim();
  if (!text) throw new Error("OpenAI returned empty transcription.");
  return text;
}

async function transcribeVoiceFromEnv(audioBuffer, mimeType, body) {
  const geminiKey =
    String(process.env.GEMINI_API_KEY ?? "").trim() || String(body?.geminiApiKey ?? "").trim();
  const openAiKey =
    String(process.env.OPENAI_API_KEY ?? "").trim() || String(body?.openAiApiKey ?? "").trim();
  if (!geminiKey && !openAiKey) {
    throw new Error("Voice transcription requires Gemini or ChatGPT key.");
  }
  if (geminiKey) {
    try {
      const text = await transcribeWithGemini(audioBuffer, mimeType, geminiKey);
      return { providerId: "gemini-flash", text };
    } catch (gemErr) {
      if (!openAiKey) throw gemErr;
    }
  }
  if (openAiKey) {
    const text = await transcribeWithOpenAi(audioBuffer, mimeType, openAiKey);
    return { providerId: "openai", text };
  }
  throw new Error("Voice transcription failed for available providers.");
}

const VOICE_REPLIES_DIR = path.join(root, "voice-rerplies");

function sanitizeTurnIdForVoiceFile(rawTurnId) {
  const tid = String(rawTurnId ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(tid)) {
    throw new Error("Invalid turn id for voice reply.");
  }
  return tid;
}

function voiceReplyMp3Path(turnId) {
  return path.join(VOICE_REPLIES_DIR, `${turnId}.mp3`);
}

function voiceReplyApiUrl(turnId) {
  return `/api/voice/replies/${encodeURIComponent(turnId)}/file`;
}

function estimateTokensFromText(text) {
  const s = String(text ?? "").trim();
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}

function analyticsProviderFromVoiceProvider(voiceProviderId) {
  const p = String(voiceProviderId ?? "").trim().toLowerCase();
  if (!p) return "";
  if (p === "openai") return "openai";
  if (p.startsWith("gemini")) return "gemini-flash";
  if (p.startsWith("anthropic")) return "anthropic";
  if (p.startsWith("perplexity")) return "perplexity";
  return "";
}

function recordAuxLlmUsageRow(providerId, requestKind, promptTokens, completionTokens, totalTokens) {
  const pid = String(providerId ?? "").trim();
  const kind = String(requestKind ?? "").trim();
  if (!ANALYTICS_PROVIDER_IDS.includes(pid)) return false;
  if (!AUX_LLM_USAGE_KINDS.has(kind)) return false;
  const pp = Math.max(0, Number(promptTokens) || 0);
  const pc = Math.max(0, Number(completionTokens) || 0);
  const pt = Math.max(0, Number(totalTokens) || pp + pc);
  if (pp === 0 && pc === 0 && pt === 0 && kind !== "optimizer_llm_check") return false;
  applyAnalyticsAuxLlmUsageMigration(db);
  db.prepare(
    `INSERT INTO analytics_aux_llm_usage (id, provider_id, request_kind, llm_prompt_tokens, llm_completion_tokens, llm_total_tokens)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), pid, kind, pp, pc, pt);
  return true;
}

function ensureVoiceRepliesDir() {
  fs.mkdirSync(VOICE_REPLIES_DIR, { recursive: true });
}

/** Dev-only self-test audio under `data/tts-selftest` — safe to remove entirely with multimedia clear. */
const TTS_SELFTEST_DIR = path.join(root, "data", "tts-selftest");

/**
 * Count files and total bytes under a directory (recursive).
 * @param {string} absDir
 */
function countFilesAndBytesRecursive(absDir) {
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(absDir)) return { files, bytes };
  /** @param {string} dir */
  function walk(dir) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          files += 1;
          bytes += Number(fs.statSync(full).size) || 0;
        }
      } catch {
        /* skip */
      }
    }
  }
  walk(absDir);
  return { files, bytes };
}

/**
 * Removes image byte payloads from `user_attachments_json` (keeps names, kinds, `textInline`, etc.).
 * @param {unknown} raw
 * @returns {{ changed: boolean, out: string, bytesRemoved: number }}
 */
function stripImagePayloadsFromUserAttachmentsJson(raw) {
  if (raw == null || String(raw).trim() === "") {
    return { changed: false, out: String(raw ?? ""), bytesRemoved: 0 };
  }
  const rawStr = String(raw);
  let j;
  try {
    j = JSON.parse(rawStr);
  } catch {
    return { changed: false, out: rawStr, bytesRemoved: 0 };
  }
  if (!Array.isArray(j)) return { changed: false, out: rawStr, bytesRemoved: 0 };
  let changed = false;
  let bytesRemoved = 0;
  const next = j.map((x) => {
    if (!x || typeof x !== "object") return x;
    const o = { ...x };
    for (const key of ["imageBase64", "base64"]) {
      if (o[key] == null) continue;
      const s = String(o[key]);
      if (s.length === 0) continue;
      bytesRemoved += Buffer.byteLength(s, "utf8");
      delete o[key];
      changed = true;
    }
    return o;
  });
  if (!changed) return { changed: false, out: rawStr, bytesRemoved: 0 };
  let out;
  try {
    out = JSON.stringify(next);
  } catch {
    return { changed: false, out: rawStr, bytesRemoved: 0 };
  }
  return { changed: true, out, bytesRemoved };
}

/**
 * Strips markdown `![](data:image/...;base64,...)` and bare `data:image/...;base64,...` payloads from a text field.
 * @param {unknown} raw
 * @returns {{ out: string, bytesRemoved: number }}
 */
function stripDataImagePayloadsFromTextField(raw) {
  const s = raw == null ? "" : String(raw);
  if (!s.includes("data:image")) return { out: s, bytesRemoved: 0 };
  const before = Buffer.byteLength(s, "utf8");
  let out = s.replace(
    /!\[[^\]]{0,800}?\]\(\s*data:image\/[a-z0-9.+-]+;base64,[\s\S]*?\)/gi,
    "*[inline image removed]*",
  );
  out = out.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, "");
  const bytesRemoved = Math.max(0, before - Buffer.byteLength(out, "utf8"));
  return { out, bytesRemoved };
}

/**
 * Removes embedded image data from `conversation_turns` while keeping dialog text and attachment metadata.
 * @param {import("better-sqlite3").Database} database
 * @returns {{ turnsUpdated: number, bytesFreed: number }}
 */
function stripEmbeddedMultimediaFromConversationTurns(database) {
  const rows = database
    .prepare(
      `SELECT id, user_text, user_attachments_json, assistant_text, assistant_favorite_markdown
       FROM conversation_turns
       WHERE (user_attachments_json IS NOT NULL AND TRIM(user_attachments_json) != '')
          OR (user_text LIKE '%data:image%')
          OR (assistant_text LIKE '%data:image%')
          OR (assistant_favorite_markdown LIKE '%data:image%')`,
    )
    .all();

  const upd = database.prepare(
    `UPDATE conversation_turns
     SET user_attachments_json = ?, user_text = ?, assistant_text = ?, assistant_favorite_markdown = ?
     WHERE id = ?`,
  );

  let turnsUpdated = 0;
  let bytesFreed = 0;

  const tx = database.transaction(() => {
    for (const row of rows) {
      const id = String(row.id ?? "").trim();
      if (!id) continue;

      let userText = String(row.user_text ?? "");
      let assistantText = row.assistant_text != null ? String(row.assistant_text) : "";
      let favMd = row.assistant_favorite_markdown != null ? String(row.assistant_favorite_markdown) : "";
      let attJson = row.user_attachments_json != null ? String(row.user_attachments_json) : "";

      let rowChanged = false;
      let rowFreed = 0;

      const att = stripImagePayloadsFromUserAttachmentsJson(attJson);
      if (att.changed) {
        const oldB = Buffer.byteLength(attJson, "utf8");
        attJson = att.out;
        rowFreed += Math.max(0, oldB - Buffer.byteLength(attJson, "utf8"));
        rowChanged = true;
      }

      const ut = stripDataImagePayloadsFromTextField(userText);
      if (ut.bytesRemoved > 0) {
        userText = ut.out;
        rowFreed += ut.bytesRemoved;
        rowChanged = true;
      }
      if (!userText.trim() && ut.bytesRemoved > 0) {
        userText = "[Images removed — there was no plain text left.]";
      }
      const at = stripDataImagePayloadsFromTextField(assistantText);
      if (at.bytesRemoved > 0) {
        assistantText = at.out;
        rowFreed += at.bytesRemoved;
        rowChanged = true;
      }
      const fm = stripDataImagePayloadsFromTextField(favMd);
      if (fm.bytesRemoved > 0) {
        favMd = fm.out;
        rowFreed += fm.bytesRemoved;
        rowChanged = true;
      }

      if (!rowChanged) continue;
      const attPayload =
        !attJson || attJson.trim() === "" || attJson === "[]" || attJson === "null" ? null : attJson;
      upd.run(attPayload, userText, assistantText.trim() === "" ? null : assistantText, favMd.trim() === "" ? null : favMd, id);
      turnsUpdated += 1;
      bytesFreed += rowFreed;
    }
  });
  tx();

  return { turnsUpdated, bytesFreed };
}

/**
 * Removes on-disk multimedia cache: voice-reply MP3/WAV and `data/tts-selftest/`.
 * @returns {{ filesRemoved: number, bytesFreed: number }}
 */
function clearProjectMultimediaCacheDiskOnly() {
  let filesRemoved = 0;
  let bytesFreed = 0;

  if (fs.existsSync(VOICE_REPLIES_DIR)) {
    let names;
    try {
      names = fs.readdirSync(VOICE_REPLIES_DIR);
    } catch {
      names = [];
    }
    for (const name of names) {
      const low = String(name).toLowerCase();
      if (!low.endsWith(".mp3") && !low.endsWith(".wav")) continue;
      const fp = path.join(VOICE_REPLIES_DIR, name);
      try {
        const st = fs.statSync(fp);
        if (!st.isFile()) continue;
        const sz = Number(st.size) || 0;
        fs.unlinkSync(fp);
        filesRemoved += 1;
        bytesFreed += sz;
      } catch {
        /* skip */
      }
    }
  }

  if (fs.existsSync(TTS_SELFTEST_DIR)) {
    const pre = countFilesAndBytesRecursive(TTS_SELFTEST_DIR);
    try {
      fs.rmSync(TTS_SELFTEST_DIR, { recursive: true, force: true });
      filesRemoved += pre.files;
      bytesFreed += pre.bytes;
    } catch {
      /* ignore partial failure */
    }
  }

  return { filesRemoved, bytesFreed };
}

/**
 * Disk voice cache + tts self-test, plus embedded image payloads in `conversation_turns` (not plain dialog text).
 * @returns {{ filesRemoved: number, bytesFreed: number, turnsUpdated: number }}
 */
function clearProjectMultimediaCacheFull() {
  const disk = clearProjectMultimediaCacheDiskOnly();
  const dbRes = stripEmbeddedMultimediaFromConversationTurns(db);
  /** Reclaim file space so `mf-lab.sqlite` shrinks on disk (otherwise stats stay huge). */
  let vacuumWarning = "";
  try {
    db.exec("VACUUM");
  } catch (e) {
    vacuumWarning = e instanceof Error ? e.message : String(e);
    console.warn("[mf-lab-api] VACUUM after multimedia clear:", vacuumWarning);
  }
  return {
    filesRemoved: disk.filesRemoved,
    bytesFreed: disk.bytesFreed + dbRes.bytesFreed,
    turnsUpdated: dbRes.turnsUpdated,
    ...(vacuumWarning ? { vacuumWarning } : {}),
  };
}

/**
 * Sum byte size of all regular files under `absDir` (recursive).
 * @param {string} absDir
 * @param {{ skipSqlite?: boolean }} [opts]
 */
function sumDirectoryFileBytesRecursive(absDir, opts = {}) {
  const skipSqlite = Boolean(opts.skipSqlite);
  let total = 0;
  if (!fs.existsSync(absDir)) return 0;
  let st0;
  try {
    st0 = fs.statSync(absDir);
  } catch {
    return 0;
  }
  if (!st0.isDirectory()) return 0;

  /** @param {string} dir */
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          if (skipSqlite && ent.name.toLowerCase().endsWith(".sqlite")) continue;
          const st = fs.statSync(full);
          total += Number(st.size) || 0;
        }
      } catch {
        /* skip unreadable entries */
      }
    }
  }
  walk(absDir);
  return total;
}

/** UTF-8 byte size (matches how JSON/text is stored on disk). */
function utf8ByteLength(s) {
  return Buffer.byteLength(String(s ?? ""), "utf8");
}

function estimateMediaBytesFromAttachmentsJson(raw) {
  if (raw == null || String(raw).trim() === "") return 0;
  let j;
  try {
    j = JSON.parse(String(raw));
  } catch {
    return 0;
  }
  if (!Array.isArray(j)) return 0;
  let sum = 0;
  for (const x of j) {
    if (!x || typeof x !== "object") continue;
    for (const key of ["imageBase64", "base64"]) {
      if (typeof x[key] === "string" && x[key].length > 0) {
        sum += utf8ByteLength(x[key]);
      }
    }
  }
  return sum;
}

const DATA_IMAGE_BASE64_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi;

function estimateDataImageBytesInPlainText(val) {
  const s = val == null ? "" : String(val);
  if (!s.includes("data:image")) return 0;
  let sum = 0;
  let m;
  DATA_IMAGE_BASE64_RE.lastIndex = 0;
  while ((m = DATA_IMAGE_BASE64_RE.exec(s)) !== null) {
    sum += utf8ByteLength(m[0]);
  }
  return sum;
}

/**
 * Embedded media stored in `conversation_turns` only (not Memory graph / other tables).
 * Same image duplicated in JSON and markdown would be counted twice — treat as an upper-bound estimate.
 * @param {import("better-sqlite3").Database} database
 */
function estimateEmbeddedMediaBytesInConversationTurns(database) {
  const stmt = database.prepare(
    `SELECT user_attachments_json, user_text, assistant_text, assistant_favorite_markdown FROM conversation_turns`,
  );
  let total = 0;
  for (const row of stmt.iterate()) {
    total += estimateMediaBytesFromAttachmentsJson(row.user_attachments_json);
    total += estimateDataImageBytesInPlainText(row.user_text);
    total += estimateDataImageBytesInPlainText(row.assistant_text);
    total += estimateDataImageBytesInPlainText(row.assistant_favorite_markdown);
  }
  return total;
}

function getProjectCacheStatsPayload() {
  const dataDir = path.join(root, "data");
  /** JSON caches etc. under `data/` — SQLite files skipped (they are counted separately). */
  const dataDirCacheBytes = sumDirectoryFileBytesRecursive(dataDir, { skipSqlite: true });
  let chatDatabaseBytes = 0;
  try {
    const st = fs.statSync(dbPath);
    if (st.isFile()) chatDatabaseBytes = Number(st.size) || 0;
  } catch {
    /* missing or unreadable */
  }
  let chatEmbeddedMediaBytes = 0;
  try {
    chatEmbeddedMediaBytes = estimateEmbeddedMediaBytesInConversationTurns(db);
  } catch (e) {
    console.warn("[mf-lab-api] estimateEmbeddedMediaBytesInConversationTurns:", e);
  }
  if (chatEmbeddedMediaBytes > chatDatabaseBytes) {
    chatEmbeddedMediaBytes = chatDatabaseBytes;
  }
  const chatDbOtherApproxBytes = Math.max(0, chatDatabaseBytes - chatEmbeddedMediaBytes);
  const soundFilesBytes = sumDirectoryFileBytesRecursive(VOICE_REPLIES_DIR, { skipSqlite: false });
  /** @deprecated Combined total; clients should prefer split fields. */
  const filesAndPicturesBytes = dataDirCacheBytes + chatDatabaseBytes;
  return {
    ok: true,
    filesAndPicturesBytes,
    soundFilesBytes,
    dataDirCacheBytes,
    chatDatabaseBytes,
    chatEmbeddedMediaBytes,
    chatDbOtherApproxBytes,
  };
}

function getAssistantTextForTurnId(turnId) {
  const row = db
    .prepare(`SELECT assistant_text AS assistantText FROM conversation_turns WHERE id = ?`)
    .get(turnId);
  if (!row) {
    throw new Error("Unknown turn id (no row in conversation_turns).");
  }
  const text = String(row?.assistantText ?? "").trim();
  if (!text) throw new Error("Assistant text is empty for this turn.");
  return text;
}

async function synthesizeSpeechMp3BufferWithOpenAi(text, apiKey) {
  const input = String(text ?? "").trim();
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      voice: "alloy",
      response_format: "mp3",
      input,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const msg = String(data?.error?.message ?? "").trim() || `OpenAI TTS failed (${res.status})`;
    throw new Error(msg);
  }
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!buf.length) throw new Error("OpenAI TTS returned empty audio.");
  return buf;
}

/** Same TTS contract as cyprusdiscovery `server/geminiTts.mjs`. */
const GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const GEMINI_TTS_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`;
const GEMINI_TTS_DEFAULT_SAMPLE_RATE = 24000;

/**
 * Gemini TTS returns raw PCM16LE mono; wrap as WAV for ffmpeg.
 * @param {Buffer} pcm
 * @param {number} [sampleRate]
 */
function wrapPcm16leMonoToWav(pcm, sampleRate = GEMINI_TTS_DEFAULT_SAMPLE_RATE) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const subchunk2Size = pcm.length;
  const chunkSize = 36 + subchunk2Size;
  const buf = Buffer.alloc(44 + pcm.length);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(chunkSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(subchunk2Size, 40);
  pcm.copy(buf, 44);
  return buf;
}

/** @param {unknown} part */
function geminiTtsPartInlineAudio(part) {
  if (!part || typeof part !== "object") return null;
  const p = /** @type {{ inlineData?: { data?: string, mimeType?: string }, inline_data?: { data?: string, mime_type?: string } }} */ (
    part
  );
  const inline = p.inlineData ?? p.inline_data;
  if (!inline || typeof inline !== "object") return null;
  const data = inline.data;
  if (typeof data !== "string" || !data) return null;
  const mimeType =
    typeof inline.mimeType === "string" ? inline.mimeType : inline.mime_type;
  return { data, mimeType: String(mimeType || "") };
}

async function synthesizeSpeechWavWithGemini(text, apiKey) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error("Empty text for TTS.");

  const voiceName = String(process.env.GEMINI_TTS_VOICE ?? "").trim() || "Kore";

  const body = {
    contents: [{ parts: [{ text: trimmed }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
    model: GEMINI_TTS_MODEL,
  };

  const res = await fetch(GEMINI_TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": String(apiKey).trim(),
    },
    body: JSON.stringify(body),
  });

  const rawJson = await res.text();
  /** @type {unknown} */
  let data = null;
  try {
    data = rawJson.trim() ? JSON.parse(rawJson) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const errObj = data && typeof data === "object" ? /** @type {{ error?: { message?: string } | string }} */ (data) : null;
    const msg =
      (errObj?.error &&
        String(typeof errObj.error === "object" ? errObj.error.message : errObj.error)) ||
      rawJson.slice(0, 280) ||
      res.statusText;
    throw new Error(`Gemini TTS failed (${res.status}): ${msg}`);
  }

  const parts = /** @type {{ candidates?: Array<{ content?: { parts?: unknown[] } }> }} */ (data)
    ?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new Error("Gemini TTS response missing candidates.");

  let b64 = null;
  let mimeHint = "";
  for (const part of parts) {
    const inline = geminiTtsPartInlineAudio(part);
    if (inline?.data) {
      b64 = inline.data;
      mimeHint = inline.mimeType;
      break;
    }
  }
  if (!b64) throw new Error("Gemini TTS response missing inline audio.");

  const pcm = decodeBase64Audio(b64);
  const rateMatch = /rate=(\d+)/i.exec(mimeHint);
  const sampleRate = rateMatch
    ? Math.max(8000, Math.floor(Number(rateMatch[1]) || GEMINI_TTS_DEFAULT_SAMPLE_RATE))
    : GEMINI_TTS_DEFAULT_SAMPLE_RATE;
  const wav = wrapPcm16leMonoToWav(pcm, sampleRate);
  return { audioBuffer: wav, mimeType: "audio/wav" };
}

function convertWavBufferToMp3File(wavBuffer, wavMimeType, mp3Path) {
  ensureVoiceRepliesDir();
  const ext = wavMimeType.includes("wav") ? "wav" : wavMimeType.split("/")[1] || "audio";
  const tmpIn = path.join(VOICE_REPLIES_DIR, `${crypto.randomUUID()}.${ext}`);
  fs.writeFileSync(tmpIn, wavBuffer);
  try {
    const out = spawnSync(
      "ffmpeg",
      ["-y", "-hide_banner", "-loglevel", "error", "-i", tmpIn, "-vn", "-ar", "44100", "-ac", "2", "-b:a", "192k", mp3Path],
      { encoding: "utf8" },
    );
    if (out.status !== 0) {
      const msg = String(out.stderr || out.stdout || "").trim() || "ffmpeg conversion failed";
      throw new Error(msg);
    }
  } finally {
    try {
      fs.unlinkSync(tmpIn);
    } catch {
      /* ignore */
    }
  }
  const st = fs.statSync(mp3Path);
  if (!st.isFile() || st.size <= 0) throw new Error("MP3 conversion produced empty file.");
}

/**
 * @param {string} turnId
 * @param {{ geminiApiKey?: string, openAiApiKey?: string }} [body] — same pattern as /api/voice/transcribe when keys live in the client only.
 */
async function ensureVoiceReplyMp3ForTurn(turnId, body = {}) {
  const OPENAI_SPEECH_INPUT_MAX = 4096;
  const mp3Path = voiceReplyMp3Path(turnId);
  if (fs.existsSync(mp3Path)) {
    return { mp3Path, providerId: "", created: false };
  }
  const text = getAssistantTextForTurnId(turnId);
  const geminiKey =
    String(process.env.GEMINI_API_KEY ?? "").trim() ||
    String(process.env.GOOGLE_AI_STUDIO_KEY ?? "").trim() ||
    String(body?.geminiApiKey ?? "").trim();
  const openAiKey =
    String(process.env.OPENAI_API_KEY ?? "").trim() || String(body?.openAiApiKey ?? "").trim();
  if (!geminiKey && !openAiKey) {
    throw new Error("Voice playback requires Gemini or ChatGPT key.");
  }

  async function tryOpenAiDirectMp3() {
    const t = String(text ?? "");
    if (t.length > OPENAI_SPEECH_INPUT_MAX) {
      throw new Error(
        `OpenAI speech allows at most ${OPENAI_SPEECH_INPUT_MAX} characters; this reply has ${t.length}. For long replies use Gemini audio (needs ffmpeg) or split the message.`,
      );
    }
    const mp3Buf = await synthesizeSpeechMp3BufferWithOpenAi(text, openAiKey);
    ensureVoiceRepliesDir();
    fs.writeFileSync(mp3Path, mp3Buf);
    return { mp3Path, providerId: "openai", created: true };
  }

  /** @type {Buffer | null} */
  let wavBuffer = null;
  let wavMimeType = "audio/wav";
  let providerId = "";

  if (geminiKey) {
    try {
      const out = await synthesizeSpeechWavWithGemini(text, geminiKey);
      wavBuffer = out.audioBuffer;
      wavMimeType = out.mimeType || "audio/wav";
      providerId = "gemini-3.1-flash-tts";
    } catch (e) {
      if (!openAiKey) throw e;
    }
  }
  if (!wavBuffer && openAiKey) {
    return await tryOpenAiDirectMp3();
  }
  if (!wavBuffer) throw new Error("Voice synthesis failed for available providers.");
  if (normalizeAudioMimeType(wavMimeType).includes("mpeg") || wavMimeType.includes("mp3")) {
    ensureVoiceRepliesDir();
    fs.writeFileSync(mp3Path, wavBuffer);
    return { mp3Path, providerId, created: true };
  }
  try {
    convertWavBufferToMp3File(wavBuffer, wavMimeType, mp3Path);
    return { mp3Path, providerId, created: true };
  } catch (convErr) {
    const hint = convErr instanceof Error ? convErr.message : String(convErr);
    const len = String(text ?? "").length;
    if (openAiKey && len <= OPENAI_SPEECH_INPUT_MAX) {
      try {
        return await tryOpenAiDirectMp3();
      } catch (ttsErr) {
        const t2 = ttsErr instanceof Error ? ttsErr.message : String(ttsErr);
        throw new Error(`${hint} · ChatGPT fallback: ${t2}`);
      }
    }
    if (openAiKey && len > OPENAI_SPEECH_INPUT_MAX) {
      throw new Error(
        `${hint} For replies over ${OPENAI_SPEECH_INPUT_MAX} characters, install ffmpeg so Gemini audio can be converted to MP3 (this reply: ${len} chars).`,
      );
    }
    throw convErr instanceof Error ? convErr : new Error(hint);
  }
}

/** Raw timestamp string from SQLite for the client — YY-MM-DD HH:MM is interpreted in the browser (local time). */
function rawDbTimestamp(value) {
  if (value == null || value === "") return "";
  return String(value);
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

async function getAccessDataDumpEnrichmentPayload() {
  const cached = readAccessDataDumpEnrichmentImportCacheIfPresent(root);
  if (cached) return cached;
  const { entries: entriesRaw } = readAccessExternalServicesPayload();
  return buildAccessDataDumpEnrichmentFromEntries(entriesRaw);
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
  replaceAccessExternalServicesInDatabase(db, body?.entries);
  clearAccessDataDumpEnrichmentImportCache(root);
  return { entries: readAccessExternalServicesPayload().entries };
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

const USER_PROFILE_CONTEXT_MAX_CHARS = 8000;

/** People / "User" blob from the Memory tree (Intro + Keeper) — how to address the person and stated facts. */
function readMemoryGraphUserProfileForContextPack() {
  try {
    ensureMemoryGraphHubAnchorsPresent(db);
  } catch {
    /* ignore */
  }
  try {
    const tbl = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_graph_nodes'`)
      .get();
    if (!tbl) return "";
    const row = db
      .prepare(`SELECT blob FROM memory_graph_nodes WHERE category = ? AND label = ?`)
      .get("People", "User");
    const b = String(row?.blob ?? "").trim();
    if (!b) return "";
    return b.length <= USER_PROFILE_CONTEXT_MAX_CHARS ? b : `${b.slice(0, USER_PROFILE_CONTEXT_MAX_CHARS)}…`;
  } catch {
    return "";
  }
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
  const userAddressingProfile = readMemoryGraphUserProfileForContextPack();
  if (!hasContextTables()) {
    let rulesKeeperVirtual = [];
    try {
      rulesKeeperVirtual = keeperBundleToVirtualContextRules(readRulesKeeperBundlePayload());
    } catch (e) {
      console.warn("[mf-lab-api] rules keeper (no context tables):", e);
    }
    return {
      threadId: dialogId,
      dialogTitle: drow.dialog_title,
      themeTitle: drow.theme_title,
      rules: rulesKeeperVirtual,
      memoryItems: [],
      summaries: [],
      threadMessages: [],
      turns,
      userQuery: userQuery || "",
      userAddressingProfile,
    };
  }
  const rulesDb = db
    .prepare(`SELECT id, rule_type, title, content, priority, tags, is_active FROM rules WHERE is_active = 1`)
    .all();
  let rules = [...rulesDb];
  try {
    rules = [...rules, ...keeperBundleToVirtualContextRules(readRulesKeeperBundlePayload())];
  } catch (e) {
    console.warn("[mf-lab-api] rules keeper bundle:", e);
  }
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
    userAddressingProfile,
  };
}

const RULES_KEEPER_DIR = path.join(root, "rules");
const RULES_KEEPER_SPEC = [
  { key: "core_rules", file: "core_rules.json", rule_type: "keeper3_core", title: "Saved conduct — general" },
  {
    key: "private_rules",
    file: "private_rules.json",
    rule_type: "keeper3_private",
    title: "Saved conduct — personal boundaries",
  },
  {
    key: "forbidden_actions",
    file: "forbidden_actions.json",
    rule_type: "keeper3_forbidden",
    title: "Saved conduct — must not do",
  },
  {
    key: "workflow_rules",
    file: "workflow_rules.json",
    rule_type: "keeper3_workflow",
    title: "Saved conduct — step-by-step habits",
  },
];
const RULES_KEEPER_ITEM_TEXT_MAX = 4000;
const RULES_KEEPER_MAX_ITEMS = 120;

function ensureRulesKeeperDir() {
  if (!fs.existsSync(RULES_KEEPER_DIR)) {
    fs.mkdirSync(RULES_KEEPER_DIR, { recursive: true });
  }
}

function readRulesKeeperItemsFromFile(fileName) {
  ensureRulesKeeperDir();
  const fp = path.join(RULES_KEEPER_DIR, fileName);
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp, `${JSON.stringify({ items: [] }, null, 2)}\n`, "utf8");
    return [];
  }
  let raw;
  try {
    raw = fs.readFileSync(fp, "utf8");
  } catch {
    return [];
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
  /** @type {{ text: string, addedAt: string }[]} */
  const out = [];
  for (const it of arr) {
    const text =
      typeof it === "string"
        ? String(it).trim()
        : String(it?.text ?? it?.content ?? "").trim();
    if (!text) continue;
    const addedAt = typeof it === "object" && it?.addedAt ? String(it.addedAt) : "";
    out.push({
      text: text.slice(0, RULES_KEEPER_ITEM_TEXT_MAX),
      addedAt: addedAt || new Date().toISOString(),
    });
  }
  return out.slice(0, RULES_KEEPER_MAX_ITEMS + 40);
}

function writeRulesKeeperItemsFile(fileName, items) {
  ensureRulesKeeperDir();
  const fp = path.join(RULES_KEEPER_DIR, fileName);
  const trimmed = items.slice(0, RULES_KEEPER_MAX_ITEMS);
  fs.writeFileSync(fp, `${JSON.stringify({ items: trimmed }, null, 2)}\n`, "utf8");
}

function readRulesKeeperBundlePayload() {
  /** @type {Record<string, { text: string, addedAt: string }[]>} */
  const out = {};
  for (const spec of RULES_KEEPER_SPEC) {
    out[spec.key] = readRulesKeeperItemsFromFile(spec.file);
  }
  return out;
}

function normRulesKeeperDedupeKey(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 600);
}

function mergeRulesKeeperItemLists(existing, incoming) {
  const seen = new Set(existing.map((x) => normRulesKeeperDedupeKey(x.text)));
  const now = new Date().toISOString();
  const merged = [...existing];
  for (const it of incoming) {
    const t = String(it.text ?? it).trim().slice(0, RULES_KEEPER_ITEM_TEXT_MAX);
    if (!t) continue;
    const k = normRulesKeeperDedupeKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push({ text: t, addedAt: now });
    if (merged.length >= RULES_KEEPER_MAX_ITEMS) break;
  }
  return merged.slice(-RULES_KEEPER_MAX_ITEMS);
}

/**
 * @param {unknown} body
 * @returns {{ ok: true, merged_total: number } | { error: string, status: number }}
 */
function mergeRulesKeeperPatchFromBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "expected JSON object", status: 400 };
  }
  /** @param {unknown} v */
  const toIncoming = (v) => {
    if (!Array.isArray(v)) return [];
    /** @type {{ text: string }[]} */
    const texts = [];
    for (const x of v) {
      if (typeof x === "string" && x.trim()) texts.push({ text: x.trim() });
      else if (x && typeof x === "object") {
        const t = String(x.text ?? x.rule ?? x.content ?? "").trim();
        if (t) texts.push({ text: t });
      }
    }
    return texts;
  };
  let mergedTotal = 0;
  for (const spec of RULES_KEEPER_SPEC) {
    const incoming = toIncoming(/** @type {Record<string, unknown>} */ (body)[spec.key]);
    if (incoming.length === 0) continue;
    const cur = readRulesKeeperItemsFromFile(spec.file);
    const merged = mergeRulesKeeperItemLists(cur, incoming);
    mergedTotal += Math.max(0, merged.length - cur.length);
    writeRulesKeeperItemsFile(spec.file, merged);
  }
  return { ok: true, merged_total: mergedTotal };
}

/**
 * @param {Record<string, { text: string, addedAt: string }[]>} bundle
 * @returns {Array<{ id: string, rule_type: string, title: string, content: string, priority: string, tags: string, is_active: number }>}
 */
function keeperBundleToVirtualContextRules(bundle) {
  /** @type {Array<{ id: string, rule_type: string, title: string, content: string, priority: string, tags: string, is_active: number }>} */
  const out = [];
  if (!bundle || typeof bundle !== "object") return out;
  for (const spec of RULES_KEEPER_SPEC) {
    const items = Array.isArray(bundle[spec.key]) ? bundle[spec.key] : [];
    if (items.length === 0) continue;
    const lines = items
      .map((it) => {
        const t = String(it.text ?? it).trim();
        return t ? `- ${t}` : "";
      })
      .filter(Boolean);
    if (lines.length === 0) continue;
    const content = lines.join("\n").slice(0, 14000);
    const priority = spec.key === "forbidden_actions" ? "critical" : "high";
    out.push({
      id: `mf0-keeper3-${spec.key}`,
      rule_type: spec.rule_type,
      title: spec.title,
      content,
      priority,
      tags: "[]",
      is_active: 1,
    });
  }
  return out;
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
  applyAnalyticsUsageArchiveMigration(db);
  const dialogs = db.prepare(`SELECT id FROM dialogs WHERE theme_id = ?`).all(id);
  for (const d of dialogs) {
    archiveConversationTurnAggregatesForDialog(String(d.id), "theme_dialog", id);
  }
  db.prepare(`DELETE FROM themes WHERE id = ?`).run(id);
  return { ok: true, deletedThemeId: id };
}

/** @param {"POST" | "DELETE"} via */
function logThemeDeleted(via, themeId) {
  console.log(`[mf-lab-api] theme deleted (${via}): ${themeId}`);
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

/**
 * @param {"intro" | "access" | "rules"} purpose
 * @param {{ themeTitle: string, dialogTitle: string }} spec
 */
function getOrCreatePurposeSession(purpose, spec) {
  applyDialogsPurposeColumn(db);
  applyMemoryGraphMigration(db);
  const row = db
    .prepare(`SELECT d.id AS dialog_id, d.theme_id AS theme_id FROM dialogs d WHERE d.purpose = ? LIMIT 1`)
    .get(purpose);
  if (row) {
    return { themeId: row.theme_id, dialogId: row.dialog_id };
  }
  const themeId = crypto.randomUUID();
  const dialogId = crypto.randomUUID();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO themes (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
      themeId,
      spec.themeTitle,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO dialogs (id, theme_id, title, created_at, updated_at, purpose) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(dialogId, themeId, spec.dialogTitle, now, now, purpose);
  });
  tx();
  return { themeId, dialogId };
}

function getOrCreateIntroSession() {
  return getOrCreatePurposeSession("intro", { themeTitle: "Intro", dialogTitle: "Self profile" });
}

function getOrCreateAccessSession() {
  return getOrCreatePurposeSession("access", { themeTitle: "Access", dialogTitle: "External services" });
}

function getOrCreateRulesSession() {
  return getOrCreatePurposeSession("rules", { themeTitle: "Rules", dialogTitle: "Project rules" });
}

/** RAG / summaries / memory_items mirror for this dialog thread (not conversation_turns). */
function clearThreadDerivedData(dialogId) {
  const did = String(dialogId ?? "").trim();
  if (!did) return;
  const tm = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='thread_messages'`).get();
  if (tm) {
    db.prepare(`DELETE FROM thread_messages WHERE thread_id = ?`).run(did);
  }
  const ts = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='thread_summaries'`).get();
  if (ts) {
    db.prepare(`DELETE FROM thread_summaries WHERE thread_id = ?`).run(did);
  }
  const mi = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_items'`).get();
  if (mi) {
    db.prepare(`DELETE FROM memory_items WHERE thread_id = ?`).run(did);
  }
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
  applyAnalyticsUsageArchiveMigration(db);
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

/** All persisted dialogs (including Intro / Rules / Access) contribute to analytics. */
function analyticsDialogWhereSql(_alias = "d") {
  void _alias;
  return "1";
}

/** Reference USD rates per 1M input/output tokens for analytics estimates. */
const ANALYTICS_USD_PER_MILLION = {
  openai: { input: 2.5, output: 15.0 },
  anthropic: { input: 3.0, output: 15.0 },
  "gemini-flash": { input: 0.5, output: 3.0 },
  perplexity: { input: 2.75, output: 9.0 },
};

/**
 * @param {string} providerId
 * @param {number} promptTokens
 * @param {number} completionTokens
 */
function estimateProviderUsd(providerId, promptTokens, completionTokens) {
  const rate = ANALYTICS_USD_PER_MILLION[providerId];
  if (!rate) return { inputUsd: 0, outputUsd: 0, totalUsd: 0 };
  const inputUsd = ((Number(promptTokens) || 0) / 1_000_000) * rate.input;
  const outputUsd = ((Number(completionTokens) || 0) / 1_000_000) * rate.output;
  return { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd };
}

/**
 * @returns {{
 *   providers: Record<string, { requestsSent: number, responsesOk: number, imageRequests: number, researchRequests: number, webRequests: number, accessRequests: number, tokensPrompt: number, tokensCompletion: number, tokensTotal: number }>,
 *   dailyUsage: Array<{ date: string, byProvider: Record<string, number> }>,
 *   dailyTokens: Array<{ date: string, byProvider: Record<string, number> }>,
 *   dailyLlmTokens: Array<{ date: string, byProvider: Record<string, { prompt: number, completion: number, total: number }> }>,
 *   spendSummary: {
 *     inputUsd: { total: number, last30d: number, last24h: number },
 *     outputUsd: { total: number, last30d: number, last24h: number },
 *     combinedUsd: { total: number, last30d: number, last24h: number }
 *   },
 *   themesCount: number,
 *   dialogsCount: number,
 *   memoryGraph: { nodes: number, edges: number, groups: number }
 * }}
 */
function getAnalyticsPayload() {
  applyAnalyticsUsageArchiveMigration(db);
  applyLlmTokenUsageMigration(db);
  applyAnalyticsAuxLlmUsageMigration(db);
  /** @type {Record<string, { requestsSent: number, responsesOk: number, imageRequests: number, researchRequests: number, webRequests: number, accessRequests: number, tokensPrompt: number, tokensCompletion: number, tokensTotal: number }>} */
  function newProviders() {
    /** @type {Record<string, { requestsSent: number, responsesOk: number, imageRequests: number, researchRequests: number, webRequests: number, accessRequests: number, tokensPrompt: number, tokensCompletion: number, tokensTotal: number }>} */
    const p = {};
    for (const id of ANALYTICS_PROVIDER_IDS) {
      p[id] = {
        requestsSent: 0,
        responsesOk: 0,
        imageRequests: 0,
        researchRequests: 0,
        webRequests: 0,
        accessRequests: 0,
        tokensPrompt: 0,
        tokensCompletion: 0,
        tokensTotal: 0,
      };
    }
    return p;
  }

  const providers = newProviders();
  const providersLast30d = newProviders();
  const providersLast24h = newProviders();
  const auxTbl = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_aux_llm_usage'`)
    .get();

  const aggRows = db
    .prepare(
      `SELECT
         COALESCE(NULLIF(TRIM(t.responding_provider_id), ''), t.requested_provider_id) AS pid,
         COUNT(*) AS requests_sent,
         SUM(CASE WHEN t.assistant_message_at IS NOT NULL AND IFNULL(t.assistant_error, 0) = 0 THEN 1 ELSE 0 END) AS responses_ok,
         SUM(CASE WHEN t.request_type = 'image' THEN 1 ELSE 0 END) AS image_requests,
         SUM(CASE WHEN t.request_type = 'research' THEN 1 ELSE 0 END) AS research_requests,
         SUM(CASE WHEN t.request_type = 'web' THEN 1 ELSE 0 END) AS web_requests,
         SUM(CASE WHEN t.request_type = 'access_data' THEN 1 ELSE 0 END) AS access_requests,
         SUM(COALESCE(t.llm_prompt_tokens, 0)) AS tokens_prompt,
         SUM(COALESCE(t.llm_completion_tokens, 0)) AS tokens_completion,
         SUM(COALESCE(t.llm_total_tokens, 0)) AS tokens_total
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
    providers[pid].tokensPrompt = Number(row.tokens_prompt) || 0;
    providers[pid].tokensCompletion = Number(row.tokens_completion) || 0;
    providers[pid].tokensTotal = Number(row.tokens_total) || 0;
  }

  const conversationAggForRange = (sinceExpr) =>
    db
      .prepare(
        `SELECT
           COALESCE(NULLIF(TRIM(t.responding_provider_id), ''), t.requested_provider_id) AS pid,
           COUNT(*) AS requests_sent,
           SUM(CASE WHEN t.assistant_message_at IS NOT NULL AND IFNULL(t.assistant_error, 0) = 0 THEN 1 ELSE 0 END) AS responses_ok,
           SUM(CASE WHEN t.request_type = 'image' THEN 1 ELSE 0 END) AS image_requests,
           SUM(CASE WHEN t.request_type = 'research' THEN 1 ELSE 0 END) AS research_requests,
           SUM(CASE WHEN t.request_type = 'web' THEN 1 ELSE 0 END) AS web_requests,
           SUM(CASE WHEN t.request_type = 'access_data' THEN 1 ELSE 0 END) AS access_requests,
           SUM(COALESCE(t.llm_prompt_tokens, 0)) AS tokens_prompt,
           SUM(COALESCE(t.llm_completion_tokens, 0)) AS tokens_completion,
           SUM(COALESCE(t.llm_total_tokens, 0)) AS tokens_total
         FROM conversation_turns t
         INNER JOIN dialogs d ON d.id = t.dialog_id
         WHERE ${analyticsDialogWhereSql("d")} AND DATETIME(t.user_message_at) >= ${sinceExpr}
         GROUP BY pid`,
      )
      .all();

  for (const row of conversationAggForRange("DATETIME('now', '-30 days')")) {
    const pid = String(row.pid ?? "").trim();
    if (!providersLast30d[pid]) continue;
    providersLast30d[pid].requestsSent = Number(row.requests_sent) || 0;
    providersLast30d[pid].responsesOk = Number(row.responses_ok) || 0;
    providersLast30d[pid].imageRequests = Number(row.image_requests) || 0;
    providersLast30d[pid].researchRequests = Number(row.research_requests) || 0;
    providersLast30d[pid].webRequests = Number(row.web_requests) || 0;
    providersLast30d[pid].accessRequests = Number(row.access_requests) || 0;
    providersLast30d[pid].tokensPrompt = Number(row.tokens_prompt) || 0;
    providersLast30d[pid].tokensCompletion = Number(row.tokens_completion) || 0;
    providersLast30d[pid].tokensTotal = Number(row.tokens_total) || 0;
  }

  for (const row of conversationAggForRange("DATETIME('now', '-24 hours')")) {
    const pid = String(row.pid ?? "").trim();
    if (!providersLast24h[pid]) continue;
    providersLast24h[pid].requestsSent = Number(row.requests_sent) || 0;
    providersLast24h[pid].responsesOk = Number(row.responses_ok) || 0;
    providersLast24h[pid].imageRequests = Number(row.image_requests) || 0;
    providersLast24h[pid].researchRequests = Number(row.research_requests) || 0;
    providersLast24h[pid].webRequests = Number(row.web_requests) || 0;
    providersLast24h[pid].accessRequests = Number(row.access_requests) || 0;
    providersLast24h[pid].tokensPrompt = Number(row.tokens_prompt) || 0;
    providersLast24h[pid].tokensCompletion = Number(row.tokens_completion) || 0;
    providersLast24h[pid].tokensTotal = Number(row.tokens_total) || 0;
  }

  const archTbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_usage_archive'`).get();
  let archHasTokens = false;
  if (archTbl) {
    const archCols = db.prepare(`PRAGMA table_info(analytics_usage_archive)`).all();
    archHasTokens = archCols.some((c) => c.name === "tokens_total");
    const archAgg = db
      .prepare(
        archHasTokens
          ? `SELECT
           provider_id AS pid,
           SUM(turn_count) AS requests_sent,
           SUM(responses_ok) AS responses_ok,
           SUM(CASE WHEN request_type = 'image' THEN turn_count ELSE 0 END) AS image_requests,
           SUM(CASE WHEN request_type = 'research' THEN turn_count ELSE 0 END) AS research_requests,
           SUM(CASE WHEN request_type = 'web' THEN turn_count ELSE 0 END) AS web_requests,
           SUM(CASE WHEN request_type = 'access_data' THEN turn_count ELSE 0 END) AS access_requests,
           SUM(tokens_prompt) AS tokens_prompt,
           SUM(tokens_completion) AS tokens_completion,
           SUM(tokens_total) AS tokens_total
         FROM analytics_usage_archive
         GROUP BY pid`
          : `SELECT
           provider_id AS pid,
           SUM(turn_count) AS requests_sent,
           SUM(responses_ok) AS responses_ok,
           SUM(CASE WHEN request_type = 'image' THEN turn_count ELSE 0 END) AS image_requests,
           SUM(CASE WHEN request_type = 'research' THEN turn_count ELSE 0 END) AS research_requests,
           SUM(CASE WHEN request_type = 'web' THEN turn_count ELSE 0 END) AS web_requests,
           SUM(CASE WHEN request_type = 'access_data' THEN turn_count ELSE 0 END) AS access_requests
         FROM analytics_usage_archive
         GROUP BY pid`,
      )
      .all();
    for (const row of archAgg) {
      const pid = String(row.pid ?? "").trim();
      if (!providers[pid]) continue;
      providers[pid].requestsSent += Number(row.requests_sent) || 0;
      providers[pid].responsesOk += Number(row.responses_ok) || 0;
      providers[pid].imageRequests += Number(row.image_requests) || 0;
      providers[pid].researchRequests += Number(row.research_requests) || 0;
      providers[pid].webRequests += Number(row.web_requests) || 0;
      providers[pid].accessRequests += Number(row.access_requests) || 0;
      if (archHasTokens) {
        providers[pid].tokensPrompt += Number(row.tokens_prompt) || 0;
        providers[pid].tokensCompletion += Number(row.tokens_completion) || 0;
        providers[pid].tokensTotal += Number(row.tokens_total) || 0;
      }
    }

    const archAggLast30d = db
      .prepare(
        archHasTokens
          ? `SELECT
             provider_id AS pid,
             SUM(turn_count) AS requests_sent,
             SUM(responses_ok) AS responses_ok,
             SUM(CASE WHEN request_type = 'image' THEN turn_count ELSE 0 END) AS image_requests,
             SUM(CASE WHEN request_type = 'research' THEN turn_count ELSE 0 END) AS research_requests,
             SUM(CASE WHEN request_type = 'web' THEN turn_count ELSE 0 END) AS web_requests,
             SUM(CASE WHEN request_type = 'access_data' THEN turn_count ELSE 0 END) AS access_requests,
             SUM(tokens_prompt) AS tokens_prompt,
             SUM(tokens_completion) AS tokens_completion,
             SUM(tokens_total) AS tokens_total
           FROM analytics_usage_archive
           WHERE datetime(archived_at) >= datetime('now', '-30 days')
           GROUP BY pid`
          : `SELECT
             provider_id AS pid,
             SUM(turn_count) AS requests_sent,
             SUM(responses_ok) AS responses_ok,
             SUM(CASE WHEN request_type = 'image' THEN turn_count ELSE 0 END) AS image_requests,
             SUM(CASE WHEN request_type = 'research' THEN turn_count ELSE 0 END) AS research_requests,
             SUM(CASE WHEN request_type = 'web' THEN turn_count ELSE 0 END) AS web_requests,
             SUM(CASE WHEN request_type = 'access_data' THEN turn_count ELSE 0 END) AS access_requests
           FROM analytics_usage_archive
           WHERE datetime(archived_at) >= datetime('now', '-30 days')
           GROUP BY pid`,
      )
      .all();

    for (const row of archAggLast30d) {
      const pid = String(row.pid ?? "").trim();
      if (!providersLast30d[pid]) continue;
      providersLast30d[pid].requestsSent += Number(row.requests_sent) || 0;
      providersLast30d[pid].responsesOk += Number(row.responses_ok) || 0;
      providersLast30d[pid].imageRequests += Number(row.image_requests) || 0;
      providersLast30d[pid].researchRequests += Number(row.research_requests) || 0;
      providersLast30d[pid].webRequests += Number(row.web_requests) || 0;
      providersLast30d[pid].accessRequests += Number(row.access_requests) || 0;
      if (archHasTokens) {
        providersLast30d[pid].tokensPrompt += Number(row.tokens_prompt) || 0;
        providersLast30d[pid].tokensCompletion += Number(row.tokens_completion) || 0;
        providersLast30d[pid].tokensTotal += Number(row.tokens_total) || 0;
      }
    }

    const archAggLast24h = db
      .prepare(
        archHasTokens
          ? `SELECT
             provider_id AS pid,
             SUM(turn_count) AS requests_sent,
             SUM(responses_ok) AS responses_ok,
             SUM(CASE WHEN request_type = 'image' THEN turn_count ELSE 0 END) AS image_requests,
             SUM(CASE WHEN request_type = 'research' THEN turn_count ELSE 0 END) AS research_requests,
             SUM(CASE WHEN request_type = 'web' THEN turn_count ELSE 0 END) AS web_requests,
             SUM(CASE WHEN request_type = 'access_data' THEN turn_count ELSE 0 END) AS access_requests,
             SUM(tokens_prompt) AS tokens_prompt,
             SUM(tokens_completion) AS tokens_completion,
             SUM(tokens_total) AS tokens_total
           FROM analytics_usage_archive
           WHERE datetime(archived_at) >= datetime('now', '-24 hours')
           GROUP BY pid`
          : `SELECT
             provider_id AS pid,
             SUM(turn_count) AS requests_sent,
             SUM(responses_ok) AS responses_ok,
             SUM(CASE WHEN request_type = 'image' THEN turn_count ELSE 0 END) AS image_requests,
             SUM(CASE WHEN request_type = 'research' THEN turn_count ELSE 0 END) AS research_requests,
             SUM(CASE WHEN request_type = 'web' THEN turn_count ELSE 0 END) AS web_requests,
             SUM(CASE WHEN request_type = 'access_data' THEN turn_count ELSE 0 END) AS access_requests
           FROM analytics_usage_archive
           WHERE datetime(archived_at) >= datetime('now', '-24 hours')
           GROUP BY pid`,
      )
      .all();

    for (const row of archAggLast24h) {
      const pid = String(row.pid ?? "").trim();
      if (!providersLast24h[pid]) continue;
      providersLast24h[pid].requestsSent += Number(row.requests_sent) || 0;
      providersLast24h[pid].responsesOk += Number(row.responses_ok) || 0;
      providersLast24h[pid].imageRequests += Number(row.image_requests) || 0;
      providersLast24h[pid].researchRequests += Number(row.research_requests) || 0;
      providersLast24h[pid].webRequests += Number(row.web_requests) || 0;
      providersLast24h[pid].accessRequests += Number(row.access_requests) || 0;
      if (archHasTokens) {
        providersLast24h[pid].tokensPrompt += Number(row.tokens_prompt) || 0;
        providersLast24h[pid].tokensCompletion += Number(row.tokens_completion) || 0;
        providersLast24h[pid].tokensTotal += Number(row.tokens_total) || 0;
      }
    }
  }

  if (auxTbl) {
    const auxTokAgg = db
      .prepare(
        `SELECT provider_id AS pid,
            SUM(COALESCE(llm_prompt_tokens, 0)) AS tokens_prompt,
            SUM(COALESCE(llm_completion_tokens, 0)) AS tokens_completion,
            SUM(COALESCE(llm_total_tokens, 0)) AS tokens_total
          FROM analytics_aux_llm_usage
          GROUP BY provider_id`,
      )
      .all();
    for (const row of auxTokAgg) {
      const pid = String(row.pid ?? "").trim();
      if (!providers[pid]) continue;
      providers[pid].tokensPrompt += Number(row.tokens_prompt) || 0;
      providers[pid].tokensCompletion += Number(row.tokens_completion) || 0;
      providers[pid].tokensTotal += Number(row.tokens_total) || 0;
    }

    const auxTokAggLast30d = db
      .prepare(
        `SELECT provider_id AS pid,
           SUM(COALESCE(llm_prompt_tokens, 0)) AS tokens_prompt,
           SUM(COALESCE(llm_completion_tokens, 0)) AS tokens_completion,
           SUM(COALESCE(llm_total_tokens, 0)) AS tokens_total
         FROM analytics_aux_llm_usage
         WHERE datetime(created_at) >= datetime('now', '-30 days')
         GROUP BY provider_id`,
      )
      .all();

    for (const row of auxTokAggLast30d) {
      const pid = String(row.pid ?? "").trim();
      if (!providersLast30d[pid]) continue;
      providersLast30d[pid].tokensPrompt += Number(row.tokens_prompt) || 0;
      providersLast30d[pid].tokensCompletion += Number(row.tokens_completion) || 0;
      providersLast30d[pid].tokensTotal += Number(row.tokens_total) || 0;
    }

    const auxTokAggLast24h = db
      .prepare(
        `SELECT provider_id AS pid,
           SUM(COALESCE(llm_prompt_tokens, 0)) AS tokens_prompt,
           SUM(COALESCE(llm_completion_tokens, 0)) AS tokens_completion,
           SUM(COALESCE(llm_total_tokens, 0)) AS tokens_total
         FROM analytics_aux_llm_usage
         WHERE datetime(created_at) >= datetime('now', '-24 hours')
         GROUP BY provider_id`,
      )
      .all();

    for (const row of auxTokAggLast24h) {
      const pid = String(row.pid ?? "").trim();
      if (!providersLast24h[pid]) continue;
      providersLast24h[pid].tokensPrompt += Number(row.tokens_prompt) || 0;
      providersLast24h[pid].tokensCompletion += Number(row.tokens_completion) || 0;
      providersLast24h[pid].tokensTotal += Number(row.tokens_total) || 0;
    }

    const auxReqAgg = db
      .prepare(
        `SELECT provider_id AS pid, COUNT(*) AS cnt
         FROM analytics_aux_llm_usage
         GROUP BY provider_id`,
      )
      .all();
    for (const row of auxReqAgg) {
      const pid = String(row.pid ?? "").trim();
      if (!providers[pid]) continue;
      const n = Number(row.cnt) || 0;
      providers[pid].requestsSent += n;
      providers[pid].responsesOk += n;
    }
    const auxReqAggLast30d = db
      .prepare(
        `SELECT provider_id AS pid, COUNT(*) AS cnt
         FROM analytics_aux_llm_usage
         WHERE datetime(created_at) >= datetime('now', '-30 days')
         GROUP BY provider_id`,
      )
      .all();
    for (const row of auxReqAggLast30d) {
      const pid = String(row.pid ?? "").trim();
      if (!providersLast30d[pid]) continue;
      const n = Number(row.cnt) || 0;
      providersLast30d[pid].requestsSent += n;
      providersLast30d[pid].responsesOk += n;
    }
    const auxReqAggLast24h = db
      .prepare(
        `SELECT provider_id AS pid, COUNT(*) AS cnt
         FROM analytics_aux_llm_usage
         WHERE datetime(created_at) >= datetime('now', '-24 hours')
         GROUP BY provider_id`,
      )
      .all();
    for (const row of auxReqAggLast24h) {
      const pid = String(row.pid ?? "").trim();
      if (!providersLast24h[pid]) continue;
      const n = Number(row.cnt) || 0;
      providersLast24h[pid].requestsSent += n;
      providersLast24h[pid].responsesOk += n;
    }
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

  if (archTbl) {
    const archDays = db
      .prepare(
        `SELECT
           DATE(archived_at) AS day,
           provider_id AS pid,
           SUM(turn_count) AS cnt
         FROM analytics_usage_archive
         WHERE datetime(archived_at) >= datetime('now', '-30 days')
         GROUP BY day, pid`,
      )
      .all();
    for (const r of archDays) {
      const day = String(r.day ?? "").trim();
      const pid = String(r.pid ?? "").trim();
      if (!day || !ANALYTICS_PROVIDER_IDS.includes(pid)) continue;
      if (!dayMap.has(day)) {
        const o = {};
        for (const id of ANALYTICS_PROVIDER_IDS) o[id] = 0;
        dayMap.set(day, o);
      }
      const cur = dayMap.get(day)[pid] || 0;
      dayMap.get(day)[pid] = cur + (Number(r.cnt) || 0);
    }
  }

  if (auxTbl) {
    const auxDayReq = db
      .prepare(
        `SELECT DATE(created_at) AS day, provider_id AS pid, COUNT(*) AS cnt
         FROM analytics_aux_llm_usage
         WHERE datetime(created_at) >= datetime('now', '-30 days')
         GROUP BY day, pid`,
      )
      .all();
    for (const r of auxDayReq) {
      const day = String(r.day ?? "").trim();
      const pid = String(r.pid ?? "").trim();
      if (!day || !ANALYTICS_PROVIDER_IDS.includes(pid)) continue;
      if (!dayMap.has(day)) {
        const o = {};
        for (const id of ANALYTICS_PROVIDER_IDS) o[id] = 0;
        dayMap.set(day, o);
      }
      const cur = dayMap.get(day)[pid] || 0;
      dayMap.get(day)[pid] = cur + (Number(r.cnt) || 0);
    }
  }

  const dayTokenRows = db
    .prepare(
      `SELECT
         DATE(t.user_message_at) AS day,
         COALESCE(NULLIF(TRIM(t.responding_provider_id), ''), t.requested_provider_id) AS pid,
         SUM(COALESCE(t.llm_prompt_tokens, 0)) AS psum,
         SUM(COALESCE(t.llm_completion_tokens, 0)) AS csum,
         SUM(COALESCE(t.llm_total_tokens, 0)) AS tsum
       FROM conversation_turns t
       INNER JOIN dialogs d ON d.id = t.dialog_id
       WHERE ${analyticsDialogWhereSql("d")}
         AND DATETIME(t.user_message_at) >= DATETIME('now', '-30 days')
       GROUP BY day, pid`,
    )
    .all();

  /** @type {Map<string, Record<string, { prompt: number, completion: number, total: number }>>} */
  const dayTokenDetailMap = new Map();

  function emptyDayTokenDetailRow() {
    const o = {};
    for (const id of ANALYTICS_PROVIDER_IDS) o[id] = { prompt: 0, completion: 0, total: 0 };
    return o;
  }

  function addDayTokenDetail(day, pid, p, c, t) {
    if (!day || !ANALYTICS_PROVIDER_IDS.includes(pid)) return;
    if (!dayTokenDetailMap.has(day)) dayTokenDetailMap.set(day, emptyDayTokenDetailRow());
    const row = dayTokenDetailMap.get(day)[pid];
    if (!row) return;
    row.prompt += Number(p) || 0;
    row.completion += Number(c) || 0;
    row.total += Number(t) || 0;
  }

  for (const r of dayTokenRows) {
    addDayTokenDetail(String(r.day ?? "").trim(), String(r.pid ?? "").trim(), r.psum, r.csum, r.tsum);
  }

  if (archTbl && archHasTokens) {
    const archTokDays = db
      .prepare(
        `SELECT
           DATE(archived_at) AS day,
           provider_id AS pid,
           SUM(tokens_prompt) AS psum,
           SUM(tokens_completion) AS csum,
           SUM(tokens_total) AS tsum
         FROM analytics_usage_archive
         WHERE datetime(archived_at) >= datetime('now', '-30 days')
         GROUP BY day, pid`,
      )
      .all();
    for (const r of archTokDays) {
      addDayTokenDetail(String(r.day ?? "").trim(), String(r.pid ?? "").trim(), r.psum, r.csum, r.tsum);
    }
  }

  if (auxTbl) {
    const auxTokDays = db
      .prepare(
        `SELECT DATE(created_at) AS day, provider_id AS pid,
            SUM(COALESCE(llm_prompt_tokens, 0)) AS psum,
            SUM(COALESCE(llm_completion_tokens, 0)) AS csum,
            SUM(COALESCE(llm_total_tokens, 0)) AS tsum
          FROM analytics_aux_llm_usage
          WHERE datetime(created_at) >= datetime('now', '-30 days')
          GROUP BY day, pid`,
      )
      .all();
    for (const r of auxTokDays) {
      addDayTokenDetail(String(r.day ?? "").trim(), String(r.pid ?? "").trim(), r.psum, r.csum, r.tsum);
    }
  }

  const dailyUsage = [];
  /** @type {Array<{ date: string, byProvider: Record<string, number> }>} */
  const dailyTokens = [];
  /** @type {Array<{ date: string, byProvider: Record<string, { prompt: number, completion: number, total: number }> }>} */
  const dailyLlmTokens = [];
  for (let i = 29; i >= 0; i -= 1) {
    const row = db.prepare(`SELECT DATE(DATETIME('now', ?)) AS d`).get(`-${i} days`);
    const day = String(row?.d ?? "").trim();
    const byProvider = dayMap.get(day) ?? Object.fromEntries(ANALYTICS_PROVIDER_IDS.map((id) => [id, 0]));
    dailyUsage.push({ date: day, byProvider: { ...byProvider } });
    const det = dayTokenDetailMap.get(day) ?? emptyDayTokenDetailRow();
    const byTok = {};
    const byDetail = {};
    for (const id of ANALYTICS_PROVIDER_IDS) {
      const x = det[id] || { prompt: 0, completion: 0, total: 0 };
      byTok[id] = Number(x.total) || 0;
      byDetail[id] = { prompt: Number(x.prompt) || 0, completion: Number(x.completion) || 0, total: Number(x.total) || 0 };
    }
    dailyTokens.push({ date: day, byProvider: { ...byTok } });
    dailyLlmTokens.push({ date: day, byProvider: byDetail });
  }

  const spendSummary = {
    inputUsd: { total: 0, last30d: 0, last24h: 0 },
    outputUsd: { total: 0, last30d: 0, last24h: 0 },
    combinedUsd: { total: 0, last30d: 0, last24h: 0 },
  };

  for (const id of ANALYTICS_PROVIDER_IDS) {
    const p = providers[id] || { tokensPrompt: 0, tokensCompletion: 0 };
    const est = estimateProviderUsd(id, p.tokensPrompt, p.tokensCompletion);
    spendSummary.inputUsd.total += est.inputUsd;
    spendSummary.outputUsd.total += est.outputUsd;
    spendSummary.combinedUsd.total += est.totalUsd;
  }

  for (const day of dailyLlmTokens) {
    const byProvider = day?.byProvider && typeof day.byProvider === "object" ? day.byProvider : {};
    for (const id of ANALYTICS_PROVIDER_IDS) {
      const cell = byProvider[id] && typeof byProvider[id] === "object" ? byProvider[id] : {};
      const est = estimateProviderUsd(id, Number(cell.prompt) || 0, Number(cell.completion) || 0);
      spendSummary.inputUsd.last30d += est.inputUsd;
      spendSummary.outputUsd.last30d += est.outputUsd;
      spendSummary.combinedUsd.last30d += est.totalUsd;
    }
  }

  /** @type {Record<string, { prompt: number, completion: number }>} */
  const last24hByProvider = Object.fromEntries(
    ANALYTICS_PROVIDER_IDS.map((id) => [id, { prompt: 0, completion: 0 }]),
  );
  const live24h = db
    .prepare(
      `SELECT
         COALESCE(NULLIF(TRIM(t.responding_provider_id), ''), t.requested_provider_id) AS pid,
         SUM(COALESCE(t.llm_prompt_tokens, 0)) AS psum,
         SUM(COALESCE(t.llm_completion_tokens, 0)) AS csum
       FROM conversation_turns t
       INNER JOIN dialogs d ON d.id = t.dialog_id
       WHERE ${analyticsDialogWhereSql("d")}
         AND DATETIME(t.user_message_at) >= DATETIME('now', '-24 hours')
       GROUP BY pid`,
    )
    .all();
  for (const r of live24h) {
    const pid = String(r.pid ?? "").trim();
    if (!last24hByProvider[pid]) continue;
    last24hByProvider[pid].prompt += Number(r.psum) || 0;
    last24hByProvider[pid].completion += Number(r.csum) || 0;
  }
  if (archTbl && archHasTokens) {
    const arch24h = db
      .prepare(
        `SELECT
           provider_id AS pid,
           SUM(COALESCE(tokens_prompt, 0)) AS psum,
           SUM(COALESCE(tokens_completion, 0)) AS csum
         FROM analytics_usage_archive
         WHERE DATETIME(archived_at) >= DATETIME('now', '-24 hours')
         GROUP BY pid`,
      )
      .all();
    for (const r of arch24h) {
      const pid = String(r.pid ?? "").trim();
      if (!last24hByProvider[pid]) continue;
      last24hByProvider[pid].prompt += Number(r.psum) || 0;
      last24hByProvider[pid].completion += Number(r.csum) || 0;
    }
  }
  if (auxTbl) {
    const aux24h = db
      .prepare(
        `SELECT
           provider_id AS pid,
           SUM(COALESCE(llm_prompt_tokens, 0)) AS psum,
           SUM(COALESCE(llm_completion_tokens, 0)) AS csum
         FROM analytics_aux_llm_usage
         WHERE DATETIME(created_at) >= DATETIME('now', '-24 hours')
         GROUP BY pid`,
      )
      .all();
    for (const r of aux24h) {
      const pid = String(r.pid ?? "").trim();
      if (!last24hByProvider[pid]) continue;
      last24hByProvider[pid].prompt += Number(r.psum) || 0;
      last24hByProvider[pid].completion += Number(r.csum) || 0;
    }
  }
  for (const id of ANALYTICS_PROVIDER_IDS) {
    const cell = last24hByProvider[id] || { prompt: 0, completion: 0 };
    const est = estimateProviderUsd(id, cell.prompt, cell.completion);
    spendSummary.inputUsd.last24h += est.inputUsd;
    spendSummary.outputUsd.last24h += est.outputUsd;
    spendSummary.combinedUsd.last24h += est.totalUsd;
  }

  const themesRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM themes WHERE id NOT IN (
         SELECT DISTINCT theme_id FROM dialogs WHERE IFNULL(purpose, '') IN ('intro', 'access', 'rules')
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
    providersByRange: {
      all: providers,
      last30d: providersLast30d,
      last24h: providersLast24h,
    },
    dailyUsage,
    dailyTokens,
    dailyLlmTokens,
    spendSummary,
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

    if (req.method === "POST" && p === "/api/attachments/extract") {
      try {
        const body = await readBody(req);
        const filename = String(body?.filename ?? "").trim();
        const mimeType = String(body?.mimeType ?? "").trim();
        const base64 = String(body?.base64 ?? "").trim();
        if (!filename || !base64) {
          return json(res, 400, apiErrorBody("filename and base64 are required"));
        }
        const out = await extractAttachmentText({ filename, mimeType, base64 });
        return json(res, 200, { ok: true, ...out });
      } catch (e) {
        return json(res, 400, apiErrorBody(e instanceof Error ? e.message : String(e)));
      }
    }

    if (req.method === "POST" && p === "/api/voice/transcribe") {
      try {
        const body = await readBody(req);
        const audioBuffer = decodeBase64Audio(body?.audioBase64);
        const mimeType = normalizeAudioMimeType(body?.mimeType);
        const out = await transcribeVoiceFromEnv(audioBuffer, mimeType, body);
        try {
          const pid = analyticsProviderFromVoiceProvider(out.providerId);
          const completionTokens = estimateTokensFromText(out.text);
          const promptTokens = 0;
          const totalTokens = completionTokens;
          recordAuxLlmUsageRow(pid, "voice_transcription", promptTokens, completionTokens, totalTokens);
        } catch (e) {
          console.warn("[mf-lab-api] voice_transcription analytics:", e);
        }
        return json(res, 200, { ok: true, providerId: out.providerId, text: out.text });
      } catch (e) {
        return json(res, 400, apiErrorBody(e instanceof Error ? e.message : String(e)));
      }
    }

    const voiceReplyFileMatch = p.match(/^\/api\/voice\/replies\/([^/]+)\/file$/);
    if (req.method === "GET" && voiceReplyFileMatch) {
      try {
        const turnId = sanitizeTurnIdForVoiceFile(decodeURIComponent(voiceReplyFileMatch[1]));
        const mp3Path = voiceReplyMp3Path(turnId);
        if (!fs.existsSync(mp3Path)) {
          return json(res, 404, apiErrorBody("Voice reply not found."));
        }
        const stat = fs.statSync(mp3Path);
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Content-Length": stat.size,
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        fs.createReadStream(mp3Path).pipe(res);
        return;
      } catch (e) {
        return json(res, 400, apiErrorBody(e instanceof Error ? e.message : String(e)));
      }
    }

    const voiceReplyMatch = p.match(/^\/api\/voice\/replies\/([^/]+)$/);
    if (voiceReplyMatch) {
      try {
        const turnId = sanitizeTurnIdForVoiceFile(decodeURIComponent(voiceReplyMatch[1]));
        if (req.method === "GET") {
          const mp3Path = voiceReplyMp3Path(turnId);
          const exists = fs.existsSync(mp3Path);
          return json(res, 200, {
            ok: true,
            turnId,
            exists,
            url: exists ? voiceReplyApiUrl(turnId) : "",
          });
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const out = await ensureVoiceReplyMp3ForTurn(turnId, body);
          if (out.created && out.providerId) {
            try {
              const pid = analyticsProviderFromVoiceProvider(out.providerId);
              const promptTokens = estimateTokensFromText(getAssistantTextForTurnId(turnId));
              const completionTokens = 0;
              const totalTokens = promptTokens;
              recordAuxLlmUsageRow(pid, "voice_reply_tts", promptTokens, completionTokens, totalTokens);
            } catch (e) {
              console.warn("[mf-lab-api] voice_reply_tts analytics:", e);
            }
          }
          return json(res, 200, {
            ok: true,
            turnId,
            exists: true,
            created: out.created,
            providerId: out.providerId,
            url: voiceReplyApiUrl(turnId),
          });
        }
      } catch (e) {
        return json(res, 400, apiErrorBody(e instanceof Error ? e.message : String(e)));
      }
    }

    if (req.method === "GET" && p === "/api/intro/session") {
      const s = getOrCreateIntroSession();
      return json(res, 200, { ok: true, themeId: s.themeId, dialogId: s.dialogId });
    }

    if (req.method === "GET" && p === "/api/access/session") {
      const s = getOrCreateAccessSession();
      return json(res, 200, { ok: true, themeId: s.themeId, dialogId: s.dialogId });
    }

    if (req.method === "GET" && p === "/api/rules/session") {
      const s = getOrCreateRulesSession();
      return json(res, 200, { ok: true, themeId: s.themeId, dialogId: s.dialogId });
    }

    if (req.method === "GET" && p === "/api/rules/keeper-files") {
      try {
        const bundle = readRulesKeeperBundlePayload();
        return json(res, 200, { ok: true, ...bundle });
      } catch (e) {
        console.error("[mf-lab-api] rules/keeper-files:", e);
        return json(res, 500, apiErrorBody(e instanceof Error ? e.message : String(e)));
      }
    }

    if (req.method === "PUT" && p === "/api/rules/keeper-merge") {
      const body = await readBody(req);
      const out = mergeRulesKeeperPatchFromBody(body);
      if ("error" in out) {
        return json(res, out.status, apiErrorBody(out.error));
      }
      return json(res, 200, { ok: true, merged_total: out.merged_total });
    }

    if (req.method === "GET" && p === "/api/access/external-services") {
      return json(res, 200, { ok: true, ...readAccessExternalServicesPayload() });
    }

    if (req.method === "GET" && p === "/api/access/external-services/catalog") {
      return json(res, 200, { ok: true, ...readAccessExternalServicesCatalogPayload() });
    }

    if (req.method === "GET" && p === "/api/settings/ai-model-lists-cache") {
      return json(res, 200, { ok: true, cache: readAiModelListsCachePayload() });
    }

    if (req.method === "PUT" && p === "/api/settings/ai-model-lists-cache") {
      try {
        const body = await readBody(req);
        const cache = writeAiModelListsCachePayload(body);
        return json(res, 200, { ok: true, cache });
      } catch (e) {
        return json(res, 400, apiErrorBody(e instanceof Error ? e.message : String(e)));
      }
    }

    if (req.method === "GET" && p === "/api/settings/project-cache-stats") {
      return json(res, 200, getProjectCacheStatsPayload());
    }

    if (req.method === "POST" && p === "/api/settings/project-cache-clear-multimedia") {
      try {
        const out = clearProjectMultimediaCacheFull();
        return json(res, 200, { ok: true, ...out });
      } catch (e) {
        return json(res, 500, apiErrorBody(e instanceof Error ? e.message : String(e)));
      }
    }

    if (req.method === "GET" && p === "/api/access/data-dump-enrichment") {
      try {
        const out = await getAccessDataDumpEnrichmentPayload();
        return json(res, 200, out);
      } catch (e) {
        console.error("[mf-lab-api] data-dump-enrichment:", e);
        return json(res, 500, apiErrorBody(e instanceof Error ? e.message : String(e)));
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
        return json(res, 400, apiErrorBody("PIN must be exactly 6 digits."));
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
        return json(res, 400, apiErrorBody("PIN must be exactly 6 digits."));
      }
      applyIrPanelPinLockMigration(db);
      const row = db.prepare(`SELECT pin_double_hash FROM ir_panel_pin_lock WHERE panel = ?`).get(panel);
      if (!row?.pin_double_hash) {
        const label = panel === "intro" ? "Intro" : panel === "rules" ? "Rules" : "Access";
        return json(res, 400, apiErrorBody(`${label} is not locked.`));
      }
      if (row.pin_double_hash !== h) {
        return json(res, 403, apiErrorBody("Incorrect PIN."));
      }
      db.prepare(`DELETE FROM ir_panel_pin_lock WHERE panel = ?`).run(panel);
      return json(res, 200, { ok: true, panel, locked: false });
    }

    if (req.method === "GET" && p === "/api/memory-graph") {
      return json(res, 200, getMemoryGraphPayload());
    }

    if (req.method === "POST" && p === "/api/project-profile/export") {
      const body = await readBody(req);
      const hex = String(body.archivePassphraseHex ?? "")
        .trim()
        .toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hex)) {
        return json(res, 400, apiErrorBody("Invalid archive passphrase encoding."));
      }
      const snap = body.aiModelsSnapshot;
      if (!snap || typeof snap !== "object") {
        return json(res, 400, apiErrorBody("aiModelsSnapshot object is required."));
      }
      try {
        ensureMemoryGraphHubAnchorsPresent(db);
        const memoryGraph = getMemoryGraphPayload();
        const accessExternal = readAccessExternalServicesPayload();
        let accessEnrichment = {};
        try {
          accessEnrichment = await getAccessDataDumpEnrichmentPayload();
        } catch {
          accessEnrichment = { ok: false, error: "enrichment_unavailable" };
        }
        const buf = await buildProjectProfileMf7zBuffer({
          database: db,
          projectRoot: root,
          archivePassphraseHex: hex,
          aiModelsSnapshot: snap,
          memoryGraph,
          accessExternal,
          accessEnrichment,
        });
        const fn = projectProfileMfFilename();
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${fn}"`,
          "Content-Length": String(buf.length),
        });
        res.end(buf);
        return;
      } catch (e) {
        console.error("[mf-lab-api] project-profile/export:", e);
        return json(res, 500, apiErrorBody(e instanceof Error ? e.message : String(e)));
      }
    }

    if (req.method === "POST" && p === "/api/project-profile/import") {
      const hex = String(req.headers["x-mf0-archive-passphrase-hex"] ?? "")
        .trim()
        .toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hex)) {
        return json(res, 400, apiErrorBody("Invalid archive passphrase encoding."));
      }
      let buf;
      try {
        buf = await readBodyBuffer(req);
      } catch (e) {
        const status = e instanceof BodyTooLargeError ? 413 : 400;
        return json(res, status, apiErrorBody(e instanceof Error ? e.message : String(e)));
      }
      if (buf.length < 64) {
        return json(res, 400, apiErrorBody("Request body is too small to be a profile archive."));
      }
      try {
        const out = await importProjectProfileFromMfBuffer({
          projectRoot: root,
          database: db,
          buffer: buf,
          archivePassphraseHex: hex,
          normalizeCategory: normalizeMemoryGraphCategory,
          normLabel: normGraphLabel,
          ensureMemoryGraphHubAnchorsPresent: () => ensureMemoryGraphHubAnchorsPresent(db),
        });
        return json(res, 200, { ok: true, ...out });
      } catch (e) {
        const code = e && typeof e === "object" && "code" in e ? String(/** @type {{ code?: string }} */ (e).code) : "";
        const msg = e instanceof Error ? e.message : String(e);
        if (code === "WRONG_ARCHIVE_PASSWORD" || msg === "WRONG_ARCHIVE_PASSWORD") {
          return json(res, 401, { ok: false, error: "WRONG_ARCHIVE_PASSWORD" });
        }
        console.error("[mf-lab-api] project-profile/import:", e);
        return json(res, 400, apiErrorBody(msg));
      }
    }

    if (req.method === "POST" && p === "/api/memory-graph/import") {
      const ct = String(req.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      try {
        let parsed;
        if (ct === "application/json" || ct === "text/json") {
          parsed = await readBody(req);
        } else if (
          ct === "application/gzip" ||
          ct === "application/x-gzip" ||
          ct === "application/octet-stream"
        ) {
          const buf = await readBodyBuffer(req);
          parsed = decodeImportBodyFromBuffer(buf);
        } else {
          return json(
            res,
            415,
            apiErrorBody(
              "Content-Type must be application/json, application/gzip, or application/octet-stream.",
            ),
          );
        }
        const payload = normalizeImportPayload(parsed, normalizeMemoryGraphCategory, normGraphLabel);
        const counts = replaceMemoryGraphInDatabase(db, payload, () =>
          ensureMemoryGraphHubAnchorsPresent(db),
        );
        return json(res, 200, { ok: true, ...counts });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = e instanceof BodyTooLargeError ? 413 : 400;
        return json(res, status, apiErrorBody(msg));
      }
    }

    if (req.method === "GET" && p === "/api/analytics") {
      return json(res, 200, { ok: true, ...getAnalyticsPayload() });
    }

    if (req.method === "POST" && p === "/api/analytics/aux-llm-usage") {
      try {
        const body = await readBody(req);
        const pid = String(body.provider_id ?? body.providerId ?? "").trim();
        const kind = String(body.request_kind ?? body.requestKind ?? "").trim();
        if (!ANALYTICS_PROVIDER_IDS.includes(pid)) {
          return json(res, 400, apiErrorBody("Unknown or missing provider_id"));
        }
        if (!AUX_LLM_USAGE_KINDS.has(kind)) {
          return json(res, 400, apiErrorBody("Unknown or missing request_kind"));
        }
        const optTok = (v) => {
          const n = parseInt(String(v ?? ""), 10);
          if (!Number.isFinite(n) || n < 0) return 0;
          return n;
        };
        const pp = optTok(body.llm_prompt_tokens);
        const pc = optTok(body.llm_completion_tokens);
        const pt = optTok(body.llm_total_tokens);
        if (pp === 0 && pc === 0 && pt === 0 && kind !== "optimizer_llm_check") {
          return json(res, 400, apiErrorBody("At least one non-zero token field is required"));
        }
        applyAnalyticsAuxLlmUsageMigration(db);
        db.prepare(
          `INSERT INTO analytics_aux_llm_usage (id, provider_id, request_kind, llm_prompt_tokens, llm_completion_tokens, llm_total_tokens)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(crypto.randomUUID(), pid, kind, pp, pc, pt);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, apiErrorBody(e instanceof Error ? e.message : String(e)));
      }
    }

    if (req.method === "POST" && p === "/api/memory-graph/ingest") {
      const body = await readBody(req);
      try {
        const out = ingestMemoryGraphFromBody(body);
        return json(res, 200, out);
      } catch (e) {
        return json(res, 400, apiErrorBody(e instanceof Error ? e.message : String(e)));
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
      if (errOut) return json(res, errOut.status, apiErrorBody(errOut.error));
      return json(res, 200, { ok: true });
    }

    const turnFavoriteMatch = p.match(/^\/api\/turns\/([^/]+)\/favorite$/);
    if (req.method === "POST" && turnFavoriteMatch) {
      const turnId = decodeURIComponent(turnFavoriteMatch[1]).trim();
      const body = await readBody(req);
      const favorite = Boolean(body.favorite);
      const markdown = body.markdown != null ? String(body.markdown) : "";
      const errOut = updateAssistantTurnFavoriteInDb(turnId, favorite, markdown);
      if (errOut) return json(res, errOut.status, apiErrorBody(errOut.error));
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
      if (out.error) return json(res, out.status, apiErrorBody(out.error));
      logThemeDeleted("POST", out.deletedThemeId);
      return json(res, 200, out);
    }

    const themeDeleteMatch = p.match(/^\/api\/themes\/([^/]+)$/);
    if (req.method === "DELETE" && themeDeleteMatch) {
      const themeId = decodeURIComponent(themeDeleteMatch[1]).trim();
      const out = deleteThemeFromDb(themeId);
      if (out.error) return json(res, out.status, apiErrorBody(out.error));
      logThemeDeleted("DELETE", out.deletedThemeId);
      return json(res, 200, out);
    }

    if (req.method === "POST" && (p === "/api/themes/rename" || p === "/api/theme-rename")) {
      const body = await readBody(req);
      const themeId = String(body.themeId ?? body.theme_id ?? "").trim();
      const title = String(body.title ?? "").trim();
      if (!themeId) return json(res, 400, apiErrorBody("themeId required"));
      if (!title) return json(res, 400, apiErrorBody("title required"));
      const row = db.prepare(`SELECT id FROM themes WHERE id = ?`).get(themeId);
      if (!row) return json(res, 404, apiErrorBody("Theme not found"));
      const now = new Date().toISOString();
      db.prepare(`UPDATE themes SET title = ?, updated_at = ? WHERE id = ?`).run(title, now, themeId);
      return json(res, 200, { ok: true, themeId, title });
    }

    if (req.method === "GET" && p.startsWith("/api/dialogs/") && p.endsWith("/turns")) {
      const dialogId = decodeURIComponent(p.slice("/api/dialogs/".length, -"/turns".length));
      if (!dialogId) return json(res, 400, apiErrorBody("Missing dialog id"));
      const row = db.prepare(`SELECT id FROM dialogs WHERE id = ?`).get(dialogId);
      if (!row) return json(res, 404, apiErrorBody("Dialog not found"));
      return json(res, 200, { turns: listTurns(dialogId) });
    }

    const contextPackMatch = p.match(/^\/api\/dialogs\/([^/]+)\/context-pack$/);
    if (req.method === "GET" && contextPackMatch) {
      const dialogId = decodeURIComponent(contextPackMatch[1]);
      if (!dialogId) return json(res, 400, apiErrorBody("Missing dialog id"));
      const q = url.searchParams.get("q") ?? url.searchParams.get("userQuery") ?? "";
      const pack = listContextPack(dialogId, String(q));
      if (!pack) return json(res, 404, apiErrorBody("Dialog not found"));
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
      if (!themeId) return json(res, 400, apiErrorBody("themeId required"));
      const trow = db.prepare(`SELECT id FROM themes WHERE id = ?`).get(themeId);
      if (!trow) return json(res, 404, apiErrorBody("Theme not found"));
      const title = String(body.title ?? "").trim() || "New conversation";
      const dialog = createDialogUnderTheme(themeId, title);
      return json(res, 201, { dialog: dialogRowToClient(dialog) });
    }

    const themeDialogsPost = p.match(/^\/api\/themes\/([^/]+)\/dialogs$/);
    if (req.method === "POST" && themeDialogsPost) {
      const themeId = decodeURIComponent(themeDialogsPost[1]);
      if (!themeId.trim()) return json(res, 400, apiErrorBody("themeId required"));
      const trow = db.prepare(`SELECT id FROM themes WHERE id = ?`).get(themeId);
      if (!trow) return json(res, 404, apiErrorBody("Theme not found"));
      const body = await readBody(req);
      const title = String(body.title ?? "").trim() || "New conversation";
      const dialog = createDialogUnderTheme(themeId, title);
      return json(res, 201, { dialog: dialogRowToClient(dialog) });
    }

    const clearTurnsMatch = p.match(/^\/api\/dialogs\/([^/]+)\/clear-turns$/);
    if (req.method === "POST" && clearTurnsMatch) {
      const dialogId = decodeURIComponent(clearTurnsMatch[1]).trim();
      if (!dialogId) return json(res, 400, apiErrorBody("Missing dialog id"));
      const drow = db.prepare(`SELECT id, IFNULL(purpose, '') AS purpose FROM dialogs WHERE id = ?`).get(dialogId);
      if (!drow) return json(res, 404, apiErrorBody("Dialog not found"));
      const pur = String(drow.purpose ?? "");
      if (!["intro", "rules", "access"].includes(pur)) {
        return json(res, 403, apiErrorBody("Clear is only allowed for Intro, Rules, or Access threads."));
      }
      try {
        const tx = db.transaction(() => {
          archiveConversationTurnAggregatesForDialog(dialogId, "ir_thread_cleared", null);
          clearThreadDerivedData(dialogId);
          db.prepare(`DELETE FROM conversation_turns WHERE dialog_id = ?`).run(dialogId);
        });
        tx();
      } catch (e) {
        console.error("[mf-lab-api] clear-turns:", e);
        return json(res, 500, apiErrorBody(e instanceof Error ? e.message : String(e)));
      }
      return json(res, 200, { ok: true, dialogId });
    }

    if (req.method === "POST" && p.startsWith("/api/dialogs/") && p.endsWith("/turns")) {
      const dialogId = decodeURIComponent(p.slice("/api/dialogs/".length, -"/turns".length));
      if (!dialogId) return json(res, 400, apiErrorBody("Missing dialog id"));
      const drow = db
        .prepare(`SELECT id, theme_id, IFNULL(purpose, '') AS purpose FROM dialogs WHERE id = ?`)
        .get(dialogId);
      if (!drow) return json(res, 404, apiErrorBody("Dialog not found"));

      const body = await readBody(req);
      const turnId = crypto.randomUUID();
      const cloneFrom = String(body.clone_user_from_turn_id ?? "").trim();
      let userText = String(body.user_text ?? "");
      let userAttachmentsJson = userAttachmentsJsonFromTurnPostBody(body);
      const assistantText = body.assistant_text != null ? String(body.assistant_text) : null;
      let requestedProviderId = String(body.requested_provider_id ?? "");
      const respondingProviderId =
        body.responding_provider_id != null ? String(body.responding_provider_id) : null;
      let requestType = String(body.request_type ?? "default");
      let userMessageAt = String(body.user_message_at ?? "");
      const assistantMessageAt =
        body.assistant_message_at != null ? String(body.assistant_message_at) : null;
      const assistantError = body.assistant_error === 1 || body.assistant_error === true ? 1 : 0;

      function optNonNegInt(v) {
        if (v === undefined || v === null || v === "") return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return null;
        return Math.min(Math.floor(n), 2_000_000_000);
      }
      const llmPromptTokens = optNonNegInt(body.llm_prompt_tokens);
      const llmCompletionTokens = optNonNegInt(body.llm_completion_tokens);
      const llmTotalTokens = optNonNegInt(body.llm_total_tokens);

      if (cloneFrom) {
        const src = db
          .prepare(
            `SELECT user_text, user_attachments_json, user_message_at, request_type, requested_provider_id
             FROM conversation_turns WHERE id = ? AND dialog_id = ?`,
          )
          .get(cloneFrom, dialogId);
        if (!src) {
          return json(res, 400, apiErrorBody("clone_user_from_turn_id not found in this dialog"));
        }
        userText = String(src.user_text ?? "");
        userAttachmentsJson = src.user_attachments_json != null ? String(src.user_attachments_json) : "";
        userMessageAt = String(src.user_message_at ?? "");
        requestType = String(src.request_type ?? "default");
        if (!String(requestedProviderId ?? "").trim()) {
          requestedProviderId = String(src.requested_provider_id ?? "").trim();
        }
      }

      const attachRows = parseTurnUserAttachmentsJson(userAttachmentsJson);
      const hasUserChars = String(userText).trim().length > 0;
      const hasAttach = attachRows.length > 0;
      const allowEmptyUserText = requestType === "access_data";
      if ((!hasUserChars && !hasAttach && !allowEmptyUserText) || !requestedProviderId || !userMessageAt) {
        return json(
          res,
          400,
          apiErrorBody("user_text (or attachments), requested_provider_id, user_message_at required"),
        );
      }

      const attachJsonToStore = hasAttach ? JSON.stringify(attachRows) : null;
      const pipelineUserText = userTextForContextPipeline(userText, attachJsonToStore);

      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO conversation_turns (
            id, dialog_id, user_text, user_attachments_json, assistant_text, requested_provider_id, responding_provider_id,
            request_type, user_message_at, assistant_message_at, assistant_error,
            llm_prompt_tokens, llm_completion_tokens, llm_total_tokens
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          llmPromptTokens,
          llmCompletionTokens,
          llmTotalTokens,
        );
        db.prepare(`UPDATE dialogs SET updated_at = ? WHERE id = ?`).run(now, dialogId);
        db.prepare(`UPDATE themes SET updated_at = ? WHERE id = ?`).run(now, drow.theme_id);
      });
      tx();
      try {
        /** Access thread, #data in text, or Access data menu: persist turns only; no RAG / memory extraction side lane. */
        const dataDumpLockdown =
          userTextTriggersAccessDataDumpLockdown(userText) || requestType === "access_data";
        const skipPipelineForRetryClone = Boolean(cloneFrom);
        if (String(drow.purpose ?? "") !== "access" && !dataDumpLockdown && !skipPipelineForRetryClone) {
          runAfterTurnPipeline(
            dialogId,
            turnId,
            pipelineUserText,
            assistantText,
            userMessageAt,
            assistantMessageAt || now,
          );
        }
        const graphPur = String(drow.purpose ?? "").trim();
        const graphKeeperEligiblePurpose =
          graphPur !== "access" && graphPur !== "rules" && graphPur !== "intro";
        if (
          graphKeeperEligiblePurpose &&
          !dataDumpLockdown &&
          !skipPipelineForRetryClone &&
          assistantError === 0 &&
          requestType !== "image" &&
          requestType !== "access_data" &&
          shouldRunMemoryGraphKeeperForApiTurnBody(body) &&
          String(pipelineUserText ?? "").trim().length > 0
        ) {
          scheduleMemoryGraphKeeperIngestForChatApiTurn(db, (ingestBody) => ingestMemoryGraphFromBody(ingestBody), pipelineUserText);
        }
      } catch (e) {
        console.error("context pipeline after turn:", e);
      }
      return json(res, 201, { id: turnId });
    }

    if (req.method === "POST" && rawPath.includes("theme") && rawPath.includes("delete")) {
      console.warn(`[mf-lab-api] 404 POST delete-theme: canonical=${JSON.stringify(p)} raw=${JSON.stringify(rawPath)}`);
    }
    json(res, 404, apiErrorBody("Not found"));
  } catch (e) {
    console.error(e);
    if (e instanceof BodyTooLargeError) {
      json(res, 413, apiErrorBody(e.message));
      return;
    }
    json(res, 500, apiErrorBody(e instanceof Error ? e.message : String(e)));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`MF0-1984 API http://127.0.0.1:${PORT}/ (SQLite: ${dbPath})`);
  if (process.env.API_PATH_PREFIX) {
    console.log(`[mf-lab-api] API_PATH_PREFIX=${process.env.API_PATH_PREFIX}`);
  }
});
