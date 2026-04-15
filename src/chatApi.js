/**
 * Provider calls via dev/preview proxy `/llm/*` (avoids browser CORS).
 */

import {
  streamAnthropicMessages,
  streamGeminiGenerateContent,
  streamOpenAICompatJson,
} from "./streaming.js";
import { recordAuxLlmUsage, titleFromUserMessage } from "./chatPersistence.js";
import {
  collectGeminiGroundingEntries,
  collectOpenAiLikeAnnotationUrls,
  mergePlainBracketRefsWithCitationList,
  pickPerplexityCitationPayload,
} from "./footnoteCitations.js";
import { getUserAiModel } from "./userChatModels.js";

export const PROVIDER_DISPLAY = {
  openai: "ChatGPT",
  perplexity: "Perplexity",
  "gemini-flash": "Gemini",
  anthropic: "Claude",
};

/**
 * Normalized LLM usage for analytics (optional on every request).
 * @typedef {{ promptTokens: number, completionTokens: number, totalTokens: number }} LlmUsageTotals
 */

/**
 * @param {string} providerId
 * @param {"memory_tree_router" | "interests_sketch" | "memory_graph_normalize" | "intro_graph_extract"} requestKind
 * @param {LlmUsageTotals | null | undefined} usage
 */
function reportAuxLlmUsage(providerId, requestKind, usage) {
  if (!usage || typeof usage !== "object") return;
  const pid = String(providerId ?? "").trim();
  if (!pid) return;
  void recordAuxLlmUsage({
    provider_id: pid,
    request_kind: requestKind,
    llm_prompt_tokens: usage.promptTokens,
    llm_completion_tokens: usage.completionTokens,
    llm_total_tokens: usage.totalTokens,
  }).catch(() => {});
}

