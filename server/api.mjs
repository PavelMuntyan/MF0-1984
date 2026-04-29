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
import { resolveApiPort } from "./resolveApiPort.mjs";
import { db, dbPath, createDatabase } from "./db/migrations.mjs";
import {
  readRulesKeeperBundlePayload,
  mergeRulesKeeperPatchFromBody,
  keeperBundleToVirtualContextRules,
} from "./services/rulesKeeper.mjs";
import {
  VOICE_REPLIES_DIR,
  TTS_SELFTEST_DIR,
  transcribeVoiceFromEnv,
  sanitizeTurnIdForVoiceFile,
  voiceReplyMp3Path,
  voiceReplyApiUrl,
  ensureVoiceReplyMp3ForTurn,
  getAssistantTextForTurnId,
} from "./services/voice.mjs";
import {
  getProjectCacheStatsPayload,
  clearProjectMultimediaCacheFull,
} from "./services/projectCache.mjs";
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
import {
  ANALYTICS_PROVIDER_IDS,
  normalizeAuxAnalyticsProviderId,
  estimateProviderUsd,
  analyticsProcessLabelForTurnRequestType,
  analyticsProcessLabelForAuxKind,
  getAnalyticsPayload,
} from "./db/analytics.mjs";
import {
  normalizeMemoryGraphCategory,
  normGraphLabel,
  ensureMemoryGraphHubAnchorsPresent,
  getMemoryGraphPayload,
  ingestMemoryGraphFromBody,
} from "./db/memoryGraph.mjs";
import {
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
} from "./db/turns.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
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



/** Allowed `request_kind` values for POST /api/analytics/aux-llm-usage */
const AUX_LLM_USAGE_KINDS = new Set([
  "memory_tree_router",
  "interests_sketch",
  "memory_graph_normalize",
  "intro_graph_extract",
  "ai_talks_round",
  "voice_transcription",
  "voice_reply_tts",
  "optimizer_llm_check",
  "theme_dialog_title",
  "help_chat_turn",
  "rules_keeper_extract",
  "access_keeper2_extract",
]);


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

