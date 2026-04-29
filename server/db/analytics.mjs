/**
 * Analytics: provider normalisation, USD estimates, and the main analytics payload query.
 * Depends only on db from migrations.mjs — no HTTP layer.
 */
import crypto from "node:crypto";
import { db, adapter } from "./migrations.mjs";

export const AUX_LLM_USAGE_KINDS = new Set([
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

export function estimateTokensFromText(text) {
  const s = String(text ?? "").trim();
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}

export function analyticsProviderFromVoiceProvider(voiceProviderId) {
  const p = String(voiceProviderId ?? "").trim().toLowerCase();
  if (!p) return "";
  if (p === "openai") return "openai";
  if (p.startsWith("gemini")) return "gemini-flash";
  if (p.startsWith("anthropic")) return "anthropic";
  if (p.startsWith("perplexity")) return "perplexity";
  return "";
}

export function recordAuxLlmUsageRow(
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
    `INSERT INTO analytics_aux_llm_usage
       (id, provider_id, request_kind, llm_prompt_tokens, llm_completion_tokens, llm_total_tokens, conversation_turn_id, dialog_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), pid, kind, pp, pc, pt, ctid || null, did || null);
  return true;
}

export const ANALYTICS_PROVIDER_IDS = ["openai", "perplexity", "gemini-flash", "anthropic"];

/**
 * Map any client/provider slot id into one of ANALYTICS_PROVIDER_IDS so aux rows are never dropped.
 * USD rates for unknown slugs are approximate (same bucket as the chosen provider family).
 * @param {string} pidRaw
 * @returns {string}
 */
function normalizeAuxAnalyticsProviderId(pidRaw) {
  const raw = String(pidRaw ?? "").trim();
  if (!raw) return "";
  const p = raw.toLowerCase();
  if (ANALYTICS_PROVIDER_IDS.includes(p)) return p;
  if (p.startsWith("gemini")) return "gemini-flash";
  if (p.startsWith("claude")) return "anthropic";
  if (p.startsWith("sonar") || p.includes("perplexity") || p.includes("pplx")) return "perplexity";
  if (
    p.startsWith("gpt") ||
    /^o[0-9]/.test(p) ||
    p.startsWith("davinci") ||
    p.startsWith("text-embedding") ||
    p.includes("dall-e") ||
    p.includes("sora")
  ) {
    return "openai";
  }
  return "openai";
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
  const bucket = normalizeAuxAnalyticsProviderId(String(providerId ?? "")) || "openai";
  const rate = ANALYTICS_USD_PER_MILLION[bucket];
  if (!rate) return { inputUsd: 0, outputUsd: 0, totalUsd: 0 };
  const inputUsd = ((Number(promptTokens) || 0) / 1_000_000) * rate.input;
  const outputUsd = ((Number(completionTokens) || 0) / 1_000_000) * rate.output;
  return { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd };
}

/**
 * @param {string} requestType
 */
function analyticsProcessLabelForTurnRequestType(requestType) {
  const t = String(requestType ?? "").trim().toLowerCase();
  if (t === "image") return "image_generation";
  if (t === "research") return "chat_research_reply";
  if (t === "web") return "chat_web_reply";
  if (t === "access_data") return "access_data_reply";
  return "chat_reply";
}

/**
 * @param {string} requestKind
 */
function analyticsProcessLabelForAuxKind(requestKind) {
  const k = String(requestKind ?? "").trim().toLowerCase();
  if (!k) return "aux_llm";
  const labels = {
    memory_tree_router: "Memory tree router",
    interests_sketch: "Keeper: interest sketch (chat)",
    memory_graph_normalize: "Keeper: graph normalize",
    intro_graph_extract: "Keeper: Intro extract",
    ai_talks_round: "AI opinion round",
    voice_transcription: "Voice transcription",
    voice_reply_tts: "Voice reply TTS",
    optimizer_llm_check: "Optimizer: LLM check",
    theme_dialog_title: "Theme / dialog title",
    help_chat_turn: "Help chat turn",
    rules_keeper_extract: "Keeper: Rules extract",
    access_keeper2_extract: "Keeper: Access extract",
  };
  return labels[k] ?? k;
}

/**
 * @param {string} iso
 * @param {number} deltaMs
 */
function shiftIso(iso, deltaMs) {
  const ms = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + Number(deltaMs || 0)).toISOString();
}

/**
 * @returns {Promise<{
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
 * }>}
 */
async function getAnalyticsPayload() {
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
  const auxTbl = await adapter.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_aux_llm_usage'`);

  const aggRows = await adapter.all(
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
  );
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

  const conversationAggForRange = async (sinceExpr) =>
    adapter.all(
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
    );

  for (const row of await conversationAggForRange("DATETIME('now', '-30 days')")) {
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

  for (const row of await conversationAggForRange("DATETIME('now', '-24 hours')")) {
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

  const archTbl = await adapter.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_usage_archive'`);
  let archHasTokens = false;
  if (archTbl) {
    const archCols = await adapter.all(`PRAGMA table_info(analytics_usage_archive)`);
    archHasTokens = archCols.some((c) => c.name === "tokens_total");
    const archAgg = await adapter.all(
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
    );
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

    const archAggLast30d = await adapter.all(
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
    );

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

    const archAggLast24h = await adapter.all(
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
    );

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
    const auxTokAgg = await adapter.all(
      `SELECT provider_id AS pid,
          SUM(COALESCE(llm_prompt_tokens, 0)) AS tokens_prompt,
          SUM(COALESCE(llm_completion_tokens, 0)) AS tokens_completion,
          SUM(COALESCE(llm_total_tokens, 0)) AS tokens_total
        FROM analytics_aux_llm_usage
        GROUP BY provider_id`,
    );
    for (const row of auxTokAgg) {
      const pid = String(row.pid ?? "").trim();
      if (!providers[pid]) continue;
      providers[pid].tokensPrompt += Number(row.tokens_prompt) || 0;
      providers[pid].tokensCompletion += Number(row.tokens_completion) || 0;
      providers[pid].tokensTotal += Number(row.tokens_total) || 0;
    }

    const auxTokAggLast30d = await adapter.all(
      `SELECT provider_id AS pid,
         SUM(COALESCE(llm_prompt_tokens, 0)) AS tokens_prompt,
         SUM(COALESCE(llm_completion_tokens, 0)) AS tokens_completion,
         SUM(COALESCE(llm_total_tokens, 0)) AS tokens_total
       FROM analytics_aux_llm_usage
       WHERE datetime(created_at) >= datetime('now', '-30 days')
       GROUP BY provider_id`,
    );

    for (const row of auxTokAggLast30d) {
      const pid = String(row.pid ?? "").trim();
      if (!providersLast30d[pid]) continue;
      providersLast30d[pid].tokensPrompt += Number(row.tokens_prompt) || 0;
      providersLast30d[pid].tokensCompletion += Number(row.tokens_completion) || 0;
      providersLast30d[pid].tokensTotal += Number(row.tokens_total) || 0;
    }

    const auxTokAggLast24h = await adapter.all(
      `SELECT provider_id AS pid,
         SUM(COALESCE(llm_prompt_tokens, 0)) AS tokens_prompt,
         SUM(COALESCE(llm_completion_tokens, 0)) AS tokens_completion,
         SUM(COALESCE(llm_total_tokens, 0)) AS tokens_total
       FROM analytics_aux_llm_usage
       WHERE datetime(created_at) >= datetime('now', '-24 hours')
       GROUP BY provider_id`,
    );

    for (const row of auxTokAggLast24h) {
      const pid = String(row.pid ?? "").trim();
      if (!providersLast24h[pid]) continue;
      providersLast24h[pid].tokensPrompt += Number(row.tokens_prompt) || 0;
      providersLast24h[pid].tokensCompletion += Number(row.tokens_completion) || 0;
      providersLast24h[pid].tokensTotal += Number(row.tokens_total) || 0;
    }

    const auxReqAgg = await adapter.all(
      `SELECT provider_id AS pid, COUNT(*) AS cnt
       FROM analytics_aux_llm_usage
       GROUP BY provider_id`,
    );
    for (const row of auxReqAgg) {
      const pid = String(row.pid ?? "").trim();
      if (!providers[pid]) continue;
      const n = Number(row.cnt) || 0;
      providers[pid].requestsSent += n;
      providers[pid].responsesOk += n;
    }
    const auxReqAggLast30d = await adapter.all(
      `SELECT provider_id AS pid, COUNT(*) AS cnt
       FROM analytics_aux_llm_usage
       WHERE datetime(created_at) >= datetime('now', '-30 days')
       GROUP BY provider_id`,
    );
    for (const row of auxReqAggLast30d) {
      const pid = String(row.pid ?? "").trim();
      if (!providersLast30d[pid]) continue;
      const n = Number(row.cnt) || 0;
      providersLast30d[pid].requestsSent += n;
      providersLast30d[pid].responsesOk += n;
    }
    const auxReqAggLast24h = await adapter.all(
      `SELECT provider_id AS pid, COUNT(*) AS cnt
       FROM analytics_aux_llm_usage
       WHERE datetime(created_at) >= datetime('now', '-24 hours')
       GROUP BY provider_id`,
    );
    for (const row of auxReqAggLast24h) {
      const pid = String(row.pid ?? "").trim();
      if (!providersLast24h[pid]) continue;
      const n = Number(row.cnt) || 0;
      providersLast24h[pid].requestsSent += n;
      providersLast24h[pid].responsesOk += n;
    }
  }

  const dayRows = await adapter.all(
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
  );

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
    const archDays = await adapter.all(
      `SELECT
         DATE(archived_at) AS day,
         provider_id AS pid,
         SUM(turn_count) AS cnt
       FROM analytics_usage_archive
       WHERE datetime(archived_at) >= datetime('now', '-30 days')
       GROUP BY day, pid`,
    );
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
    const auxDayReq = await adapter.all(
      `SELECT DATE(created_at) AS day, provider_id AS pid, COUNT(*) AS cnt
       FROM analytics_aux_llm_usage
       WHERE datetime(created_at) >= datetime('now', '-30 days')
       GROUP BY day, pid`,
    );
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

  const dayTokenRows = await adapter.all(
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
  );

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
    const archTokDays = await adapter.all(
      `SELECT
         DATE(archived_at) AS day,
         provider_id AS pid,
         SUM(tokens_prompt) AS psum,
         SUM(tokens_completion) AS csum,
         SUM(tokens_total) AS tsum
       FROM analytics_usage_archive
       WHERE datetime(archived_at) >= datetime('now', '-30 days')
       GROUP BY day, pid`,
    );
    for (const r of archTokDays) {
      addDayTokenDetail(String(r.day ?? "").trim(), String(r.pid ?? "").trim(), r.psum, r.csum, r.tsum);
    }
  }

  if (auxTbl) {
    const auxTokDays = await adapter.all(
      `SELECT DATE(created_at) AS day, provider_id AS pid,
          SUM(COALESCE(llm_prompt_tokens, 0)) AS psum,
          SUM(COALESCE(llm_completion_tokens, 0)) AS csum,
          SUM(COALESCE(llm_total_tokens, 0)) AS tsum
        FROM analytics_aux_llm_usage
        WHERE datetime(created_at) >= datetime('now', '-30 days')
        GROUP BY day, pid`,
    );
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
    const row = await adapter.get(`SELECT DATE(DATETIME('now', ?)) AS d`, [`-${i} days`]);
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
  const live24h = await adapter.all(
    `SELECT
       COALESCE(NULLIF(TRIM(t.responding_provider_id), ''), t.requested_provider_id) AS pid,
       SUM(COALESCE(t.llm_prompt_tokens, 0)) AS psum,
       SUM(COALESCE(t.llm_completion_tokens, 0)) AS csum
     FROM conversation_turns t
     INNER JOIN dialogs d ON d.id = t.dialog_id
     WHERE ${analyticsDialogWhereSql("d")}
       AND DATETIME(t.user_message_at) >= DATETIME('now', '-24 hours')
     GROUP BY pid`,
  );
  for (const r of live24h) {
    const pid = String(r.pid ?? "").trim();
    if (!last24hByProvider[pid]) continue;
    last24hByProvider[pid].prompt += Number(r.psum) || 0;
    last24hByProvider[pid].completion += Number(r.csum) || 0;
  }
  if (archTbl && archHasTokens) {
    const arch24h = await adapter.all(
      `SELECT
         provider_id AS pid,
         SUM(COALESCE(tokens_prompt, 0)) AS psum,
         SUM(COALESCE(tokens_completion, 0)) AS csum
       FROM analytics_usage_archive
       WHERE DATETIME(archived_at) >= DATETIME('now', '-24 hours')
       GROUP BY pid`,
    );
    for (const r of arch24h) {
      const pid = String(r.pid ?? "").trim();
      if (!last24hByProvider[pid]) continue;
      last24hByProvider[pid].prompt += Number(r.psum) || 0;
      last24hByProvider[pid].completion += Number(r.csum) || 0;
    }
  }
  if (auxTbl) {
    const aux24h = await adapter.all(
      `SELECT
         provider_id AS pid,
         SUM(COALESCE(llm_prompt_tokens, 0)) AS psum,
         SUM(COALESCE(llm_completion_tokens, 0)) AS csum
       FROM analytics_aux_llm_usage
       WHERE DATETIME(created_at) >= DATETIME('now', '-24 hours')
       GROUP BY pid`,
    );
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

  const themesRow = await adapter.get(
    `SELECT COUNT(*) AS n FROM themes WHERE id NOT IN (
       SELECT DISTINCT theme_id FROM dialogs WHERE IFNULL(purpose, '') IN ('intro', 'access', 'rules')
     )`,
  );
  const dialogsRow = await adapter.get(`SELECT COUNT(*) AS n FROM dialogs d WHERE ${analyticsDialogWhereSql("d")}`);

  let memoryGraph = { nodes: 0, edges: 0, groups: 0 };
  const tbl = await adapter.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_graph_nodes'`);
  if (tbl) {
    const nodesRow = await adapter.get(`SELECT COUNT(*) AS n FROM memory_graph_nodes`);
    const edgesRow = await adapter.get(`SELECT COUNT(*) AS n FROM memory_graph_edges`);
    const groupsRow = await adapter.get(`SELECT COUNT(DISTINCT category) AS n FROM memory_graph_nodes`);
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

export { normalizeAuxAnalyticsProviderId, estimateProviderUsd, analyticsProcessLabelForTurnRequestType, analyticsProcessLabelForAuxKind, getAnalyticsPayload };