/** @param {unknown} u */
export function usageFromOpenAiStyleUsage(u) {
  if (!u || typeof u !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (u);
  const p = Number(o.prompt_tokens);
  const c = Number(o.completion_tokens);
  const t = Number(o.total_tokens);
  if (!Number.isFinite(p) && !Number.isFinite(c) && !Number.isFinite(t)) return null;
  const promptTokens = Number.isFinite(p) ? Math.max(0, Math.floor(p)) : 0;
  const completionTokens = Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 0;
  const totalTokens = Number.isFinite(t)
    ? Math.max(0, Math.floor(t))
    : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

/** @param {unknown} data — top-level Anthropic Messages API JSON */
export function usageFromAnthropicResponse(data) {
  const u = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data).usage : null;
  if (!u || typeof u !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (u);
  const inp = Number(o.input_tokens);
  const outp = Number(o.output_tokens);
  if (!Number.isFinite(inp) && !Number.isFinite(outp)) return null;
  const promptTokens = Number.isFinite(inp) ? Math.max(0, Math.floor(inp)) : 0;
  const completionTokens = Number.isFinite(outp) ? Math.max(0, Math.floor(outp)) : 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/** OpenAI Images API (`/v1/images/*`): `usage` when present (e.g. gpt-image models). */
function usageFromOpenAiImageResponse(data) {
  const u = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data).usage : null;
  if (!u || typeof u !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (u);
  const inp = Number(o.input_tokens ?? o.prompt_tokens);
  const outp = Number(o.output_tokens ?? o.completion_tokens);
  const tot = Number(o.total_tokens);
  if (!Number.isFinite(inp) && !Number.isFinite(outp) && !Number.isFinite(tot)) return null;
  const promptTokens = Number.isFinite(inp) ? Math.max(0, Math.floor(inp)) : 0;
  const completionTokens = Number.isFinite(outp) ? Math.max(0, Math.floor(outp)) : 0;
  const totalTokens = Number.isFinite(tot)
    ? Math.max(0, Math.floor(tot))
    : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

/** @param {unknown} data — top-level Gemini generateContent JSON */
export function usageFromGeminiResponse(data) {
  const um = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data).usageMetadata : null;
  if (!um || typeof um !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (um);
  const p = Number(o.promptTokenCount);
  const c = Number(o.candidatesTokenCount);
  const t = Number(o.totalTokenCount);
  if (!Number.isFinite(p) && !Number.isFinite(c) && !Number.isFinite(t)) return null;
  const promptTokens = Number.isFinite(p) ? Math.max(0, Math.floor(p)) : 0;
  const completionTokens = Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 0;
  const totalTokens = Number.isFinite(t)
    ? Math.max(0, Math.floor(t))
    : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function openAiDialogue() {
  return getUserAiModel("openai", "dialogue");
}
function openAiSearch() {
  return getUserAiModel("openai", "search");
}
function openAiResearch() {
  return getUserAiModel("openai", "research");
}
function openAiImage() {
  return getUserAiModel("openai", "images");
}
/** @param {boolean} ws @param {boolean} dr */
function pickOpenAi(ws, dr) {
  if (dr) return openAiResearch();
  if (ws) return openAiSearch();
  return openAiDialogue();
}

function anthropicDialogue() {
  return getUserAiModel("anthropic", "dialogue");
}
function anthropicSearch() {
  return getUserAiModel("anthropic", "search");
}
function anthropicResearch() {
  return getUserAiModel("anthropic", "research");
}
/** @param {boolean} ws @param {boolean} dr */
function pickAnthropic(ws, dr) {
  if (dr) return anthropicResearch();
  if (ws) return anthropicSearch();
  return anthropicDialogue();
}

function geminiDialogue() {
  return getUserAiModel("gemini", "dialogue");
}
function geminiSearch() {
  return getUserAiModel("gemini", "search");
}
function geminiResearch() {
  return getUserAiModel("gemini", "research");
}
function geminiImage() {
  return getUserAiModel("gemini", "images");
}
/** @param {boolean} ws @param {boolean} dr */
function pickGemini(ws, dr) {
  if (dr) return geminiResearch();
  if (ws) return geminiSearch();
  return geminiDialogue();
}

function perplexityDialogue() {
  return getUserAiModel("perplexity", "dialogue");
}
function perplexitySearch() {
  return getUserAiModel("perplexity", "search");
}
function perplexityResearch() {
  return getUserAiModel("perplexity", "research");
}
/** @param {boolean} ws @param {boolean} dr */
function pickPerplexity(ws, dr) {
  if (dr) return perplexityResearch();
  if (ws) return perplexitySearch();
  return perplexityDialogue();
}

/** Intro Keeper JSON can list many projects + links; small caps truncate mid-JSON → parse failure and nothing ingests. */
const INTRO_GRAPH_EXTRACT_OPENAI_MAX_TOKENS = 12000;
const INTRO_GRAPH_NORMALIZE_OPENAI_MAX_TOKENS = 12000;

/** OpenAI Chat Completions: gpt-5* rejects `max_tokens` — use `max_completion_tokens` (see API error text). */
function oaMaxCompletionTokens(n) {
  return { max_completion_tokens: Math.max(1, Math.floor(Number(n) || 1)) };
}

/** One-line trivial acknowledgements (EN + common RU replies as Unicode escapes; ASCII-only source). */
const TRIVIAL_ACK_LINE_RE =
  /^(thanks|thank you|thx|ok|okay|yes|no|\u0441\u043f\u0430\u0441\u0438\u0431\u043e|\u043e\u043a|\u0434\u0430|\u043d\u0435\u0442|\u043f\u043e\u043d\u044f\u043b|\u043f\u043e\u043d\u044f\u043b\u0430|\u044f\u0441\u043d\u043e)\b[!.\s]*$/iu;
/**
 * Gemini 3+ expects `thinkingLevel` in `thinkingConfig` (cannot use budget 0 to “turn off”).
 * Gemini 2.5 uses `thinkingBudget`; 0 disables internal thinking for lower latency.
 * @see https://ai.google.dev/gemini-api/docs/thinking
 * @param {string} modelId
 * @returns {Record<string, unknown>}
 */
function getGeminiGenerationConfigForModel(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  /* Image / Imagen generateContent surfaces reject thinkingLevel and often thinkingBudget. */
  if (/\bimagen\b|image-preview|-image|flash-image/.test(id)) {
    return {};
  }
  if (id.includes("gemini-3")) {
    return {
      thinkingConfig: {
        thinkingLevel: "low",
      },
    };
  }
  return {
    thinkingConfig: {
      thinkingBudget: 0,
    },
  };
}

/**
 * @param {string} text
 * @param {{ googleSearch?: boolean, modelId?: string }} [opts]
 */
function geminiJsonBody(text, opts = {}) {
  return geminiRequestBodyFromParts([{ text }], opts);
}

/**
 * @param {Array<{ text?: string, inlineData?: { mimeType: string, data: string } }>} parts
 * @param {{ googleSearch?: boolean, modelId?: string }} [opts]
 */
function geminiRequestBodyFromParts(parts, opts = {}) {
  const modelId = String(opts.modelId ?? geminiDialogue());
  const body = {
    contents: [{ parts }],
    generationConfig: getGeminiGenerationConfigForModel(modelId),
  };
  if (opts.googleSearch) {
    body.tools = [{ google_search: {} }];
  }
  return body;
}

/**
 * @param {Array<{ role: string, content: unknown }>} messages
 */
function lastUserMessageIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

/**
 * @param {unknown} c
 */
function stringifyOpenAiLikeContent(c) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((x) => x && x.type === "text" && typeof x.text === "string")
    .map((x) => x.text)
    .join("\n");
}

/**
 * Chat Completions `choices[0].message.content`: string or (some models) array of parts with `text`.
 * Using `String(array)` breaks JSON parsing for Memory tree / Keeper extracts.
 * @param {unknown} content
 * @returns {string}
 */
function openAiChatCompletionMessageContentToString(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const x of content) {
      if (!x || typeof x !== "object") continue;
      if (typeof x.text === "string" && x.text.length > 0) parts.push(x.text);
    }
    return parts.join("\n");
  }
  if (typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

/**
 * Only images are merged into the last user message (attachment text is already in the prompt string).
 * @param {Array<{ role: string, content: unknown }>} messages
 * @param {{ images?: Array<{ mimeType: string, base64: string }> } | null | undefined} att
 */
function applyChatAttachmentsToOpenAiMessages(messages, att) {
  const imgs = Array.isArray(att?.images) ? att.images : [];
  if (imgs.length === 0) {
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }
  const out = messages.map((m) => ({ role: m.role, content: m.content }));
  const ix = lastUserMessageIndex(out);
  const idx = ix >= 0 ? ix : (out.push({ role: "user", content: "" }), out.length - 1);

  const prev = stringifyOpenAiLikeContent(out[idx].content) || String(out[idx].content ?? "");
  const mergedText = prev.trim() || "(Attached images.)";

  /** @type {unknown[]} */
  const parts = [{ type: "text", text: mergedText }];
  for (const im of imgs) {
    const mime = im.mimeType || "image/png";
    parts.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${im.base64}` },
    });
  }
  out[idx] = { role: "user", content: parts };
  return out;
}

/**
 * @param {Array<{ role: string, content: unknown }>} messages
 * @param {{ images?: Array<{ mimeType: string, base64: string }> } | null | undefined} att
 */
function applyChatAttachmentsToAnthropicMessages(messages, att) {
  const imgs = Array.isArray(att?.images) ? att.images : [];
  if (imgs.length === 0) {
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }
  const out = messages.map((m) => ({ role: m.role, content: m.content }));
  const ix = lastUserMessageIndex(out);
  const idx = ix >= 0 ? ix : (out.push({ role: "user", content: "" }), out.length - 1);

  const prev =
    typeof out[idx].content === "string"
      ? out[idx].content
      : stringifyOpenAiLikeContent(out[idx].content);
  const mergedText = String(prev ?? "").trim() || "(Attached images.)";

  /** @type {unknown[]} */
  const blocks = [{ type: "text", text: mergedText }];
  for (const im of imgs) {
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: im.mimeType || "image/png",
        data: im.base64,
      },
    });
  }
  out[idx] = { role: "user", content: blocks };
  return out;
}

/** Anthropic requirement for browser calls (including via /llm/anthropic proxy). */
const ANTHROPIC_BROWSER_ACCESS_HEADER = {
  "anthropic-dangerous-direct-browser-access": "true",
};

/**
 * @param {string} modelId
 * @param {string} trimmed
 * @param {string} key
 * @param {boolean} [googleSearch]
 * @param {{ images?: Array<{ mimeType: string, base64: string }> } | null} [chatAtt]
 */
async function geminiGenerateContent(modelId, trimmed, key, googleSearch = false, chatAtt = null) {
  const imgs = Array.isArray(chatAtt?.images) ? chatAtt.images : [];
  /** @type {Array<{ text?: string, inlineData?: { mimeType: string, data: string } }>} */
  const parts = [{ text: trimmed }];
  for (const im of imgs) {
    parts.push({
      inlineData: {
        mimeType: im.mimeType || "image/png",
        data: im.base64,
      },
    });
  }
  const url = `/llm/gemini/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(geminiRequestBodyFromParts(parts, { googleSearch, modelId })),
  });
  if (!res.ok) throw new Error(await readErrorBody(res));
  const data = await res.json();
  const cand = data.candidates?.[0]?.content?.parts;
  const out = Array.isArray(cand)
    ? cand
        .filter((p) => p && p.thought !== true)
        .map((p) => p.text)
        .filter(Boolean)
        .join("\n")
        .trim()
    : "";
  if (!out) {
    const block = data.promptFeedback?.blockReason;
    throw new Error(block ? `Request blocked: ${block}` : "Empty API response");
  }
  const { urls: groundingUrls, labels: groundingLabels } = collectGeminiGroundingEntries(
    data.candidates?.[0],
  );
  return {
    text: mergePlainBracketRefsWithCitationList(out, groundingUrls, {
      citationLabels: groundingLabels,
    }),
    usage: usageFromGeminiResponse(data),
  };
}

/**
 * Chat Completions / Perplexity: after `system`, `user` and `assistant` must alternate.
 * Merges consecutive same-named roles (except `system`) into one message.
 * @param {Array<{ role: string, content: string }>} messages
 * @returns {Array<{ role: string, content: string }>}
 */
function mergeAdjacentSameRoleForChatApi(messages) {
  /** @type {Array<{ role: string, content: string }>} */
  const out = [];
  for (const m of messages) {
    const role = String(m?.role ?? "user");
    const content = String(m?.content ?? "");
    if (role === "system") {
      out.push({ role: "system", content });
      continue;
    }
    if (role !== "user" && role !== "assistant") {
      out.push({ role, content });
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && prev.role === role) {
      prev.content = `${String(prev.content).trim()}\n\n---\n\n${content.trim()}`;
    } else {
      out.push({ role, content });
    }
  }
  return out;
}

/**
 * @param {string} trimmed — fallback single user message when llmMessages is absent
 * @param {{ systemInstruction?: string, llmMessages?: Array<{ role: string, content: string }> }} options
 */
function openAiCompatMessages(trimmed, options) {
  /** @type {Array<{ role: string, content: string }>} */
  const messages = [];
  if (options.systemInstruction) {
    messages.push({ role: "system", content: options.systemInstruction });
  }
  if (Array.isArray(options.llmMessages) && options.llmMessages.length > 0) {
    messages.push(...options.llmMessages);
  } else {
    messages.push({ role: "user", content: trimmed });
  }
  return mergeAdjacentSameRoleForChatApi(messages);
}

/**
 * @param {string} trimmed
 * @param {{ systemInstruction?: string, llmMessages?: Array<{ role: string, content: string }> }} options
 */
function anthropicApiMessages(trimmed, options) {
  const raw =
    Array.isArray(options.llmMessages) && options.llmMessages.length > 0
      ? options.llmMessages
      : [{ role: "user", content: trimmed }];
  const filtered = raw.filter((m) => m.role === "user" || m.role === "assistant");
  return mergeAdjacentSameRoleForChatApi(filtered);
}

/**
 * @param {string} systemInstruction
 * @param {Array<{ role: string, content: string }>} msgs
 */
function geminiFlattenChat(systemInstruction, msgs) {
  const parts = [];
  if (systemInstruction) parts.push(`[SYSTEM]\n${systemInstruction}`);
  const merged = Array.isArray(msgs) ? mergeAdjacentSameRoleForChatApi(msgs) : [];
  for (const m of merged) {
    parts.push(`[${String(m.role).toUpperCase()}]\n${m.content}`);
  }
  return parts.join("\n\n").trim();
}

async function readErrorBody(res) {
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

/**
 * User-facing OpenAI image error text for the chat UI.
 * @param {string} raw
 * @param {number} [status]
 */
function humanizeOpenAiImageError(raw, status) {
  const s = String(raw ?? "").trim();
  const low = s.toLowerCase();
  if (low.includes("server had an error") || low.includes("sorry about that")) {
    const tail = s.length > 400 ? `${s.slice(0, 400)}…` : s;
    return (
      "OpenAI returned a server error while generating the image. " +
      "Check model access and organization verification in the OpenAI dashboard if needed. " +
      `API message: ${tail}`
    );
  }
  if (low.includes("rate_limit") || low.includes("too many requests") || status === 429) {
    return "Too many requests to OpenAI. Wait a moment and try again.";
  }
  if (
    low.includes("insufficient_quota") ||
    low.includes("exceeded your current quota") ||
    (low.includes("billing") && low.includes("openai"))
  ) {
    return "Check your OpenAI API billing and quota.";
  }
  if (low.includes("invalid_api_key") || low.includes("incorrect api key")) {
    return "Invalid or revoked OpenAI API key in .env.";
  }
  if (
    low.includes("model_not_found") ||
    (low.includes("model") && (low.includes("not found") || low.includes("does not exist")))
  ) {
    return (
      `Model ${openAiImage()} is not available for this key or region. ` +
      `API response: ${s.length > 220 ? `${s.slice(0, 220)}…` : s}`
    );
  }
  if (low.includes("must be verified") || low.includes("organization must be verified")) {
    return (
      "Image generation may require organization verification in the OpenAI developer dashboard. " +
      (s.length > 200 ? `${s.slice(0, 200)}…` : s)
    );
  }
  if (low.includes("content_policy") || low.includes("content_policy_violation")) {
    return "Request rejected by OpenAI content policy. Try a different prompt.";
  }
  if (!s) {
    return status
      ? `Could not generate image (HTTP ${status}).`
      : "Could not generate image.";
  }
  if (s.length > 280) return `${s.slice(0, 280)}…`;
  return s;
}

/**
 * @param {string} providerId
 * @param {string} text
 * @param {string} apiKey
 * @param {{ webSearch?: boolean, deepResearch?: boolean, systemInstruction?: string, llmMessages?: Array<{ role: string, content: string }>, chatAttachments?: { images?: Array<{ mimeType: string, base64: string }> }, accessDataDumpMode?: boolean }} [options] — webSearch/deepResearch: search-capable models where supported; llmMessages: assembled thread context; chatAttachments: images for the last user turn (file text is already in `text`); accessDataDumpMode: #data lockdown
 * @returns {Promise<{ text: string, usage: LlmUsageTotals | null }>}
 */
export async function completeChatMessage(providerId, text, apiKey, options = {}) {
  const key = String(apiKey ?? "").trim();
  if (!key) {
    throw new Error("No API key for the selected model (.env)");
  }
  const trimmed = text.trim();
  const hasLlm = Array.isArray(options.llmMessages) && options.llmMessages.length > 0;
  const hasAttImg = (options.chatAttachments?.images?.length ?? 0) > 0;
  if (!hasLlm && !trimmed && !hasAttImg) {
    throw new Error("Empty message");
  }
  const lockdown = Boolean(options.accessDataDumpMode);
  const webSearch = Boolean(options.webSearch) && !lockdown;
  const deepResearch = Boolean(options.deepResearch) && !lockdown;
  const useWebGrounding = webSearch || deepResearch;
  const oaMsgs = applyChatAttachmentsToOpenAiMessages(
    openAiCompatMessages(trimmed, options),
    options.chatAttachments,
  );

  switch (providerId) {
    case "openai": {
      const res = await fetch("/llm/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: pickOpenAi(webSearch, deepResearch),
          messages: oaMsgs,
        }),
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      const rawText = openAiChatCompletionMessageContentToString(content);
      if (!rawText.trim()) throw new Error("Empty API response");
      const annUrls = collectOpenAiLikeAnnotationUrls(data.choices?.[0]?.message);
      return {
        text: mergePlainBracketRefsWithCitationList(rawText, annUrls),
        usage: usageFromOpenAiStyleUsage(data.usage),
      };
    }
    case "anthropic": {
      const anthropicBody = {
        model: pickAnthropic(webSearch, deepResearch),
        max_tokens: 4096,
        messages: applyChatAttachmentsToAnthropicMessages(
          anthropicApiMessages(trimmed, options),
          options.chatAttachments,
        ),
      };
      if (options.systemInstruction) {
        anthropicBody.system = options.systemInstruction;
      }
      if (useWebGrounding) {
        anthropicBody.tools = [
          { type: "web_search_20250305", name: "web_search", max_uses: 5 },
        ];
      }
      const res = await fetch("/llm/anthropic/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          ...ANTHROPIC_BROWSER_ACCESS_HEADER,
        },
        body: JSON.stringify(anthropicBody),
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const blocks = data.content;
      if (!Array.isArray(blocks)) throw new Error("Unexpected response format");
      const textParts = blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text);
      const out = textParts.join("\n").trim();
      if (!out) throw new Error("Empty API response");
      return { text: out, usage: usageFromAnthropicResponse(data) };
    }
    case "gemini-flash": {
      const gMsgs =
        Array.isArray(options.llmMessages) && options.llmMessages.length > 0
          ? options.llmMessages
          : [{ role: "user", content: trimmed }];
      const combined = geminiFlattenChat(String(options.systemInstruction ?? ""), gMsgs);
      return geminiGenerateContent(
        pickGemini(webSearch, deepResearch),
        combined,
        key,
        useWebGrounding,
        options.chatAttachments,
      );
    }
    case "perplexity": {
      const perplexityBody = {
        model: pickPerplexity(webSearch, deepResearch),
        messages: oaMsgs,
      };
      if (useWebGrounding) {
        perplexityBody.disable_search = false;
        perplexityBody.web_search_options = {
          search_context_size: "high",
          search_type: "pro",
        };
      } else if (lockdown) {
        perplexityBody.disable_search = true;
      }
      const res = await fetch("/llm/perplexity/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(perplexityBody),
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      const rawText = openAiChatCompletionMessageContentToString(content);
      if (!rawText.trim()) throw new Error("Empty API response");
      const citeRaw = pickPerplexityCitationPayload(data);
      const withCites = mergePlainBracketRefsWithCitationList(rawText, citeRaw);
      return { text: withCites, usage: usageFromOpenAiStyleUsage(data.usage) };
    }
    default:
      throw new Error("Unknown provider");
  }
}

/** System prompt for a short theme/dialog title (5–6 words). */
const THEME_TITLE_SYSTEM =
  "Reply with ONLY a short phrase of exactly 5-6 words: a clear label for what the user wants. " +
  "Use the same language as the user when possible. No quotes. No explanation. No trailing period.";

/**
 * Normalizes the model reply into a theme/dialog title.
 * @param {string} raw
 */
export function normalizeThemeDialogTitle(raw) {
  let s = String(raw ?? "").trim();
  s = s.replace(/^["'"„«»]+|["'"„«»]+$/g, "").trim();
  s = s.replace(/\s+/g, " ");
  if (!s) return "New conversation";
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 6) s = words.slice(0, 6).join(" ");
  if (s.length > 90) s = `${s.slice(0, 87)}…`;
  return s;
}

/**
 * Short theme and first-dialog title from the user request (via the selected provider).
 * On API error, falls back to the first line of the message.
 * @param {string} providerId
 * @param {string} userMessage
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
export async function generateThemeDialogTitle(providerId, userMessage, apiKey) {
  const key = String(apiKey ?? "").trim();
  const snippet = String(userMessage ?? "").trim().slice(0, 3500);
  if (!key || !snippet) {
    return titleFromUserMessage(userMessage);
  }

  try {
    let text = "";
    switch (providerId) {
      case "openai": {
        const res = await fetch("/llm/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: openAiDialogue(),
            temperature: 0.2,
            ...oaMaxCompletionTokens(48),
            messages: [
              { role: "system", content: THEME_TITLE_SYSTEM },
              { role: "user", content: snippet },
            ],
          }),
        });
        if (!res.ok) throw new Error(await readErrorBody(res));
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        text = openAiChatCompletionMessageContentToString(content);
        if (!text.trim()) throw new Error("Empty API response");
        break;
      }
      case "anthropic": {
        const res = await fetch("/llm/anthropic/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            ...ANTHROPIC_BROWSER_ACCESS_HEADER,
          },
          body: JSON.stringify({
            model: anthropicDialogue(),
            max_tokens: 48,
            system: THEME_TITLE_SYSTEM,
            messages: [{ role: "user", content: snippet }],
          }),
        });
        if (!res.ok) throw new Error(await readErrorBody(res));
        const data = await res.json();
        const blocks = data.content;
        if (!Array.isArray(blocks)) throw new Error("Unexpected response format");
        text = blocks
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (!text) throw new Error("Empty API response");
        break;
      }
      case "gemini-flash": {
        const combined =
          `${THEME_TITLE_SYSTEM}\n\nUser message:\n${snippet}`;
        const { text: g } = await geminiGenerateContent(geminiDialogue(), combined, key, false);
        text = g;
        break;
      }
      case "perplexity": {
        const res = await fetch("/llm/perplexity/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: perplexityDialogue(),
            temperature: 0.2,
            max_tokens: 48,
            messages: [
              { role: "system", content: THEME_TITLE_SYSTEM },
              { role: "user", content: snippet },
            ],
          }),
        });
        if (!res.ok) throw new Error(await readErrorBody(res));
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        text = openAiChatCompletionMessageContentToString(content);
        if (!text.trim()) throw new Error("Empty API response");
        break;
      }
      default:
        return titleFromUserMessage(userMessage);
    }
    const normalized = normalizeThemeDialogTitle(text);
    return normalized === "New conversation" ? titleFromUserMessage(userMessage) : normalized;
  } catch {
    return titleFromUserMessage(userMessage);
  }
}

const INTRO_GRAPH_ALLOWED = new Set([
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

const GRAPH_COMMAND_OPS = new Set(["mergeNodes", "deleteNode", "renameNode", "deleteEdge", "moveEdge"]);

/**
 * @param {unknown} obj
 * @returns {{ category: string, label: string } | null}
 */
function normalizeGraphCommandEndpoint(obj) {
  if (!obj || typeof obj !== "object") return null;
  let category = String(obj.category ?? "").trim();
  if (!INTRO_GRAPH_ALLOWED.has(category)) category = "Other";
  const label = String(obj.label ?? "").trim().slice(0, 200);
  if (!label) return null;
  return { category, label };
}

/**
 * Server applies the same subset after validation in api.mjs.
 * @param {unknown} raw
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeGraphCommands(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const c of raw.slice(0, 50)) {
    if (!c || typeof c !== "object") continue;
    const op = String(c.op ?? "").trim();
    if (!GRAPH_COMMAND_OPS.has(op)) continue;
    if (op === "mergeNodes") {
      const from = normalizeGraphCommandEndpoint(c.from);
      const into = normalizeGraphCommandEndpoint(c.into);
      if (!from || !into) continue;
      if (from.category === into.category && from.label === into.label) continue;
      out.push({ op: "mergeNodes", from, into });
    } else if (op === "deleteNode") {
      let category = String(c.category ?? "").trim();
      if (!INTRO_GRAPH_ALLOWED.has(category)) category = "Other";
      const label = String(c.label ?? "").trim().slice(0, 200);
      if (!label) continue;
      out.push({ op: "deleteNode", category, label });
    } else if (op === "renameNode") {
      let category = String(c.category ?? "").trim();
      if (!INTRO_GRAPH_ALLOWED.has(category)) category = "Other";
      const fromLabel = String(c.fromLabel ?? "").trim().slice(0, 200);
      const toLabel = String(c.toLabel ?? "").trim().slice(0, 200);
      if (!fromLabel || !toLabel || fromLabel === toLabel) continue;
      out.push({ op: "renameNode", category, fromLabel, toLabel });
    } else if (op === "deleteEdge") {
      const from = normalizeGraphCommandEndpoint(c.from);
      const to = normalizeGraphCommandEndpoint(c.to);
      if (!from || !to) continue;
      const relation = c.relation != null ? String(c.relation).trim().slice(0, 200) : "";
      out.push({ op: "deleteEdge", from, to, relation });
    } else if (op === "moveEdge") {
      const oldFrom = normalizeGraphCommandEndpoint(c.oldFrom);
      const oldTo = normalizeGraphCommandEndpoint(c.oldTo);
      const newFrom = normalizeGraphCommandEndpoint(c.newFrom);
      const newTo = normalizeGraphCommandEndpoint(c.newTo);
      if (!oldFrom || !oldTo || !newFrom || !newTo) continue;
      const relation = String(c.relation ?? "").trim().slice(0, 200) || "related";
      out.push({ op: "moveEdge", oldFrom, oldTo, newFrom, newTo, relation });
    }
  }
  return out;
}

const INTRO_GRAPH_EXTRACT_SYSTEM =
  'You are the **Keeper** — the Intro step that prepares memory-tree updates. **Only the human user\'s words matter.** Do **not** use, summarize, or infer from any assistant/model text — you will receive **user text only**.\n' +
  'You extract a small knowledge graph from the USER\'s **latest message alone** in the Intro onboarding chat.\n' +
  "**Every** user message counts: whenever the user states a fact, names something, or gives a **graph command** (add/merge/fix/remove/relink — any language), reflect it in entities/links for this turn.\n" +
  "Treat **each** USER turn as important: extract **every** graph-worthy fact from **this** turn (not only generic chit-chat).\n" +
  "**Anti-clones:** never emit two entities that are the same real-world thing under trivial label variants (same country, city, person, or topic twice in one payload). One canonical short label per referent.\n" +
  'Return ONE JSON object with keys "entities", "links", and optional "commands".\n' +
  '"entities": array of { "category": string, "label": string, "notes": string }.\n' +
  '"links": array of { "from": { "label": string, "category": string }, "to": { "label": string, "category": string }, "relation": string }.\n' +
  '"commands" (optional): structural operations the server runs exactly — mergeNodes, deleteNode, renameNode, deleteEdge, moveEdge — same field shapes as in the normalize system message (use exact op names and category+label endpoints).\n' +
  'When the user clearly orders merge/delete/rename/move/remove edge, you **must** include matching commands entries (any language).\n' +
  "\n" +
  "Rules:\n" +
  '- Anchor the account owner as ONE node only: category "People", label exactly "User" (fixed graph key for this product). Put first-person facts, names, aliases, and any stated equivalence to the account in that entity\'s "notes" and in links from User only — do **not** add another People node for the same account holder under any other title.\n' +
  '- **Structure broad → narrow:** avoid unrelated floating nodes. Example: a specific date about a child must link **People (child)** → **Dates (year or era)** → **Dates (specific day)** as appropriate, and tie the child (or event) to **User** when it is the user\'s family. Do **not** emit a bare year or bare calendar date with **no** links when it clearly belongs to a person or event chain.\n' +
  '- "label" must be SHORT for other graph nodes: People (other than User) = given name and family name if both known; Dates = ISO date or a very short date-like phrase; Cities = city name only; Countries = country name only; Companies = company name; Projects = project title; otherwise a short noun phrase (max ~48 characters).\n' +
  '- "category" must be exactly one of: People, Dates, Cities, Countries, Companies, Projects, Interests, Documents, Data, Other.\n' +
  "- Extract only facts the USER clearly states or clearly implies; do not invent.\n" +
  '- "notes": one short factual clause grounded in the user message (may echo context).\n' +
  '- "links" only when the user clearly relates two of your entities; "relation": brief verb phrase (e.g. "works at", "lives in", "born on"). Prefer linking new entities to "User" when the fact is about the user.\n' +
  '- **Shows / series / films / games / IPs:** Each **named production** the user cites (animated series, game tie-in show, franchise title in any language) → one **Projects** node with a short canonical **label** (official title or best-known short name) and factual **notes**; link **User** → that project (e.g. "worked on", "contributed to", "conceived format for"). If they name a **studio or employer**, use **Companies** and link User → Company and optionally Company → Project.\n' +
  '- For category "Interests" in Intro, use only BROAD umbrella labels (1–3 words, e.g. "Astronomy" not a minor celestial body name); link them to the hub { "category": "Interests", "label": "Interests" } with relation "under" when such a hub appears in your output.\n' +
  '- If the USER asks to **add, remove, merge, relink, or fix** something in the memory graph, in **any language or writing system**, output entities and links that express that request so it can be applied — do not return empty only because the wording was not in English.\n' +
  '- If nothing graph-worthy in this turn: {"entities":[],"links":[],"commands":[]}.\n' +
  "Output JSON only.";

const CHAT_INTEREST_SKETCH_EXTRACT_SYSTEM =
  'You are part of the **Keeper** pipeline for normal chats: **Interests only**. **Only the human user\'s latest message matters** — do not use assistant/model text or inferred dialog summaries; you receive **user text only**.\n' +
  'You update a **lightweight interest sketch** for a normal (non-Intro) chat. This is NOT an encyclopedia: only a **small** interest graph.\n' +
  'Return ONE JSON object with keys "entities" and "links" only.\n' +
  '"entities": array of { "category": string, "label": string, "notes": string }.\n' +
  '"links": array of { "from": { "label": string, "category": string }, "to": { "label": string, "category": string }, "relation": string }.\n' +
  "\n" +
  "Rules:\n" +
  '- **Only** category "Interests" for every entity.\n' +
  '- Add **at most two** new interest labels per call (besides using the hub only as a link target), both inferred **only from this USER message**:\n' +
  '  (1) **Global umbrella** — one broad life/domain theme (1–4 words, USER\'s language).\n' +
  '  (2) **Thread topic branch** — one broad headline for what the user is talking about **in this message** (still an umbrella-level label under Interests; not facts, lists, people, places, dates, or episode detail).\n' +
  '- If the turn is pure small talk or nothing thematic: return {"entities":[],"links":[]}.\n' +
  '- Links (all ends category "Interests"): link **thread topic → umbrella** with relation "within scope of"; link **umbrella → hub** { "category": "Interests", "label": "Interests" } with relation "under". If only one level is justified, output a single umbrella entity and link it "under" the hub only.\n' +
  '- Do **not** add entities for trivia, proper nouns of episodes, cast, dates, or anything that would bloat the graph — those belong elsewhere, not here.\n' +
  '- "notes": one short clause for each entity.\n' +
  "Output JSON only.";

/**
 * @param {{ entities: Array<{ category: string, label: string, notes: string }>, links: Array<{ from: { label: string, category: string }, to: { label: string, category: string }, relation: string }> }} pack
 */
function clampGraphPayloadToInterestsOnly(pack) {
  const c = "Interests";
  return {
    entities: pack.entities.map((e) => ({ ...e, category: c })),
    links: pack.links.map((ln) => ({
      relation: ln.relation,
      from: { label: ln.from.label, category: c },
      to: { label: ln.to.label, category: c },
    })),
    commands: [],
  };
}

/**
 * From a normal chat: one broad interest umbrella + one thread headline from **one** user message (light Interests-only graph).
 * @param {string} providerId
 * @param {string} apiKey
 * @param {string} userText
 */
const ACCESS_KEEPER2_EXTRACT_SYSTEM =
  "You are **Keeper 2** for the **Access** section of the app.\n" +
  "You read the **full conversation** (USER and ASSISTANT lines) in the Access thread.\n" +
  "Your job: extract **third-party** services the human is configuring — HTTP APIs, hosted inference or media pipelines, async job/queue endpoints, geocoding, weather, and **their** API keys, tokens, or auth headers the user stated (e.g. `Authorization: Key …`, `Bearer …`).\n" +
  "Put the secret material in `accessKey` when it is a key/token/header value; put base URLs, queue URLs, or doc links in `endpointUrl` when that fits.\n" +
  "**Markdown / bullet inventories:** If the user pastes a **list** of public data APIs (lines with `•`, `-`, em-dash `—`, service name + **domain or URL** + short blurb), treat **each distinct service** as one `entries` row. Use `https://…` in `endpointUrl` when the user gave only a hostname (e.g. `api.example.com/v1` → `https://api.example.com/v1`). `accessKey` may be empty for free/no-key APIs. Put the original line or extra hints in `notes` when helpful.\n" +
  "**Never** extract or invent: OpenAI / Anthropic / Google Gemini / Perplexity keys, this app’s `.env` layout, or internal LLM routing — only **external** products the user named.\n" +
  "If the user clearly added or updated one or more third-party services (including a bulk list) in the last turns, you **must** output a non-empty `entries` array with one object per distinct service you can tie to a name and/or URL — do **not** return {\"entries\":[]} out of caution.\n" +
  "If this turn truly adds nothing identifiable (no names, no domains, no URLs), return {\"entries\":[]}.\n" +
  "When updating an existing service (see EXISTING_STORE_SUMMARY_JSON), reuse the same short **name** so records can merge.\n" +
  'Output **one** JSON object: { "entries": [ { "name": string, "description": string, "endpointUrl": string, "accessKey": string, "notes": string } ] }.\n' +
  "- `name`: short unique title for the service (user language).\n" +
  "- `description`: what the service is for (one or two sentences).\n" +
  "- `endpointUrl`: base URL, queue URL, or primary endpoint; empty string only if none given.\n" +
  "- `accessKey`: API key, token, or literal `Authorization: …` line for **that** external service only; empty string only if none mentioned.\n" +
  "- `notes`: optional long text (examples, sample HTTP requests, vendor-specific headers or flags the user mentioned, model lists, warnings) copied or summarized from the conversation — **not** a substitute for putting secrets in `accessKey` when they are explicit.\n" +
  "At most **32** entries per response; if the user pasted many services in one message, include as many distinct rows as fit (up to 32), prioritizing clearly named URLs/keys from the latest user turns.\n" +
  "Output JSON only, no markdown fences.";

const ACCESS_KEEPER_NOTES_MAX = 12000;

/**
 * @param {unknown} raw
 * @returns {Array<{ name: string, description: string, endpointUrl: string, accessKey: string, notes: string }>}
 */
function normalizeAccessKeeperEntriesFromRaw(raw) {
  /** @type {Array<{ name: string, description: string, endpointUrl: string, accessKey: string, notes: string }>} */
  const out = [];
  if (!raw || typeof raw !== "object") return out;
  const arr = Array.isArray(raw.entries) ? raw.entries : [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const name = String(e.name ?? "").trim().slice(0, 200);
    if (!name) continue;
    out.push({
      name,
      description: String(e.description ?? "").trim().slice(0, 2000),
      endpointUrl: String(e.endpointUrl ?? e.endpoint_or_url ?? "").trim().slice(0, 2000),
      accessKey: String(e.accessKey ?? e.access_key ?? e.credential ?? "").trim().slice(0, 2000),
      notes: String(e.notes ?? "").trim().slice(0, ACCESS_KEEPER_NOTES_MAX),
    });
  }
  return out.slice(0, 32);
}

/** Strip leading bullets / numbering from a list line. */
function stripAccessListLinePrefix(s) {
  return String(s ?? "")
    .replace(/^[\s\u2022\u2023\u25CF\u25E6\u25AA\*\u2014\u2013\-]+(?:\d{1,2}[\.\)])?\s*/u, "")
    .trim();
}

/**
 * When the LLM extractor returns nothing, infer rows from a **bulk paste**: lines like
 * `• Name — host.com/path — description` (em dash) or lines containing `https://…` / a plausible hostname.
 * @param {string} text — usually the latest user message in Access
 * @returns {Array<{ name: string, description: string, endpointUrl: string, accessKey: string, notes: string }>}
 */
export function extractAccessExternalServiceStubsFromBulkListText(text) {
  const raw = String(text ?? "").trim();
  if (raw.length < 24) return [];
  const seen = new Set();
  /** @type {Array<{ name: string, description: string, endpointUrl: string, accessKey: string, notes: string }>} */
  const out = [];
  const dashSplit = /\s*[\u2014\u2013]\s*/;
  /** @param {string} line */
  const splitListLine = (line) => {
    if (/[\u2014\u2013]/.test(line)) return line.split(dashSplit).map((p) => p.trim()).filter(Boolean);
    if (/\s-\s/.test(line)) return line.split(/\s-\s/).map((p) => p.trim()).filter(Boolean);
    return [];
  };
  for (const line0 of raw.split(/\r?\n/)) {
    const line = line0.trim();
    if (line.length < 12) continue;
    if (/^(🌍|💰|🚀|📊|👥|📈|🏥|⚡|✅|❗)\s+[^\n•]{0,80}$/u.test(line) && !/[a-z0-9]+\.[a-z]{2,}/i.test(line)) {
      continue;
    }

    let name = "";
    let description = "";
    let endpointUrl = "";
    const parts = splitListLine(line);

    if (parts.length >= 3) {
      name = stripAccessListLinePrefix(parts[0]).slice(0, 200);
      let hostPart = parts[1].replace(/\s+/g, "");
      const rest = parts.slice(2).join(" — ").trim();
      if (hostPart.length >= 4 && hostPart.includes(".") && /^[a-z0-9./:_-]+$/i.test(hostPart)) {
        endpointUrl = /^https?:\/\//i.test(hostPart) ? hostPart : `https://${hostPart}`;
        description = rest.slice(0, 2000);
      }
    }

    if (!endpointUrl) {
      const urlM = line.match(/https?:\/\/[^\s\])'",]+/i);
      if (urlM) {
        endpointUrl = urlM[0].replace(/[,;]+$/, "").slice(0, 2000);
        name = stripAccessListLinePrefix(line.slice(0, urlM.index))
          .replace(/\s*[\u2014\u2013]\s*$/u, "")
          .trim()
          .slice(0, 200);
        description = line
          .slice(urlM.index + urlM[0].length)
          .replace(/^[\s\u2014\u2013:.-]+/u, "")
          .trim()
          .slice(0, 2000);
      } else {
        const dom = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})(\/[^\s\])'",]*)?\b/i.exec(line);
        if (dom) {
          const host = (dom[1] + (dom[2] || "")).replace(/[,;]+$/, "");
          if (host.length >= 5) {
            endpointUrl = `https://${host}`.slice(0, 2000);
            name = stripAccessListLinePrefix(line.slice(0, dom.index))
              .replace(/\s*[\u2014\u2013]\s*$/u, "")
              .trim()
              .slice(0, 200);
            if (!name) name = dom[1].slice(0, 200);
            description = line
              .slice(dom.index + dom[0].length)
              .replace(/^[\s\u2014\u2013:.-]+/u, "")
              .trim()
              .slice(0, 2000);
          }
        }
      }
    }

    if (!endpointUrl || !/^https?:\/\//i.test(endpointUrl)) continue;
    let dedupeKey = "";
    try {
      const u = new URL(endpointUrl);
      dedupeKey = `${u.hostname}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
    } catch {
      continue;
    }
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    if (!name) {
      try {
        name = new URL(endpointUrl).hostname.slice(0, 200);
      } catch {
        name = "API";
      }
    }
    if (!description) description = line.slice(0, 600).trim().slice(0, 2000);

    out.push({
      name,
      description,
      endpointUrl,
      accessKey: "",
      notes: line.slice(0, Math.min(line.length, ACCESS_KEEPER_NOTES_MAX)),
    });
    if (out.length >= 48) break;
  }
  return out;
}

/**
 * @param {string} text
 * @returns {{ entries: Array<{ name: string, description: string, endpointUrl: string, accessKey: string }> }}
 */
function parseAccessKeeperJsonFromModelText(text) {
  try {
    let s = String(text ?? "").trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const j = JSON.parse(s);
    return { entries: normalizeAccessKeeperEntriesFromRaw(j) };
  } catch (e) {
    console.warn(
      "[Access Keeper 2] JSON parse failed:",
      e instanceof Error ? e.message : String(e),
      String(text ?? "").slice(0, 240),
    );
    return { entries: [] };
  }
}

/**
 * Keeper 2: structured external-service rows from the Access thread transcript.
 * @param {string} providerId
 * @param {string} apiKey
 * @param {string} transcript
 * @param {string} existingSummaryJson
 */
export async function extractAccessKeeper2EntriesFromTranscript(
  providerId,
  apiKey,
  transcript,
  existingSummaryJson,
) {
  const key = String(apiKey ?? "").trim();
  const t = String(transcript ?? "").trim().slice(0, 72000);
  if (!key || !t) {
    return { entries: [] };
  }
  const ex = String(existingSummaryJson ?? "").trim().slice(0, 12000);
  const userBlock =
    `EXISTING_STORE_SUMMARY_JSON:\n${ex || "[]"}\n\n` + `CONVERSATION:\n${t}`;

  try {
    if (providerId === "openai") {
      const res = await fetch("/llm/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: openAiDialogue(),
          temperature: 0.1,
          ...oaMaxCompletionTokens(12000),
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: ACCESS_KEEPER2_EXTRACT_SYSTEM },
            { role: "user", content: userBlock },
          ],
        }),
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      const rawText = openAiChatCompletionMessageContentToString(content);
      if (!rawText.trim()) throw new Error("Empty API response");
      return parseAccessKeeperJsonFromModelText(rawText);
    }

    const { text } = await completeChatMessage(providerId, userBlock, key, {
      systemInstruction: `${ACCESS_KEEPER2_EXTRACT_SYSTEM}\nRespond with a single JSON object only, no markdown fences.`,
    });
    return parseAccessKeeperJsonFromModelText(text);
  } catch (e) {
    console.warn("[Access Keeper 2] extract request failed:", e instanceof Error ? e.message : String(e));
    return { entries: [] };
  }
}

const RULES_KEEPER3_ITEM_MAX = 4000;
const RULES_KEEPER3_EXTRACT_SYSTEM =
  "You are a **background Rules extractor** for this app (not shown to the user).\n" +
  "The user payload has **Section A**: every **USER** message from the Rules thread, oldest first, each in its own block. " +
  "In Rules, **each** of those messages must be **evaluated**: does it add, change, or remove project conduct for assistants? " +
  "If it is **only** thanks, ok, emoji, or empty acknowledgement with **no** new normative content, emit **nothing** from that block. " +
  "Otherwise extract — even one short sentence can yield one or more atomic rules. Do **not** skip a block because it is brief.\n" +
  "**Section B** is the full USER+ASSISTANT thread for disambiguation only; never invent rules from assistant text alone unless the user clearly adopted it in their own words.\n" +
  "Classify each extracted rule into exactly one bucket:\n" +
  "- **core_rules**: universal behavior, tone, honesty, length, language.\n" +
  "- **private_rules**: personal preferences and boundaries (addressing, disclosure, style).\n" +
  "- **forbidden_actions**: explicit prohibitions (must **never** do).\n" +
  "- **workflow_rules**: ordered steps, checklists, or process to follow when answering.\n" +
  "Only extract what the **user** stated or clearly implied; do **not** invent policies.\n" +
  "If the **last** Section A block clearly states new conduct, you should normally output at least one new string (unless it is purely non-normative as above).\n" +
  "If the user wrote a **numbered list, bullet list, or line-by-line** rules (each line a separate rule), you **must** emit **at least one string per substantive line** (map lines to the best bucket); do **not** return all-empty out of caution.\n" +
  "EXISTING_STORE_SUMMARY_JSON lists snippets already stored per bucket — avoid duplicates (same meaning).\n" +
  "Output **one** JSON object only, no markdown fences:\n" +
  '{ "core_rules": string[], "private_rules": string[], "forbidden_actions": string[], "workflow_rules": string[] }\n' +
  "Each string is one atomic rule (one sentence or short phrase). At most **36** new strings **total** across all four arrays for this response.";

/**
 * @param {unknown} raw
 * @returns {{ core_rules: string[], private_rules: string[], forbidden_actions: string[], workflow_rules: string[] }}
 */
function normalizeRulesKeeper3Patch(raw) {
  const empty = { core_rules: [], private_rules: [], forbidden_actions: [], workflow_rules: [] };
  if (!raw || typeof raw !== "object") return empty;
  /** @param {unknown} v */
  const asList = (v) => {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const x of v) {
      const s = typeof x === "string" ? x.trim() : String(/** @type {any} */ (x)?.text ?? "").trim();
      if (s.length >= 2) out.push(s.slice(0, RULES_KEEPER3_ITEM_MAX));
    }
    return out.slice(0, 32);
  };
  const j = /** @type {Record<string, unknown>} */ (raw);
  const patch = {
    core_rules: asList(j.core_rules),
    private_rules: asList(j.private_rules),
    forbidden_actions: asList(j.forbidden_actions),
    workflow_rules: asList(j.workflow_rules),
  };
  let budget = 36;
  /** @param {string[]} arr */
  const capArr = (arr) => {
    const out = [];
    for (const s of arr) {
      if (budget <= 0) break;
      out.push(s);
      budget -= 1;
    }
    return out;
  };
  return {
    core_rules: capArr(patch.core_rules),
    private_rules: capArr(patch.private_rules),
    forbidden_actions: capArr(patch.forbidden_actions),
    workflow_rules: capArr(patch.workflow_rules),
  };
}

/**
 * @param {string} text
 */
function parseRulesKeeper3JsonFromModelText(text) {
  try {
    let s = String(text ?? "").trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const j = JSON.parse(s);
    return normalizeRulesKeeper3Patch(j);
  } catch (e) {
    console.warn(
      "[Rules extract] JSON parse failed:",
      e instanceof Error ? e.message : String(e),
      String(text ?? "").slice(0, 240),
    );
    return { core_rules: [], private_rules: [], forbidden_actions: [], workflow_rules: [] };
  }
}

/**
 * Rules thread: classify user-stated rules into four buckets (merged on disk by the API).
 * @param {string} providerId
 * @param {string} apiKey
 * @param {string} transcript
 * @param {string} existingSummaryJson
 */
/**
 * When the LLM extractor returns nothing: split the **latest** user message into candidate rules
 * (bullets, numbering, one rule per line). Puts probable prohibitions into `forbidden_actions`.
 * @param {string} text — usually the last user message in Rules
 * @returns {{ core_rules: string[], private_rules: string[], forbidden_actions: string[], workflow_rules: string[] }}
 */
export function extractRulesListStubsFromUserText(text) {
  const raw = String(text ?? "").trim();
  const empty = { core_rules: [], private_rules: [], forbidden_actions: [], workflow_rules: [] };
  if (raw.length < 6) return empty;

  /** No bare `don't` — it matches style tips ("don't waffle") that belong in core, not prohibitions. */
  const forbiddenRe =
    /\b(never|must not|mustn't|do not|cannot|can't|forbidden|prohibit|no\s+\w+\s+allowed)\b/i;
  /** @type {string[]} */
  const core = [];
  /** @type {string[]} */
  const forbidden = [];
  const seen = new Set();

  const pushUnique = (arr, line) => {
    const t = line.replace(/\s+/g, " ").trim().slice(0, RULES_KEEPER3_ITEM_MAX);
    if (t.length < 4) return;
    const k = t.toLowerCase().slice(0, 400);
    if (seen.has(k)) return;
    seen.add(k);
    arr.push(t);
  };

  const stripLead = (s) =>
    String(s ?? "")
      .replace(
        /^[\s\u2022\u2023\u25CF\u25E6\u25AA\u2043\u2014\u2013\-*]+(?:\d{1,3}[.):）]\s*)?/u,
        "",
      )
      .trim();

  for (const line0 of raw.split(/\r?\n/)) {
    let line = stripLead(line0);
    if (line.length < 6) continue;
    if (TRIVIAL_ACK_LINE_RE.test(line)) continue;
    if (forbiddenRe.test(line)) pushUnique(forbidden, line);
    else pushUnique(core, line);
    if (core.length + forbidden.length >= 36) break;
  }

  if (core.length === 0 && forbidden.length === 0 && raw.length >= 12 && !raw.includes("\n")) {
    const parts = raw.split(/[;；]\s*/).map((p) => stripLead(p)).filter((p) => p.length >= 8);
    for (const p of parts.slice(0, 20)) {
      if (forbiddenRe.test(p)) pushUnique(forbidden, p);
      else pushUnique(core, p);
      if (core.length + forbidden.length >= 36) break;
    }
  }

  /** One short paragraph / single sentence (no bullets, no semicolons): still project conduct. */
  if (core.length === 0 && forbidden.length === 0) {
    const one = raw.replace(/\s+/g, " ").trim();
    if (one.length >= 8 && !TRIVIAL_ACK_LINE_RE.test(one)) {
      if (forbiddenRe.test(one)) pushUnique(forbidden, one);
      else pushUnique(core, one);
    }
  }

  return {
    core_rules: core,
    private_rules: [],
    forbidden_actions: forbidden,
    workflow_rules: [],
  };
}

export async function extractRulesKeeper3FromTranscript(
  providerId,
  apiKey,
  transcript,
  existingSummaryJson,
) {
  const key = String(apiKey ?? "").trim();
  const t = String(transcript ?? "").trim().slice(0, 72000);
  if (!key || !t) {
    return { core_rules: [], private_rules: [], forbidden_actions: [], workflow_rules: [] };
  }
  const ex = String(existingSummaryJson ?? "").trim().slice(0, 12000);
  const userBlock =
    `EXISTING_STORE_SUMMARY_JSON:\n${ex || "{}"}\n\n` + `EXTRACTOR_INPUT:\n${t}`;

  try {
    if (providerId === "openai") {
      const res = await fetch("/llm/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: openAiDialogue(),
          temperature: 0.1,
          ...oaMaxCompletionTokens(8000),
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: RULES_KEEPER3_EXTRACT_SYSTEM },
            { role: "user", content: userBlock },
          ],
        }),
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      const rawText = openAiChatCompletionMessageContentToString(content);
      if (!rawText.trim()) throw new Error("Empty API response");
      return parseRulesKeeper3JsonFromModelText(rawText);
    }

    const { text } = await completeChatMessage(providerId, userBlock, key, {
      systemInstruction: `${RULES_KEEPER3_EXTRACT_SYSTEM}\nRespond with a single JSON object only, no markdown fences.`,
    });
    return parseRulesKeeper3JsonFromModelText(text);
  } catch (e) {
    console.warn("[Rules extract] request failed:", e instanceof Error ? e.message : String(e));
    return { core_rules: [], private_rules: [], forbidden_actions: [], workflow_rules: [] };
  }
}