function recordAuxLlmUsageRow(
  providerId,
  requestKind,
  promptTokens,
  completionTokens,
  totalTokens,
  conversationTurnId = "",
  dialogId = "",
) {
  const pid = normalizeAuxAnalyticsProviderId(String(providerId ?? "")) || "openai";
  const kind = String(requestKind ?? "").trim();
  if (!ANALYTICS_PROVIDER_IDS.includes(pid)) return false;
  if (!AUX_LLM_USAGE_KINDS.has(kind)) return false;
  const pp = Math.max(0, Number(promptTokens) || 0);
  const pc = Math.max(0, Number(completionTokens) || 0);
  const pt = Math.max(0, Number(totalTokens) || pp + pc);
  if (pp === 0 && pc === 0 && pt === 0 && kind !== "optimizer_llm_check") return false;
  const ctid = String(conversationTurnId ?? "").trim();
  const did = String(dialogId ?? "").trim();
  db.prepare(
    `INSERT INTO analytics_aux_llm_usage (id, provider_id, request_kind, llm_prompt_tokens, llm_completion_tokens, llm_total_tokens, conversation_turn_id, dialog_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), pid, kind, pp, pc, pt, ctid || null, did || null);
  return true;
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


const USER_PROFILE_CONTEXT_MAX_CHARS = 8000;

/** People / "User" blob from the Memory tree (Intro + Keeper) — how to address the person and stated facts. */
async function readMemoryGraphUserProfileForContextPack() {
  try {
    await ensureMemoryGraphHubAnchorsPresent();
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

async function listContextPack(dialogId, userQuery) {
  const drow = db
    .prepare(
      `SELECT d.id, d.title AS dialog_title, t.title AS theme_title
       FROM dialogs d JOIN themes t ON t.id = d.theme_id WHERE d.id = ?`,
    )
    .get(dialogId);
  if (!drow) return null;
  const turns = await listTurns(dialogId);
  const userAddressingProfile = await readMemoryGraphUserProfileForContextPack();
  if (!await hasContextTables()) {
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

function userTextTriggersAccessDataDumpLockdown(userText) {
  const t = String(userText ?? "").trim();
  if (!t) return false;
  if (t === "#data") return true;
  return /(?:^|\s)#data(?:\s|$)/.test(t);
}

async function runAfterTurnPipeline(dialogId, turnId, userText, assistantText, userMessageAt, assistantMessageAt) {
  if (!await hasContextTables()) return;
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


/** @param {"POST" | "DELETE"} via */
function logThemeDeleted(via, themeId) {
  console.log(`[mf-lab-api] theme deleted (${via}): ${themeId}`);
}


/** SHA256(hex of MD5(6-digit PIN)) — verify by recomputing; PIN is not stored. */
function doubleHashIrPanelPin6(pin) {
  const raw = String(pin ?? "").replace(/\D/g, "");
  if (!/^[0-9]{6}$/.test(raw)) return null;
  const md5hex = crypto.createHash("md5").update(raw, "utf8").digest("hex");
  return crypto.createHash("sha256").update(md5hex, "utf8").digest("hex");
}

function getIrPanelLocksPayload() {
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
          if (out.created) {
            try {
              let pid = analyticsProviderFromVoiceProvider(out.providerId);
              if (!pid || !ANALYTICS_PROVIDER_IDS.includes(pid)) pid = "gemini-flash";
              const promptTokens = estimateTokensFromText(getAssistantTextForTurnId(turnId));
              const completionTokens = 0;
              const totalTokens = promptTokens;
              let vDid = "";
              try {
                const tr = db.prepare(`SELECT dialog_id FROM conversation_turns WHERE id = ?`).get(turnId);
                vDid = String(tr?.dialog_id ?? "").trim();
              } catch {
                /* ignore */
              }
              recordAuxLlmUsageRow(pid, "voice_reply_tts", promptTokens, completionTokens, totalTokens, turnId, vDid);
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
      return json(res, 200, await getMemoryGraphPayload());
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
        await ensureMemoryGraphHubAnchorsPresent();
        const memoryGraph = await getMemoryGraphPayload();
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
          ensureMemoryGraphHubAnchorsPresent: () => { void ensureMemoryGraphHubAnchorsPresent(); },
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
        const counts = replaceMemoryGraphInDatabase(db, payload, () => { void ensureMemoryGraphHubAnchorsPresent(); });
        return json(res, 200, { ok: true, ...counts });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = e instanceof BodyTooLargeError ? 413 : 400;
        return json(res, status, apiErrorBody(msg));
      }
    }

    if (req.method === "GET" && p === "/api/analytics") {
      return json(res, 200, { ok: true, ...(await getAnalyticsPayload()) });
    }

    const turnCostMatch = p.match(/^\/api\/analytics\/turn-costs\/([^/]+)$/);
    if (req.method === "GET" && turnCostMatch) {
      const turnId = decodeURIComponent(turnCostMatch[1]).trim();
      if (!turnId) return json(res, 400, apiErrorBody("turnId is required"));
      const turn = db
        .prepare(
          `SELECT
             id,
             dialog_id,
             request_type,
             requested_provider_id,
             responding_provider_id,
             llm_prompt_tokens,
             llm_completion_tokens,
             llm_total_tokens,
             user_message_at,
             assistant_message_at
           FROM conversation_turns
           WHERE id = ?`,
        )
        .get(turnId);
      if (!turn) return json(res, 404, apiErrorBody("Turn not found"));

      const userAt = String(turn.user_message_at ?? "").trim();
      const assistantAt = String(turn.assistant_message_at ?? "").trim();
      const pid = String(turn.responding_provider_id ?? turn.requested_provider_id ?? "").trim().toLowerCase();
      const promptTok = Math.max(0, Number(turn.llm_prompt_tokens) || 0);
      const completionTok = Math.max(0, Number(turn.llm_completion_tokens) || 0);
      const totalTok =
        Math.max(0, Number(turn.llm_total_tokens) || 0) || Math.max(0, promptTok + completionTok);
      const turnUsd = estimateProviderUsd(pid, promptTok, completionTok);


      /** @type {Array<Record<string, unknown>>} */
      const rows = [];
      if (promptTok > 0 || completionTok > 0 || totalTok > 0) {
        rows.push({
          process: analyticsProcessLabelForTurnRequestType(String(turn.request_type ?? "")),
          provider_id: pid,
          model: pid,
          llm_prompt_tokens: promptTok,
          llm_completion_tokens: completionTok,
          llm_total_tokens: totalTok,
          cost_usd: turnUsd.totalUsd,
          source: "turn",
          occurred_at: assistantAt || userAt || "",
        });
      }

      const auxRows = db
        .prepare(
          `SELECT
             created_at,
             provider_id,
             request_kind,
             llm_prompt_tokens,
             llm_completion_tokens,
             llm_total_tokens
           FROM analytics_aux_llm_usage
           WHERE conversation_turn_id = ?
           ORDER BY DATETIME(created_at) ASC`,
        )
        .all(turnId);
      for (const r of auxRows) {
        const apid = String(r.provider_id ?? "").trim().toLowerCase();
        const pp = Math.max(0, Number(r.llm_prompt_tokens) || 0);
        const pc = Math.max(0, Number(r.llm_completion_tokens) || 0);
        const pt = Math.max(0, Number(r.llm_total_tokens) || 0) || Math.max(0, pp + pc);
        const usd = estimateProviderUsd(apid, pp, pc);
        rows.push({
          process: analyticsProcessLabelForAuxKind(String(r.request_kind ?? "")),
          provider_id: apid,
          model: apid,
          llm_prompt_tokens: pp,
          llm_completion_tokens: pc,
          llm_total_tokens: pt,
          cost_usd: usd.totalUsd,
          source: "aux",
          occurred_at: String(r.created_at ?? ""),
        });
      }

      const totals = rows.reduce(
        (a, r) => ({
          llm_prompt_tokens: a.llm_prompt_tokens + (Number(r.llm_prompt_tokens) || 0),
          llm_completion_tokens: a.llm_completion_tokens + (Number(r.llm_completion_tokens) || 0),
          llm_total_tokens: a.llm_total_tokens + (Number(r.llm_total_tokens) || 0),
          cost_usd: a.cost_usd + (Number(r.cost_usd) || 0),
        }),
        { llm_prompt_tokens: 0, llm_completion_tokens: 0, llm_total_tokens: 0, cost_usd: 0 },
      );

      return json(res, 200, {
        ok: true,
        noAttributedUsage: rows.length === 0,
        turn: {
          id: String(turn.id ?? ""),
          dialog_id: String(turn.dialog_id ?? ""),
          user_message_at: userAt,
          assistant_message_at: assistantAt,
          provider_id: pid,
          request_type: String(turn.request_type ?? ""),
        },
        rows,
        totals,
      });
    }

    if (req.method === "POST" && p === "/api/analytics/aux-llm-usage") {
      try {
        const body = await readBody(req);
        const pidRaw = String(body.provider_id ?? body.providerId ?? "").trim();
        const pid = normalizeAuxAnalyticsProviderId(pidRaw);
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
        const ctIn = String(body.conversation_turn_id ?? body.conversationTurnId ?? "").trim();
        const dlgIn = String(body.dialog_id ?? body.dialogId ?? "").trim();
        db.prepare(
          `INSERT INTO analytics_aux_llm_usage (id, provider_id, request_kind, llm_prompt_tokens, llm_completion_tokens, llm_total_tokens, conversation_turn_id, dialog_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(crypto.randomUUID(), pid, kind, pp, pc, pt, ctIn || null, dlgIn || null);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, apiErrorBody(e instanceof Error ? e.message : String(e)));
      }
    }

    if (req.method === "POST" && p === "/api/memory-graph/ingest") {
      const body = await readBody(req);
      try {
        const out = await ingestMemoryGraphFromBody(body);
        return json(res, 200, out);
      } catch (e) {
        return json(res, 400, apiErrorBody(e instanceof Error ? e.message : String(e)));
      }
    }

    if (
      req.method === "GET" &&
      (p === "/api/assistant-favorites" || p === "/api/dialogs/assistant-favorites")
    ) {
      const rows = await listAssistantFavorites();
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
      const errOut = await updateAssistantTurnFavoriteInDb(turnId, favorite, markdown);
      if (errOut) return json(res, errOut.status, apiErrorBody(errOut.error));
      return json(res, 200, { ok: true });
    }

    const turnFavoriteMatch = p.match(/^\/api\/turns\/([^/]+)\/favorite$/);
    if (req.method === "POST" && turnFavoriteMatch) {
      const turnId = decodeURIComponent(turnFavoriteMatch[1]).trim();
      const body = await readBody(req);
      const favorite = Boolean(body.favorite);
      const markdown = body.markdown != null ? String(body.markdown) : "";
      const errOut = await updateAssistantTurnFavoriteInDb(turnId, favorite, markdown);
      if (errOut) return json(res, errOut.status, apiErrorBody(errOut.error));
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && p === "/api/themes") {
      return json(res, 200, { themes: await listThemesWithDialogs() });
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
      const out = await deleteThemeFromDb(themeId);
      if (out.error) return json(res, out.status, apiErrorBody(out.error));
      logThemeDeleted("POST", out.deletedThemeId);
      return json(res, 200, out);
    }

    const themeDeleteMatch = p.match(/^\/api\/themes\/([^/]+)$/);
    if (req.method === "DELETE" && themeDeleteMatch) {
      const themeId = decodeURIComponent(themeDeleteMatch[1]).trim();
      const out = await deleteThemeFromDb(themeId);
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
      return json(res, 200, { turns: await listTurns(dialogId) });
    }

    const contextPackMatch = p.match(/^\/api\/dialogs\/([^/]+)\/context-pack$/);
    if (req.method === "GET" && contextPackMatch) {
      const dialogId = decodeURIComponent(contextPackMatch[1]);
      if (!dialogId) return json(res, 400, apiErrorBody("Missing dialog id"));
      const q = url.searchParams.get("q") ?? url.searchParams.get("userQuery") ?? "";
      const pack = await listContextPack(dialogId, String(q));
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
      const dialog = await createDialogUnderTheme(themeId, title);
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
      const dialog = await createDialogUnderTheme(themeId, title);
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
        await archiveConversationTurnAggregatesForDialog(dialogId, "ir_thread_cleared", null);
        const tx = db.transaction(() => {
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
          scheduleMemoryGraphKeeperIngestForChatApiTurn(db, (ingestBody) => ingestMemoryGraphFromBody(ingestBody), pipelineUserText, {
            dialogId,
            conversationTurnId: turnId,
            recordAuxUsage: (row) => {
              if (!row || typeof row !== "object") return;
              recordAuxLlmUsageRow(
                String(row.providerId ?? "openai"),
                String(row.requestKind ?? ""),
                Number(row.promptTokens) || 0,
                Number(row.completionTokens) || 0,
                Number(row.totalTokens) || 0,
                turnId,
                dialogId,
              );
            },
          });
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