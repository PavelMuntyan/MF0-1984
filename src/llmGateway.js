/**
 * Central LLM gateway — single point for all provider HTTP calls.
 * Handles usage normalization and aux analytics recording.
 * Browser-side: calls route through /api/llm/* (server-side proxy, keys in process.env).
 */

import { recordAuxLlmUsage } from "./chatPersistence.js";
import {
  streamAnthropicMessages,
  streamGeminiGenerateContent,
  streamOpenAICompatJson,
} from "./streaming.js";
import {
  collectGeminiGroundingEntries,
  collectOpenAiLikeAnnotationUrls,
  mergePlainBracketRefsWithCitationList,
  pickPerplexityCitationPayload,
} from "./footnoteCitations.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ promptTokens: number, completionTokens: number, totalTokens: number }} LlmUsage
 */

// ─── Usage normalization ──────────────────────────────────────────────────────

/** @param {unknown} u */
export function usageFromOpenAiStyle(u) {
  if (!u || typeof u !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (u);
  const p = Number(o.prompt_tokens);
  const c = Number(o.completion_tokens);
  const t = Number(o.total_tokens);
  if (!Number.isFinite(p) && !Number.isFinite(c) && !Number.isFinite(t)) return null;
  const promptTokens = Number.isFinite(p) ? Math.max(0, Math.floor(p)) : 0;
  const completionTokens = Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 0;
  const totalTokens = Number.isFinite(t) ? Math.max(0, Math.floor(t)) : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

/** @param {unknown} data — top-level Anthropic Messages API response */
export function usageFromAnthropic(data) {
  const u = data && typeof data === "object" ? /** @type {any} */ (data).usage : null;
  if (!u || typeof u !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (u);
  const inp = Number(o.input_tokens);
  const outp = Number(o.output_tokens);
  if (!Number.isFinite(inp) && !Number.isFinite(outp)) return null;
  const promptTokens = Number.isFinite(inp) ? Math.max(0, Math.floor(inp)) : 0;
  const completionTokens = Number.isFinite(outp) ? Math.max(0, Math.floor(outp)) : 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/** @param {unknown} data — top-level Gemini generateContent response */
export function usageFromGemini(data) {
  const um = data && typeof data === "object" ? /** @type {any} */ (data).usageMetadata : null;
  if (!um || typeof um !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (um);
  const p = Number(o.promptTokenCount);
  const c = Number(o.candidatesTokenCount);
  const t = Number(o.totalTokenCount);
  if (!Number.isFinite(p) && !Number.isFinite(c) && !Number.isFinite(t)) return null;
  const promptTokens = Number.isFinite(p) ? Math.max(0, Math.floor(p)) : 0;
  const completionTokens = Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 0;
  const totalTokens = Number.isFinite(t) ? Math.max(0, Math.floor(t)) : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

/** @param {string} text */
function estimateTokens(text) {
  const s = String(text ?? "").trim();
  return s ? Math.max(1, Math.ceil(s.length / 4)) : 0;
}

/**
 * Returns usage if valid, otherwise estimates from text lengths.
 * @param {LlmUsage | null | undefined} usage
 * @param {string} promptText
 * @param {string} completionText
 * @returns {LlmUsage}
 */
export function usageWithFallback(usage, promptText, completionText) {
  if (usage && typeof usage === "object" && Number.isFinite(usage.totalTokens) && Number(usage.totalTokens) > 0) {
    return usage;
  }
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const ANTHROPIC_BROWSER_HEADER = { "anthropic-dangerous-direct-browser-access": "true" };

/** @param {Response} res */
export async function readErrorBody(res) {
  const t = await res.text();
  try {
    const j = JSON.parse(t);
    return (
      j.error?.message ??
      j.message ??
      (typeof j.error === "string" ? j.error : null) ??
      j.error?.type ??
      t.slice(0, 280)
    );
  } catch {
    return t.slice(0, 280) || res.statusText;
  }
}

/** OpenAI `choices[0].message.content` → string (handles string or parts array). */
export function openAiContentToString(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const x of content) {
      if (x && typeof x === "object" && typeof x.text === "string" && x.text.length > 0) parts.push(x.text);
    }
    return parts.join("\n");
  }
  if (typeof content === "object" && typeof /** @type {any} */ (content).text === "string") {
    return /** @type {any} */ (content).text;
  }
  return "";
}

/**
 * Merge consecutive same-role messages (OpenAI / Perplexity / Anthropic requirement).
 * @param {Array<{role: string, content: unknown}>} messages
 */
function mergeAdjacentRoles(messages) {
  /** @type {Array<{role: string, content: unknown}>} */
  const out = [];
  for (const m of messages) {
    const role = String(m?.role ?? "user");
    const content = m?.content ?? "";
    if (role === "system") { out.push({ role, content }); continue; }
    if (role !== "user" && role !== "assistant") { out.push({ role, content }); continue; }
    const prev = out[out.length - 1];
    if (prev && prev.role === role && typeof prev.content === "string" && typeof content === "string") {
      prev.content = `${String(prev.content).trim()}\n\n---\n\n${String(content).trim()}`;
    } else {
      out.push({ role, content });
    }
  }
  return out;
}

/**
 * Flatten system prompt + OpenAI-style message array into a single string for Gemini.
 * @param {string} system
 * @param {Array<{role: string, content: string}>} messages
 */
export function geminiFlattenMessages(system, messages) {
  const parts = [];
  if (system) parts.push(`[SYSTEM]\n${system}`);
  const filtered = messages.filter((m) => m.role !== "system");
  const merged = /** @type {Array<{role: string, content: string}>} */ (mergeAdjacentRoles(filtered));
  for (const m of merged) {
    parts.push(`[${String(m.role).toUpperCase()}]\n${String(m.content ?? "")}`);
  }
  return parts.join("\n\n").trim();
}

/**
 * Gemini `generationConfig` varies by model family.
 * @param {string} modelId
 */
export function geminiGenerationConfig(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  if (/\bimagen\b|image-preview|-image|flash-image/.test(id)) return {};
  if (id.includes("gemini-3")) return { thinkingConfig: { thinkingLevel: "low" } };
  return { thinkingConfig: { thinkingBudget: 0 } };
}

/**
 * Build a Gemini generateContent request body from text parts.
 * @param {Array<{text?: string, inlineData?: {mimeType: string, data: string}}>} parts
 * @param {string} modelId
 * @param {boolean} [googleSearch]
 * @param {{ temperature?: number, maxOutputTokens?: number }} [extra]
 */
export function geminiBodyFromParts(parts, modelId, googleSearch = false, extra = {}) {
  const config = /** @type {Record<string, unknown>} */ ({ ...geminiGenerationConfig(modelId) });
  if (extra.temperature != null) config.temperature = extra.temperature;
  if (extra.maxOutputTokens != null) config.maxOutputTokens = extra.maxOutputTokens;
  const body = /** @type {Record<string, unknown>} */ ({
    contents: [{ parts }],
    generationConfig: config,
  });
  if (googleSearch) body.tools = [{ google_search: {} }];
  return body;
}

// ─── Analytics ────────────────────────────────────────────────────────────────

/**
 * @param {string} providerId
 * @param {string} requestKind
 * @param {LlmUsage | null} usage
 * @param {{ dialog_id?: string, conversation_turn_id?: string }} [analytics]
 */
async function recordAux(providerId, requestKind, usage, analytics = {}) {
  if (!usage || typeof usage !== "object") return;
  const pid = String(providerId ?? "").trim();
  if (!pid) return;
  const dialogId = String(analytics?.dialog_id ?? "").trim();
  const turnId = String(analytics?.conversation_turn_id ?? "").trim();
  /** @type {Record<string, unknown>} */
  const body = {
    provider_id: pid,
    request_kind: requestKind,
    llm_prompt_tokens: usage.promptTokens,
    llm_completion_tokens: usage.completionTokens,
    llm_total_tokens: usage.totalTokens,
  };
  if (dialogId) body.dialog_id = dialogId;
  if (turnId) body.conversation_turn_id = turnId;
  try {
    await recordAuxLlmUsage(body);
  } catch (e) {
    console.warn("[mf-lab] Aux analytics failed:", requestKind, e instanceof Error ? e.message : String(e));
  }
}

// ─── callLlm — non-streaming ──────────────────────────────────────────────────

/**
 * Non-streaming LLM call. All providers, usage normalization, optional analytics.
 *
 * @param {{
 *   provider: string,
 *   key: string,
 *   model: string,
 *   messages: Array<{role: string, content: unknown}>,
 *   system?: string,
 *   temperature?: number,
 *   maxTokens?: number,
 *   responseFormat?: { type: string },
 *   tools?: unknown[],
 *   disableSearch?: boolean,
 *   googleSearch?: boolean,
 *   geminiParts?: Array<{text?: string, inlineData?: {mimeType: string, data: string}}>,
 *   withCitations?: boolean,
 *   requestKind?: string | null,
 *   analytics?: { dialog_id?: string, conversation_turn_id?: string },
 *   abortSignal?: AbortSignal | null,
 *   promptBasis?: string,
 * }} opts
 * @returns {Promise<{ text: string, usage: LlmUsage }>}
 */
export async function callLlm(opts) {
  const {
    provider, key, model, messages = [], system,
    temperature, maxTokens, responseFormat, tools,
    disableSearch, googleSearch,
    geminiParts,
    withCitations = false,
    requestKind, analytics = {}, abortSignal,
    promptBasis,
  } = opts;

  let text = "";
  /** @type {LlmUsage | null} */
  let rawUsage = null;
  const basis = promptBasis ?? messages.map((m) => String(m.content ?? "")).join("\n");

  switch (provider) {
    case "openai": {
      const systemMsg = system ? [{ role: "system", content: system }] : [];
      const allMsgs = mergeAdjacentRoles([
        ...systemMsg,
        ...messages.filter((m) => m.role !== "system"),
      ]);
      /** @type {Record<string, unknown>} */
      const body = { model, messages: allMsgs };
      if (temperature != null) body.temperature = temperature;
      if (maxTokens) body.max_completion_tokens = maxTokens;
      if (responseFormat) body.response_format = responseFormat;
      const res = await fetch("/api/llm/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: abortSignal || undefined,
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      text = openAiContentToString(msg?.content);
      if (!text.trim()) throw new Error("Empty API response");
      if (withCitations) {
        const annUrls = collectOpenAiLikeAnnotationUrls(msg);
        text = mergePlainBracketRefsWithCitationList(text, annUrls);
      }
      rawUsage = usageFromOpenAiStyle(data.usage);
      break;
    }

    case "anthropic": {
      const anthMsgs = mergeAdjacentRoles(
        messages.filter((m) => m.role === "user" || m.role === "assistant"),
      );
      /** @type {Record<string, unknown>} */
      const body = { model, max_tokens: maxTokens ?? 4096, messages: anthMsgs };
      if (system) body.system = system;
      if (tools?.length) body.tools = tools;
      const res = await fetch("/api/llm/anthropic/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          ...ANTHROPIC_BROWSER_HEADER,
        },
        body: JSON.stringify(body),
        signal: abortSignal || undefined,
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const blocks = data.content;
      if (!Array.isArray(blocks)) throw new Error("Unexpected response format");
      text = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n").trim();
      if (!text) throw new Error("Empty API response");
      rawUsage = usageFromAnthropic(data);
      break;
    }

    case "gemini-flash": {
      const parts = geminiParts ?? [{ text: geminiFlattenMessages(system ?? "", messages) }];
      const url = `/api/llm/gemini/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBodyFromParts(parts, model, Boolean(googleSearch), {
          temperature,
          maxOutputTokens: maxTokens || undefined,
        })),
        signal: abortSignal || undefined,
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const cand = data.candidates?.[0]?.content?.parts;
      text = Array.isArray(cand)
        ? cand.filter((p) => p && p.thought !== true).map((p) => p.text).filter(Boolean).join("\n").trim()
        : "";
      if (!text) {
        const block = data.promptFeedback?.blockReason;
        throw new Error(block ? `Request blocked: ${block}` : "Empty API response");
      }
      if (withCitations) {
        const { urls, labels } = collectGeminiGroundingEntries(data.candidates?.[0]);
        text = mergePlainBracketRefsWithCitationList(text, urls, { citationLabels: labels });
      }
      rawUsage = usageFromGemini(data);
      break;
    }

    case "perplexity": {
      const systemMsg = system ? [{ role: "system", content: system }] : [];
      const allMsgs = mergeAdjacentRoles([
        ...systemMsg,
        ...messages.filter((m) => m.role !== "system"),
      ]);
      /** @type {Record<string, unknown>} */
      const body = { model, messages: allMsgs };
      if (temperature != null) body.temperature = temperature;
      if (maxTokens) body.max_tokens = maxTokens;
      if (googleSearch) {
        body.disable_search = false;
        body.web_search_options = { search_context_size: "high", search_type: "pro" };
      } else if (disableSearch) {
        body.disable_search = true;
      }
      const res = await fetch("/api/llm/perplexity/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: abortSignal || undefined,
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      text = openAiContentToString(data.choices?.[0]?.message?.content);
      if (!text.trim()) throw new Error("Empty API response");
      if (withCitations) {
        const citeRaw = pickPerplexityCitationPayload(data);
        text = mergePlainBracketRefsWithCitationList(text, citeRaw);
      }
      rawUsage = usageFromOpenAiStyle(data.usage);
      break;
    }

    default:
      throw new Error(`callLlm: unknown provider "${provider}"`);
  }

  const usage = usageWithFallback(rawUsage, basis, text);
  if (requestKind) await recordAux(provider, requestKind, usage, analytics);
  return { text, usage };
}

// ─── callLlmStream — streaming ────────────────────────────────────────────────

/**
 * Streaming LLM call. Calls onDelta for each text chunk. Returns full text + usage on completion.
 *
 * @param {{
 *   provider: string,
 *   key: string,
 *   model: string,
 *   messages: Array<{role: string, content: unknown}>,
 *   system?: string,
 *   maxTokens?: number,
 *   tools?: unknown[],
 *   disableSearch?: boolean,
 *   googleSearch?: boolean,
 *   geminiParts?: Array<{text?: string, inlineData?: {mimeType: string, data: string}}>,
 *   onDelta: (chunk: string) => void,
 *   requestKind?: string | null,
 *   analytics?: { dialog_id?: string, conversation_turn_id?: string },
 *   abortSignal?: AbortSignal | null,
 *   promptBasis?: string,
 * }} opts
 * @returns {Promise<{ text: string, usage: LlmUsage }>}
 */
export async function callLlmStream(opts) {
  const {
    provider, key, model, messages = [], system,
    maxTokens, tools, disableSearch, googleSearch,
    geminiParts,
    onDelta,
    requestKind, analytics = {}, abortSignal,
    promptBasis,
  } = opts;

  const useWebGrounding = Boolean(googleSearch);
  const basis = promptBasis ?? messages.map((m) => String(m.content ?? "")).join("\n");
  let text = "";
  /** @type {LlmUsage | null} */
  let rawUsage = null;

  switch (provider) {
    case "openai": {
      const systemMsg = system ? [{ role: "system", content: system }] : [];
      const allMsgs = mergeAdjacentRoles([
        ...systemMsg,
        ...messages.filter((m) => m.role !== "system"),
      ]);
      const res = await fetch("/api/llm/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: allMsgs,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: abortSignal || undefined,
      });
      const oaStream = await streamOpenAICompatJson(res, onDelta);
      text = mergePlainBracketRefsWithCitationList(oaStream.text, oaStream.citations);
      rawUsage = oaStream.usage ?? null;
      break;
    }

    case "perplexity": {
      const systemMsg = system ? [{ role: "system", content: system }] : [];
      const allMsgs = mergeAdjacentRoles([
        ...systemMsg,
        ...messages.filter((m) => m.role !== "system"),
      ]);
      /** @type {Record<string, unknown>} */
      const body = { model, messages: allMsgs, stream: true };
      if (useWebGrounding) {
        body.disable_search = false;
        body.web_search_options = { search_context_size: "high", search_type: "pro" };
      } else if (disableSearch) {
        body.disable_search = true;
      }
      const res = await fetch("/api/llm/perplexity/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: abortSignal || undefined,
      });
      const pStream = await streamOpenAICompatJson(res, onDelta);
      text = mergePlainBracketRefsWithCitationList(pStream.text, pStream.citations);
      rawUsage = pStream.usage ?? null;
      break;
    }

    case "anthropic": {
      const anthMsgs = mergeAdjacentRoles(
        messages.filter((m) => m.role === "user" || m.role === "assistant"),
      );
      /** @type {Record<string, unknown>} */
      const body = { model, max_tokens: maxTokens ?? 4096, messages: anthMsgs, stream: true };
      if (system) body.system = system;
      if (tools?.length) body.tools = tools;
      const res = await fetch("/api/llm/anthropic/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          ...ANTHROPIC_BROWSER_HEADER,
        },
        body: JSON.stringify(body),
        signal: abortSignal || undefined,
      });
      const anthStream = await streamAnthropicMessages(res, onDelta);
      text = anthStream.text;
      rawUsage = anthStream.usage ?? null;
      break;
    }

    case "gemini-flash": {
      const parts = geminiParts ?? [{ text: geminiFlattenMessages(system ?? "", messages) }];
      const url = `/api/llm/gemini/v1beta/models/${model}:streamGenerateContent?key=${encodeURIComponent(key)}&alt=sse`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(geminiBodyFromParts(parts, model, useWebGrounding)),
        signal: abortSignal || undefined,
      });
      const gStream = await streamGeminiGenerateContent(res, onDelta);
      text = mergePlainBracketRefsWithCitationList(gStream.text, gStream.citations, {
        citationLabels: gStream.citationLabels,
      });
      rawUsage = gStream.usage ?? null;
      break;
    }

    default:
      throw new Error(`callLlmStream: unknown provider "${provider}"`);
  }

  if (!String(text).trim()) throw new Error("Empty API response");
  const usage = usageWithFallback(rawUsage, basis, text);
  if (requestKind) await recordAux(provider, requestKind, usage, analytics);
  return { text, usage };
}