export async function extractChatInterestSketchForIngest(providerId, apiKey, userText) {
  const key = String(apiKey ?? "").trim();
  const u = String(userText ?? "").trim().slice(0, 8000);
  if (!key || !u) {
    return { entities: [], links: [], commands: [] };
  }
  const userBlock = `USER:\n${u}`;

  if (providerId === "openai") {
    const res = await fetch("/llm/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: openAiDialogue(),
        temperature: 0.12,
        ...oaMaxCompletionTokens(900),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: CHAT_INTEREST_SKETCH_EXTRACT_SYSTEM },
          { role: "user", content: userBlock },
        ],
      }),
    });
    if (!res.ok) throw new Error(await readErrorBody(res));
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    const rawText = openAiChatCompletionMessageContentToString(content);
    if (!rawText.trim()) throw new Error("Empty API response");
    reportAuxLlmUsage(providerId, "interests_sketch", usageFromOpenAiStyleUsage(data.usage));
    return clampGraphPayloadToInterestsOnly(parseIntroGraphJsonFromModelText(rawText));
  }

  const { text, usage } = await completeChatMessage(providerId, userBlock, key, {
    systemInstruction: `${CHAT_INTEREST_SKETCH_EXTRACT_SYSTEM}\nRespond with a single JSON object only, no markdown fences.`,
  });
  reportAuxLlmUsage(providerId, "interests_sketch", usage);
  return clampGraphPayloadToInterestsOnly(parseIntroGraphJsonFromModelText(text));
}

/**
 * @param {unknown} raw
 * @returns {{ entities: Array<{ category: string, label: string, notes: string }>, links: Array<{ from: { label: string, category: string }, to: { label: string, category: string }, relation: string }> }}
 */
function normalizeIntroGraphExtractPayload(raw) {
  /** @type {{ entities: Array<{ category: string, label: string, notes: string }>, links: Array<{ from: { label: string, category: string }, to: { label: string, category: string }, relation: string }> }} */
  const out = { entities: [], links: [] };
  if (!raw || typeof raw !== "object") return out;
  if (Array.isArray(raw.entities)) {
    for (const e of raw.entities) {
      if (!e || typeof e !== "object") continue;
      let category = String(e.category ?? "").trim();
      if (!INTRO_GRAPH_ALLOWED.has(category)) category = "Other";
      const label = String(e.label ?? "").trim().slice(0, 200);
      const notes = String(e.notes ?? "").trim().slice(0, 4000);
      if (!label) continue;
      out.entities.push({ category, label, notes });
    }
  }
  if (Array.isArray(raw.links)) {
    for (const ln of raw.links) {
      if (!ln || typeof ln !== "object") continue;
      const from = ln.from;
      const to = ln.to;
      if (!from || !to || typeof from !== "object" || typeof to !== "object") continue;
      let fc = String(from.category ?? "").trim();
      if (!INTRO_GRAPH_ALLOWED.has(fc)) fc = "Other";
      const fl = String(from.label ?? "").trim().slice(0, 200);
      let tc = String(to.category ?? "").trim();
      if (!INTRO_GRAPH_ALLOWED.has(tc)) tc = "Other";
      const tl = String(to.label ?? "").trim().slice(0, 200);
      if (!fl || !tl) continue;
      const relation = String(ln.relation ?? "").trim().slice(0, 200) || "related";
      out.links.push({
        from: { label: fl, category: fc },
        to: { label: tl, category: tc },
        relation,
      });
    }
  }
  return out;
}

/**
 * @param {string} text
 */
function parseIntroGraphJsonFromModelText(text) {
  let s = String(text ?? "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const j = JSON.parse(s);
  const base = normalizeIntroGraphExtractPayload(j);
  const commands = normalizeGraphCommands(j.commands);
  return { ...base, commands };
}

/**
 * Same as {@link parseIntroGraphJsonFromModelText} but never throws (truncated/invalid JSON from model).
 * @param {string} text
 * @param {string} [logTag]
 */
function parseIntroGraphJsonFromModelTextSafe(text, logTag = "Intro graph") {
  try {
    return parseIntroGraphJsonFromModelText(text);
  } catch (e) {
    console.warn(
      `[${logTag}] JSON parse failed:`,
      e instanceof Error ? e.message : String(e),
      String(text ?? "").slice(0, 400),
    );
    return { entities: [], links: [], commands: [] };
  }
}

const INTRO_GRAPH_NORMALIZE_SYSTEM =
  "You are the **Keeper** — the only stage that reconciles the memory tree with the database before writes. The **user is authoritative** (any language): when introMode is true, their explicit instructions for the graph override your habits and **must** be reflected in your output.\n" +
  "**Never** base decisions on assistant or model text. When introMode is true, `proposed` was produced from **user-only** extraction; `userTurn` is the same user text — treat it as the sole source of user intent. Do not reinterpret the graph using imagined assistant replies.\n" +
  "You normalize proposed memory-graph data against nodes already stored in the database.\n" +
  "**Duplicate annihilation (mandatory):** Compare existingNodes and proposed together. If several nodes are the **same real-world entity** — identical labels after trim, trivial spelling/script variants (e.g. Morocco / Maroc), or the same country/city/person/topic duplicated under parallel rows — **collapse to one** survivor: prefer an existingNodes label+category when it matches; pick the single best category (e.g. one country → Countries, not parallel Cities+Countries clones). Rewire every link to that survivor. **Never** leave parallel clones that would make the database grow without semantic gain.\n" +
  "The user message is one JSON object with these keys:\n" +
  '- "existingNodes": array of { "id": string, "category": string, "label": string } (may be empty).\n' +
  '- "proposed": { "entities": ..., "links": ..., optional "commands": [...] } — `commands` may already list structural ops from extraction; you may extend or replace them.\n' +
  '- "introMode": boolean. When true, "userTurn" is the latest **human user** message (**any** language or script). When false, ignore "userTurn" if present.\n' +
  "\n" +
  'Output ONE JSON object: { "entities": [...], "links": [...], "commands": [...] }.\n' +
  'Optional "commands" (array, max 50): **structural** edits the server applies **literally** after your JSON is received. Use them whenever userTurn (or proposed) implies merge, delete node, rename node, delete edge, or move edge — do not rely on notes alone for these.\n' +
  '  • mergeNodes: { "op": "mergeNodes", "from": { "category", "label" }, "into": { "category", "label" } } — first node merged into second (blob merged, edges repointed, first removed).\n' +
  '  • deleteNode: { "op": "deleteNode", "category", "label" } — node and incident edges removed (cannot delete People/User or Interests/Interests hub).\n' +
  '  • renameNode: { "op": "renameNode", "category", "fromLabel", "toLabel" }.\n' +
  '  • deleteEdge: { "op": "deleteEdge", "from": { "category", "label" }, "to": { "category", "label" }, "relation" optional }.\n' +
  '  • moveEdge: { "op": "moveEdge", "relation": string, "oldFrom", "oldTo", "newFrom", "newTo" } — each endpoint { "category", "label" }; old edge removed, new edge inserted.\n' +
  "You may return **commands only** with empty entities/links when the user message is purely a structural instruction.\n" +
  "\n" +
  "**Intro (introMode true):** (A) If userTurn clearly asks to **maintain or correct** the memory graph (add, merge, unify duplicates, relink, fix identity, move facts onto People/\"User\", retract redundancy), you **must** output entities/links and/or **commands** that implement that request against existingNodes — this is non-negotiable for the Keeper. Use proposed as material distilled from that same user text when non-empty; **an empty proposed graph does not excuse skipping** edits that userTurn still demands.\n" +
  "(B) **Profile facts:** When userTurn states **substantive facts** about the person (name, place, work, family, dates, preferences, biography — any language) and is **not** only acknowledgements (thanks/ok/emoji), you **must** output a minimal faithful graph from userTurn **even if proposed.entities and proposed.links are both empty**. Merge new facts into the existing People/\"User\" node when present (append to notes); otherwise emit the correct nodes/links. **Never** return {\"entities\":[],\"links\":[],\"commands\":[]} for such a userTurn solely because the extractor returned an empty proposed pack.\n" +
  "If userTurn is only brief acknowledgement with no new factual content, you may return empty when proposed is also empty.\n" +
  "**Not Intro (introMode false):** Use only proposed + existingNodes. `proposed` was built from **user-only** text (interest sketch); do not enrich it from assistant or model sources.\n" +
  "\n" +
  "Rules (general, any language or domain — do not invent facts):\n" +
  "1) Vs database: if a proposed entity is the same real-world referent as an existing node (translation, transliteration, punctuation, spacing, abbreviations, another script, redundant wording), merge into that node: copy its EXACT \"label\" and \"category\" from existingNodes. In \"notes\" keep only genuinely new facts; omit notes that only repeat the name.\n" +
  "2) Deduplicate among proposed entities the same way.\n" +
  "3) Fix clearly wrong categories using general knowledge (allowed: People, Dates, Cities, Countries, Companies, Projects, Interests, Documents, Data, Other).\n" +
  "4) Links must use final label+category for both ends after 1–3. Drop links to removed duplicates.\n" +
  "5) For Intro/self-profile: merge any proposed speaker identity into the existing anchor People / \"User\" when present; keep that exact label+category. The account holder is one person: merge People nodes that clearly denote the same human (any language, nicknames, transliterations) into one entity; prefer the existing People/\"User\" row from existingNodes when it is the same referent.\n" +
  "6) For Interests, prefer fewer broad umbrella nodes; merge near-duplicates (translations, spelling variants) and attach narrow topics under a broad parent when obvious. When the pack is a **light chat sketch** (broad umbrella + one thread headline), do not spawn extra synonyms for the same dialog theme or same umbrella domain.\n" +
  "7) If nothing remains, return {\"entities\":[],\"links\":[],\"commands\":[]}.\n" +
  "\n" +
  "Output JSON only.";

/**
 * Reconcile new nodes/edges with the stored graph (duplicates, categories) — Keeper step 2, one LLM call.
 * @param {string} providerId
 * @param {string} apiKey
 * @param {{ entities?: unknown[], links?: unknown[], commands?: unknown[] }} proposed
 * @param {Array<{ id?: string, category?: string, label?: string }>} existingNodes
 * @param {{ introMode?: boolean, userText?: string }} [turnContext] Intro: user text only (no model reply).
 */
export async function normalizeIntroMemoryGraphForDb(
  providerId,
  apiKey,
  proposed,
  existingNodes,
  turnContext = {},
) {
  const key = String(apiKey ?? "").trim();
  const rawProp = proposed && typeof proposed === "object" ? proposed : {};
  const base = normalizeIntroGraphExtractPayload(rawProp);
  const fromExtract = normalizeGraphCommands(rawProp.commands);
  const introMode = Boolean(turnContext.introMode);
  const uTurn = introMode ? String(turnContext.userText ?? "").trim().slice(0, 8000) : "";
  if (!key) return { ...base, commands: fromExtract };
  if (!introMode && base.entities.length === 0 && base.links.length === 0 && fromExtract.length === 0) {
    return { ...base, commands: [] };
  }
  if (introMode && base.entities.length === 0 && base.links.length === 0 && !uTurn && fromExtract.length === 0) {
    return { ...base, commands: [] };
  }

  const existing = Array.isArray(existingNodes)
    ? existingNodes
        .map((n) => ({
          id: String(n?.id ?? ""),
          category: String(n?.category ?? "").trim(),
          label: String(n?.label ?? "").trim().slice(0, 200),
        }))
        .filter((n) => n.id && n.category && n.label)
        .slice(0, 800)
    : [];

  /** @type {{ entities: typeof base.entities, links: typeof base.links, commands?: unknown[] }} */
  const proposedForLlm = { entities: base.entities, links: base.links };
  if (fromExtract.length > 0) proposedForLlm.commands = fromExtract;

  const userJson = introMode
    ? JSON.stringify({
        existingNodes: existing,
        proposed: proposedForLlm,
        introMode: true,
        userTurn: uTurn,
      })
    : JSON.stringify({ existingNodes: existing, proposed: proposedForLlm, introMode: false });

  if (providerId === "openai") {
    const res = await fetch("/llm/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
        body: JSON.stringify({
          model: openAiDialogue(),
          temperature: 0,
          ...oaMaxCompletionTokens(INTRO_GRAPH_NORMALIZE_OPENAI_MAX_TOKENS),
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: INTRO_GRAPH_NORMALIZE_SYSTEM },
            { role: "user", content: userJson },
          ],
        }),
    });
    if (!res.ok) throw new Error(await readErrorBody(res));
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    const rawText = openAiChatCompletionMessageContentToString(content);
    if (!rawText.trim()) throw new Error("Empty API response");
    reportAuxLlmUsage(providerId, "memory_graph_normalize", usageFromOpenAiStyleUsage(data.usage));
    const normalized = parseIntroGraphJsonFromModelTextSafe(rawText, "Intro normalize");
    const n =
      normalized.entities.length + normalized.links.length + (normalized.commands?.length ?? 0);
    if (n > 0) return normalized;
    return { ...base, commands: fromExtract };
  }

  const { text, usage } = await completeChatMessage(providerId, userJson, key, {
    systemInstruction: `${INTRO_GRAPH_NORMALIZE_SYSTEM}\nRespond with one JSON object only, no markdown fences.`,
  });
  reportAuxLlmUsage(providerId, "memory_graph_normalize", usage);
  const normalized = parseIntroGraphJsonFromModelTextSafe(text, "Intro normalize");
  const n =
    normalized.entities.length + normalized.links.length + (normalized.commands?.length ?? 0);
  if (n > 0) return normalized;
  return { ...base, commands: fromExtract };
}

/**
 * Extract graph structure from **only** the latest Intro user message (POST /api/memory-graph/ingest). Keeper step 1.
 * @param {string} providerId
 * @param {string} apiKey
 * @param {string} userText
 */
/** Last-resort Intro ingest when both extract and normalize return nothing (still saves facts onto People/User). */
export function introUserNotesFallbackPack(userText) {
  const raw = String(userText ?? "").trim();
  if (raw.length < 6) return { entities: [], links: [], commands: [] };
  if (TRIVIAL_ACK_LINE_RE.test(raw)) return { entities: [], links: [], commands: [] };
  return {
    entities: [{ category: "People", label: "User", notes: raw.slice(0, 4000) }],
    links: [],
    commands: [],
  };
}

export async function extractIntroMemoryGraphForIngest(providerId, apiKey, userText) {
  const key = String(apiKey ?? "").trim();
  const u = String(userText ?? "").trim().slice(0, 8000);
  if (!key || !u) {
    return { entities: [], links: [], commands: [] };
  }
  const userBlock = `USER:\n${u}`;

  if (providerId === "openai") {
    const res = await fetch("/llm/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
        body: JSON.stringify({
          model: openAiDialogue(),
          temperature: 0.1,
          ...oaMaxCompletionTokens(INTRO_GRAPH_EXTRACT_OPENAI_MAX_TOKENS),
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: INTRO_GRAPH_EXTRACT_SYSTEM },
            { role: "user", content: userBlock },
          ],
        }),
    });
    if (!res.ok) throw new Error(await readErrorBody(res));
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    const rawText = openAiChatCompletionMessageContentToString(content);
    if (!rawText.trim()) throw new Error("Empty API response");
    reportAuxLlmUsage(providerId, "intro_graph_extract", usageFromOpenAiStyleUsage(data.usage));
    return parseIntroGraphJsonFromModelTextSafe(rawText, "Intro extract");
  }

  const { text, usage } = await completeChatMessage(providerId, userBlock, key, {
    systemInstruction: `${INTRO_GRAPH_EXTRACT_SYSTEM}\nRespond with a single JSON object only, no markdown fences.`,
  });
  reportAuxLlmUsage(providerId, "intro_graph_extract", usage);
  return parseIntroGraphJsonFromModelTextSafe(text, "Intro extract");
}

/**
 * Streaming reply: `onDelta` is called for each text chunk as it arrives.
 * @param {{ webSearch?: boolean, deepResearch?: boolean, systemInstruction?: string, llmMessages?: Array<{ role: string, content: string }>, chatAttachments?: { images?: Array<{ mimeType: string, base64: string }> }, accessDataDumpMode?: boolean }} [options]
 * @returns {Promise<{ text: string, usage: LlmUsageTotals | null }>}
 */
export async function completeChatMessageStreaming(providerId, text, apiKey, onDelta, options = {}) {
  const key = String(apiKey ?? "").trim();
  if (!key) {
    throw new Error("No API key for the selected model (.env)");
  }
  const trimmed = text.trim();
  const hasLlm = Array.isArray(options.llmMessages) && options.llmMessages.length > 0;
  const hasAttImg = (options.chatAttachments?.images?.length ?? 0) > 0;
  if (!hasLlm && !trimmed && !hasAttImg) {
    throw new Error("Empty message");
  }
  const lockdown = Boolean(options.accessDataDumpMode);
  const webSearch = Boolean(options.webSearch) && !lockdown;
  const deepResearch = Boolean(options.deepResearch) && !lockdown;
  const useWebGrounding = webSearch || deepResearch;
  const oaMsgs = applyChatAttachmentsToOpenAiMessages(
    openAiCompatMessages(trimmed, options),
    options.chatAttachments,
  );

  let full;
  /** @type {LlmUsageTotals | null} */
  let usageOut = null;

  switch (providerId) {
    case "openai": {
      const res = await fetch("/llm/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: pickOpenAi(webSearch, deepResearch),
          messages: oaMsgs,
          stream: true,
          stream_options: {
            include_usage: true,
          },
        }),
      });
      const oaStream = await streamOpenAICompatJson(res, onDelta);
      full = mergePlainBracketRefsWithCitationList(oaStream.text, oaStream.citations);
      usageOut = oaStream.usage ?? null;
      break;
    }
    case "perplexity": {
      const pBody = {
        model: pickPerplexity(webSearch, deepResearch),
        messages: oaMsgs,
        stream: true,
      };
      if (useWebGrounding) {
        pBody.disable_search = false;
        pBody.web_search_options = {
          search_context_size: "high",
          search_type: "pro",
        };
      } else if (lockdown) {
        pBody.disable_search = true;
      }
      const res = await fetch("/llm/perplexity/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(pBody),
      });
      const pStream = await streamOpenAICompatJson(res, onDelta);
      full = mergePlainBracketRefsWithCitationList(pStream.text, pStream.citations);
      usageOut = pStream.usage ?? null;
      break;
    }
    case "anthropic": {
      const aStreamBody = {
        model: pickAnthropic(webSearch, deepResearch),
        max_tokens: 4096,
        messages: applyChatAttachmentsToAnthropicMessages(
          anthropicApiMessages(trimmed, options),
          options.chatAttachments,
        ),
        stream: true,
      };
      if (options.systemInstruction) {
        aStreamBody.system = options.systemInstruction;
      }
      if (useWebGrounding) {
        aStreamBody.tools = [
          { type: "web_search_20250305", name: "web_search", max_uses: 5 },
        ];
      }
      const res = await fetch("/llm/anthropic/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          ...ANTHROPIC_BROWSER_ACCESS_HEADER,
        },
        body: JSON.stringify(aStreamBody),
      });
      const anthStream = await streamAnthropicMessages(res, onDelta);
      full = anthStream.text;
      usageOut = anthStream.usage ?? null;
      break;
    }
    case "gemini-flash": {
      const gMsgs =
        Array.isArray(options.llmMessages) && options.llmMessages.length > 0
          ? options.llmMessages
          : [{ role: "user", content: trimmed }];
      const combined = geminiFlattenChat(String(options.systemInstruction ?? ""), gMsgs);
      const imgs = Array.isArray(options.chatAttachments?.images) ? options.chatAttachments.images : [];
      /** @type {Array<{ text?: string, inlineData?: { mimeType: string, data: string } }>} */
      const gParts = [{ text: combined }];
      for (const im of imgs) {
        gParts.push({
          inlineData: {
            mimeType: im.mimeType || "image/png",
            data: im.base64,
          },
        });
      }
      // Without alt=sse, Google returns non-classic SSE (see ai.google.dev streamGenerateContent) — parser does not get data: chunks incrementally.
      const gModel = pickGemini(webSearch, deepResearch);
      const url = `/llm/gemini/v1beta/models/${gModel}:streamGenerateContent?key=${encodeURIComponent(key)}&alt=sse`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(
          geminiRequestBodyFromParts(gParts, {
            googleSearch: useWebGrounding,
            modelId: gModel,
          }),
        ),
      });
      const gStream = await streamGeminiGenerateContent(res, onDelta);
      full = mergePlainBracketRefsWithCitationList(gStream.text, gStream.citations, {
        citationLabels: gStream.citationLabels,
      });
      usageOut = gStream.usage ?? null;
      break;
    }
    default:
      throw new Error("Unknown provider");
  }

  if (!String(full).trim()) {
    throw new Error("Empty API response");
  }
  return { text: full, usage: usageOut };
}

/**
 * Model label in the bubble footer (including search / deep research modes).
 * @param {{ webSearch?: boolean, deepResearch?: boolean }} [extras]
 */
export function apiModelHint(providerId, extras = {}) {
  const ws = Boolean(extras.webSearch);
  const dr = Boolean(extras.deepResearch);
  const suffixDr = dr ? " · deep research" : "";
  switch (providerId) {
    case "openai":
      if (dr) return `${openAiResearch()}${suffixDr}`;
      return ws ? openAiSearch() : openAiDialogue();
    case "anthropic":
      if (dr) return `${anthropicResearch()} · deep research`;
      return ws ? `${anthropicSearch()} · web search` : anthropicDialogue();
    case "gemini-flash":
      if (dr) return `${geminiResearch()} · deep research`;
      return ws ? `${geminiSearch()} · Google search` : geminiDialogue();
    case "perplexity":
      if (dr) return `${perplexityResearch()}${suffixDr}`;
      return ws ? perplexitySearch() : perplexityDialogue();
    default:
      return "";
  }
}

/** Model label in the bubble footer for image generation. */
export function apiImageGenerationModelHint(providerId) {
  switch (providerId) {
    case "openai":
      return openAiImage();
    case "gemini-flash":
      return geminiImage();
    default:
      return "";
  }
}

/**
 * Frame size for Images API (gpt-image): explicit aspect hints from the prompt or auto.
 * @param {string} prompt
 */
function openAiImageSizeFromPrompt(prompt) {
  const s = String(prompt ?? "").toLowerCase();
  if (
    /\b(9\s*:\s*16|9:16|portrait|vertical\s+format|tall\s+image|phone\s+screen|story\s+format)\b/.test(
      s,
    )
  ) {
    return "1024x1536";
  }
  if (/\b(16\s*:\s*9|16:9|landscape|wide\s+shot|horizontal|banner|cinematic\s+wide)\b/.test(s)) {
    return "1536x1024";
  }
  if (/\b(1\s*:\s*1|1:1|square)\b/.test(s)) {
    return "1024x1024";
  }
  return "auto";
}

/**
 * Decode attachment base64 to a Blob for multipart upload.
 * Do not use `fetch(data:...;base64,...)` — large data URLs fail instantly in many browsers (TypeError / "Failed to fetch"),
 * while the same bytes in JSON (Gemini) or in FormData blobs work fine.
 * @param {string} mimeType
 * @param {string} base64
 * @returns {Blob}
 */
function base64ImageToBlob(mimeType, base64) {
  const mime = String(mimeType || "image/png").split(";")[0].trim() || "image/png";
  let b64 = String(base64 ?? "").replace(/\s/g, "");
  if (!b64) throw new Error("Empty reference image data");
  while (b64.length % 4) b64 += "=";
  let bin;
  try {
    bin = atob(b64);
  } catch {
    throw new Error("Invalid base64 in a reference image");
  }
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
  return new Blob([bytes], { type: mime });
}

function extensionForImageMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("jpeg") || m === "image/jpg") return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  return "png";
}

/**
 * Wrap `![]()` destination in `<>` when URL breaks markdown (e.g. `)` in query string).
 * @param {string} url
 */
function markdownImageLinkDestination(url) {
  const u = String(url ?? "").trim();
  if (!u) return u;
  if (/\s/.test(u) || /[()]/.test(u)) return `<${u}>`;
  return u;
}

/**
 * @param {unknown} data
 * @returns {string} markdown
 */
function openAiImageDataToMarkdown(data) {
  const item = data && typeof data === "object" && Array.isArray(data.data) ? data.data[0] : null;
  if (!item) throw new Error("Empty image API response");
  if (item.url) {
    return `![Generated image](${markdownImageLinkDestination(item.url)})`;
  }
  if (item.b64_json) {
    return `![Generated image](data:image/png;base64,${item.b64_json})`;
  }
  throw new Error("API response contained no image URL or image data");
}

/**
 * Official `POST /v1/images/edits`: multipart `image[]` for multiple reference files (API rejects repeated `image`).
 * @param {string} prompt
 * @param {string} key
 * @param {Array<{ mimeType: string, base64: string }>} images
 * @param {string} preferredSize
 */
async function openaiImageEditsWithReferences(prompt, key, images, preferredSize) {
  async function postEdits(size) {
    const fd = new FormData();
    fd.append("model", openAiImage());
    fd.append("prompt", prompt);
    fd.append("size", size);
    for (let i = 0; i < images.length; i++) {
      const im = images[i];
      const mime = im.mimeType || "image/png";
      const blob = base64ImageToBlob(mime, im.base64);
      const ext = extensionForImageMime(mime);
      fd.append("image[]", blob, `reference-${i}.${ext}`);
    }
    return fetch("/llm/openai/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
    });
  }

  let res = await postEdits(preferredSize);
  let errBody = "";
  if (!res.ok) {
    errBody = await readErrorBody(res);
    if (
      preferredSize === "auto" &&
      /size|invalid|unknown|not\s+support/i.test(String(errBody))
    ) {
      res = await postEdits("1024x1024");
      if (!res.ok) errBody = await readErrorBody(res);
    }
  }
  if (!res.ok) {
    throw new Error(humanizeOpenAiImageError(errBody, res.status));
  }
  const data = await res.json();
  return {
    text: openAiImageDataToMarkdown(data),
    usage: usageFromOpenAiImageResponse(data),
  };
}

/**
 * @param {string} prompt
 * @param {string} key
 * @param {{ images?: Array<{ mimeType: string, base64: string }> } | null | undefined} [chatAtt]
 */
async function openaiImageGeneration(prompt, key, chatAtt = null) {
  const imgs = Array.isArray(chatAtt?.images) ? chatAtt.images : [];
  const preferredSize = openAiImageSizeFromPrompt(prompt);

  if (imgs.length > 0) {
    return openaiImageEditsWithReferences(prompt, key, imgs, preferredSize);
  }

  const payload = {
    model: openAiImage(),
    prompt,
    n: 1,
    size: preferredSize,
  };
  let res = await fetch("/llm/openai/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
  });
  let errBody = "";
  if (!res.ok) {
    errBody = await readErrorBody(res);
    if (
      preferredSize === "auto" &&
      /size|invalid|unknown|not\s+support/i.test(String(errBody))
    ) {
      payload.size = "1024x1024";
      res = await fetch("/llm/openai/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) errBody = await readErrorBody(res);
    }
  }
  if (!res.ok) {
    throw new Error(humanizeOpenAiImageError(errBody, res.status));
  }
  const data = await res.json();
  return {
    text: openAiImageDataToMarkdown(data),
    usage: usageFromOpenAiImageResponse(data),
  };
}

/**
 * Largest inline image block in a response subtree (usually the final image; drop tiny metadata blobs by length).
 * @param {unknown} root
 * @param {number} [minDataLen]
 * @returns {{ mime: string, data: string } | null}
 */
function geminiLargestInlineImageInTree(root, minDataLen = 256) {
  /** @type {{ mime: string, data: string } | null} */
  let best = null;
  let bestLen = 0;
  function walk(node, depth) {
    if (!node || depth > 28 || typeof node !== "object") return;
    const id = /** @type {{ mimeType?: string, mime_type?: string, data?: string }} */ (
      node.inlineData ?? node.inline_data
    );
    if (id?.data && typeof id.data === "string") {
      const len = id.data.length;
      if (len >= minDataLen && len > bestLen) {
        bestLen = len;
        best = {
          mime: String(id.mimeType || id.mime_type || "image/png"),
          data: id.data,
        };
      }
    }
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    for (const k of Object.keys(node)) walk(/** @type {Record<string, unknown>} */ (node)[k], depth + 1);
  }
  walk(root, 0);
  return best;
}

/** Create-image via Gemini: prompt plus optional reference images (text parts, then inlineData). */
async function geminiImageGeneration(prompt, key, chatAtt = null) {
  const imgs = Array.isArray(chatAtt?.images) ? chatAtt.images : [];
  /** @type {Array<{ text?: string, inlineData?: { mimeType: string, data: string } }>} */
  const parts = [{ text: prompt }];
  for (const im of imgs) {
    parts.push({
      inlineData: {
        mimeType: im.mimeType || "image/png",
        data: im.base64,
      },
    });
  }

  const url = `/llm/gemini/v1beta/models/${geminiImage()}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      /* Without explicit modalities the API often returns text only; the image arrives in parts as inlineData. */
      generationConfig: {
        ...getGeminiGenerationConfigForModel(geminiImage()),
        responseModalities: ["TEXT", "IMAGE"],
      },
    }),
  });
  if (!res.ok) throw new Error(await readErrorBody(res));
  const data = await res.json();
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  if (candidates.length === 0) {
    const block = data.promptFeedback?.blockReason;
    throw new Error(block ? `Request blocked: ${block}` : "Empty API response");
  }

  const textBits = [];
  let imageMd = "";

  function collectFromParts(parts) {
    if (!Array.isArray(parts)) return;
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      const id = p.inlineData ?? p.inline_data;
      if (id?.data && typeof id.data === "string") {
        const mime = String(id.mimeType || id.mime_type || "image/png");
        const b64 = String(id.data);
        imageMd = `![Generated image](data:${mime};base64,${b64})`;
        continue;
      }
      if (p.thought === true) continue;
      if (p.text) textBits.push(String(p.text));
    }
  }

  for (const cand of candidates) {
    collectFromParts(cand?.content?.parts);
    if (imageMd) break;
  }

  if (!imageMd) {
    for (const cand of candidates) {
      const blob = geminiLargestInlineImageInTree(cand?.content, 128);
      if (blob) {
        imageMd = `![Generated image](data:${blob.mime};base64,${blob.data})`;
        break;
      }
    }
  }

  if (!imageMd) {
    const t = textBits.join("\n").trim();
    const fr = candidates.map((c) => c?.finishReason).filter(Boolean);
    const frHint = fr.length ? `finishReason: ${fr.join(", ")}` : "";
    const block = data.promptFeedback?.blockReason;
    const blockHint = block ? `promptFeedback: ${block}` : "";
    const detail = [frHint, blockHint].filter(Boolean).join("; ");
    const hint =
      t.length > 0
        ? `Model did not return image data (only text). ${detail ? `${detail}. ` : ""}First line: ${t.split("\n")[0].slice(0, 160)}${t.length > 160 ? "…" : ""}`
        : detail
          ? `Model did not return an image (${detail})`
          : "Model did not return an image";
    throw new Error(hint);
  }
  const prefix = textBits.filter(Boolean).join("\n\n").trim();
  const text = prefix ? `${prefix}\n\n${imageMd}` : imageMd;
  return { text, usage: usageFromGeminiResponse(data) };
}

/**
 * Image generation from a text prompt (Create image mode).
 * @param {{ chatAttachments?: { images?: Array<{ mimeType: string, base64: string }> } }} [options] — reference images: Gemini (parts), ChatGPT (`/images/edits` + multipart).
 * @returns {Promise<{ text: string, usage: LlmUsageTotals | null }>} markdown with an image (![]())
 */
/**
 * @param {unknown} err
 * @param {string} label
 * @returns {never}
 */
function throwIfImageFetchNetworkFailed(err, label) {
  const m = err instanceof Error ? err.message : String(err);
  const low = m.toLowerCase();
  /** Do not treat every `TypeError` as fetch — e.g. bad data URL / atob throws differently and must surface. */
  const looksLikeFetchTransport =
    low.includes("failed to fetch") ||
    low.includes("load failed") ||
    low.includes("networkerror") ||
    low.includes("network request failed");
  if (looksLikeFetchTransport) {
    throw new Error(
      `${label}: network error (no HTTP response). Ensure the dev server is running (Vite proxies /llm to OpenAI).`,
    );
  }
  throw err;
}

export async function completeImageGeneration(providerId, prompt, apiKey, options = {}) {
  const key = String(apiKey ?? "").trim();
  if (!key) {
    throw new Error("No API key for the selected model (.env)");
  }
  const trimmed = String(prompt ?? "").trim();
  if (!trimmed) {
    throw new Error("Empty message");
  }

  switch (providerId) {
    case "openai": {
      try {
        return await openaiImageGeneration(trimmed, key, options.chatAttachments ?? null);
      } catch (e) {
        throwIfImageFetchNetworkFailed(e, "ChatGPT image");
      }
    }
    case "gemini-flash": {
      try {
        return await geminiImageGeneration(trimmed, key, options.chatAttachments ?? null);
      } catch (e) {
        throwIfImageFetchNetworkFailed(e, "Gemini image");
      }
    }
    case "anthropic":
    case "perplexity":
      throw new Error(
        "This model does not generate images. Choose ChatGPT or Gemini (key in .env).",
      );
    default:
      throw new Error("Unknown provider");
  }
}
