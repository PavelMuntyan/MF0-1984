/**
 * Provider calls via dev/preview proxy `/llm/*` (avoids browser CORS).
 */

import {
  streamAnthropicMessages,
  streamGeminiGenerateContent,
  streamOpenAICompatJson,
} from "./streaming.js";
import { titleFromUserMessage } from "./chatPersistence.js";
import {
  collectGeminiGroundingEntries,
  collectOpenAiLikeAnnotationUrls,
  mergePlainBracketRefsWithCitationList,
  pickPerplexityCitationPayload,
} from "./footnoteCitations.js";

export const PROVIDER_DISPLAY = {
  openai: "ChatGPT",
  perplexity: "Perplexity",
  "gemini-flash": "Gemini",
  anthropic: "Claude",
};

const OPENAI_MODEL = "gpt-4o-mini";
/** Chat Completions: built-in web search (see platform.openai.com docs/tools-web-search). */
const OPENAI_MODEL_WEB = "gpt-4o-mini-search-preview";
/** GPT Image API: DALL·E 2/3 deprecated; current endpoints are gpt-image-*. */
const OPENAI_IMAGE_MODEL = "gpt-image-1.5";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const GEMINI_MODEL_FLASH = "gemini-2.5-flash";
/** Native image generation model (Gemini API). */
const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";
const PERPLEXITY_MODEL = "sonar";
/** Sonar Pro: stronger web grounding; used for Web search mode. */
const PERPLEXITY_MODEL_SEARCH = "sonar-pro";

/**
 * Gemini 2.5 Flash: dynamic thinking is on by default — streamed visible text often
 * arrives in large chunks. thinkingBudget: 0 disables thinking
 * (ai.google.dev/gemini-api/docs/thinking).
 */
const GEMINI_GENERATION_CONFIG = {
  thinkingConfig: {
    thinkingBudget: 0,
  },
};

/**
 * @param {string} text
 * @param {{ googleSearch?: boolean }} [opts]
 */
function geminiJsonBody(text, opts = {}) {
  return geminiRequestBodyFromParts([{ text }], opts);
}

/**
 * @param {Array<{ text?: string, inlineData?: { mimeType: string, data: string } }>} parts
 * @param {{ googleSearch?: boolean }} [opts]
 */
function geminiRequestBodyFromParts(parts, opts = {}) {
  const body = {
    contents: [{ parts }],
    generationConfig: GEMINI_GENERATION_CONFIG,
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
    body: JSON.stringify(geminiRequestBodyFromParts(parts, { googleSearch })),
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
      "A common cause is a legacy DALL·E setup; this app uses GPT Image. " +
      "Check your OpenAI dashboard for GPT Image access and organization verification if needed. " +
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
      `Model ${OPENAI_IMAGE_MODEL} is not available for this key or region. ` +
      `API response: ${s.length > 220 ? `${s.slice(0, 220)}…` : s}`
    );
  }
  if (low.includes("must be verified") || low.includes("organization must be verified")) {
    return (
      "GPT Image may require organization verification in the OpenAI developer dashboard. " +
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
 * @param {{ webSearch?: boolean, deepResearch?: boolean, systemInstruction?: string, llmMessages?: Array<{ role: string, content: string }>, chatAttachments?: { images?: Array<{ mimeType: string, base64: string }> } }} [options] — webSearch/deepResearch: search-capable models where supported; llmMessages: assembled thread context; chatAttachments: images for the last user turn (file text is already in `text`)
 * @returns {Promise<{ text: string }>}
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
  const webSearch = Boolean(options.webSearch);
  const deepResearch = Boolean(options.deepResearch);
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
          model: useWebGrounding ? OPENAI_MODEL_WEB : OPENAI_MODEL,
          messages: oaMsgs,
        }),
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content == null) throw new Error("Empty API response");
      const rawText = typeof content === "string" ? content : String(content);
      const annUrls = collectOpenAiLikeAnnotationUrls(data.choices?.[0]?.message);
      return { text: mergePlainBracketRefsWithCitationList(rawText, annUrls) };
    }
    case "anthropic": {
      const anthropicBody = {
        model: ANTHROPIC_MODEL,
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
      return { text: out };
    }
    case "gemini-flash": {
      const gMsgs =
        Array.isArray(options.llmMessages) && options.llmMessages.length > 0
          ? options.llmMessages
          : [{ role: "user", content: trimmed }];
      const combined = geminiFlattenChat(String(options.systemInstruction ?? ""), gMsgs);
      return geminiGenerateContent(
        GEMINI_MODEL_FLASH,
        combined,
        key,
        useWebGrounding,
        options.chatAttachments,
      );
    }
    case "perplexity": {
      const perplexityBody = {
        model: useWebGrounding ? PERPLEXITY_MODEL_SEARCH : PERPLEXITY_MODEL,
        messages: oaMsgs,
      };
      if (useWebGrounding) {
        perplexityBody.disable_search = false;
        perplexityBody.web_search_options = {
          search_context_size: "high",
          search_type: "pro",
        };
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
      if (content == null) throw new Error("Empty API response");
      const rawText = typeof content === "string" ? content : String(content);
      const citeRaw = pickPerplexityCitationPayload(data);
      const withCites = mergePlainBracketRefsWithCitationList(rawText, citeRaw);
      return { text: withCites };
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
            model: OPENAI_MODEL,
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
        if (content == null) throw new Error("Empty API response");
        text = typeof content === "string" ? content : String(content);
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
            model: ANTHROPIC_MODEL,
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
        const { text: g } = await geminiGenerateContent(GEMINI_MODEL_FLASH, combined, key, false);
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
            model: PERPLEXITY_MODEL,
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
        if (content == null) throw new Error("Empty API response");
        text = typeof content === "string" ? content : String(content);
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
        model: OPENAI_MODEL,
        temperature: 0.12,
        max_tokens: 900,
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
    if (content == null) throw new Error("Empty API response");
    const rawText = typeof content === "string" ? content : String(content);
    return clampGraphPayloadToInterestsOnly(parseIntroGraphJsonFromModelText(rawText));
  }

  const { text } = await completeChatMessage(providerId, userBlock, key, {
    systemInstruction: `${CHAT_INTEREST_SKETCH_EXTRACT_SYSTEM}\nRespond with a single JSON object only, no markdown fences.`,
  });
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
  "**Intro (introMode true):** If userTurn clearly asks to **maintain or correct** the memory graph (add, merge, unify duplicates, relink, fix identity, move facts onto People/\"User\", retract redundancy), you **must** output entities/links and/or **commands** that implement that request against existingNodes — this is non-negotiable for the Keeper. Use proposed as material distilled from that same user text when non-empty; **an empty proposed graph does not excuse skipping** edits that userTurn still demands. If userTurn has no graph-maintenance intent, return empty unless rules below still require output from proposed.\n" +
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
        model: OPENAI_MODEL,
        temperature: 0,
        max_tokens: 4096,
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
    if (content == null) throw new Error("Empty API response");
    const rawText = typeof content === "string" ? content : String(content);
    return parseIntroGraphJsonFromModelText(rawText);
  }

  const { text } = await completeChatMessage(providerId, userJson, key, {
    systemInstruction: `${INTRO_GRAPH_NORMALIZE_SYSTEM}\nRespond with one JSON object only, no markdown fences.`,
  });
  return parseIntroGraphJsonFromModelText(text);
}

/**
 * Extract graph structure from **only** the latest Intro user message (POST /api/memory-graph/ingest). Keeper step 1.
 * @param {string} providerId
 * @param {string} apiKey
 * @param {string} userText
 */
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
        model: OPENAI_MODEL,
        temperature: 0.1,
        max_tokens: 2048,
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
    if (content == null) throw new Error("Empty API response");
    const rawText = typeof content === "string" ? content : String(content);
    return parseIntroGraphJsonFromModelText(rawText);
  }

  const { text } = await completeChatMessage(providerId, userBlock, key, {
    systemInstruction: `${INTRO_GRAPH_EXTRACT_SYSTEM}\nRespond with a single JSON object only, no markdown fences.`,
  });
  return parseIntroGraphJsonFromModelText(text);
}

/**
 * Streaming reply: `onDelta` is called for each text chunk as it arrives.
 * @param {{ webSearch?: boolean, deepResearch?: boolean, systemInstruction?: string, llmMessages?: Array<{ role: string, content: string }>, chatAttachments?: { images?: Array<{ mimeType: string, base64: string }> } }} [options]
 * @returns {Promise<string>} full accumulated text
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
  const webSearch = Boolean(options.webSearch);
  const deepResearch = Boolean(options.deepResearch);
  const useWebGrounding = webSearch || deepResearch;
  const oaMsgs = applyChatAttachmentsToOpenAiMessages(
    openAiCompatMessages(trimmed, options),
    options.chatAttachments,
  );

  let full;

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
          model: useWebGrounding ? OPENAI_MODEL_WEB : OPENAI_MODEL,
          messages: oaMsgs,
          stream: true,
        }),
      });
      const oaStream = await streamOpenAICompatJson(res, onDelta);
      full = mergePlainBracketRefsWithCitationList(oaStream.text, oaStream.citations);
      break;
    }
    case "perplexity": {
      const pBody = {
        model: useWebGrounding ? PERPLEXITY_MODEL_SEARCH : PERPLEXITY_MODEL,
        messages: oaMsgs,
        stream: true,
      };
      if (useWebGrounding) {
        pBody.disable_search = false;
        pBody.web_search_options = {
          search_context_size: "high",
          search_type: "pro",
        };
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
      break;
    }
    case "anthropic": {
      const aStreamBody = {
        model: ANTHROPIC_MODEL,
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
      full = await streamAnthropicMessages(res, onDelta);
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
      const url = `/llm/gemini/v1beta/models/${GEMINI_MODEL_FLASH}:streamGenerateContent?key=${encodeURIComponent(key)}&alt=sse`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(
          geminiRequestBodyFromParts(gParts, { googleSearch: useWebGrounding }),
        ),
      });
      const gStream = await streamGeminiGenerateContent(res, onDelta);
      full = mergePlainBracketRefsWithCitationList(gStream.text, gStream.citations, {
        citationLabels: gStream.citationLabels,
      });
      break;
    }
    default:
      throw new Error("Unknown provider");
  }

  if (!String(full).trim()) {
    throw new Error("Empty API response");
  }
  return full;
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
      if (dr) return `${OPENAI_MODEL_WEB}${suffixDr}`;
      return ws ? OPENAI_MODEL_WEB : OPENAI_MODEL;
    case "anthropic":
      if (dr) return `${ANTHROPIC_MODEL} · deep research`;
      return ws ? `${ANTHROPIC_MODEL} · web search` : ANTHROPIC_MODEL;
    case "gemini-flash":
      if (dr) return `${GEMINI_MODEL_FLASH} · deep research`;
      return ws ? `${GEMINI_MODEL_FLASH} · Google search` : GEMINI_MODEL_FLASH;
    case "perplexity":
      if (dr) return `${PERPLEXITY_MODEL_SEARCH}${suffixDr}`;
      return ws ? PERPLEXITY_MODEL_SEARCH : PERPLEXITY_MODEL;
    default:
      return "";
  }
}

/** Model label in the bubble footer for image generation. */
export function apiImageGenerationModelHint(providerId) {
  switch (providerId) {
    case "openai":
      return OPENAI_IMAGE_MODEL;
    case "gemini-flash":
      return GEMINI_IMAGE_MODEL;
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
 * @param {string} mimeType
 * @param {string} base64
 * @returns {Promise<Blob>}
 */
async function base64ImageToBlob(mimeType, base64) {
  const mime = String(mimeType || "image/png").split(";")[0].trim() || "image/png";
  const res = await fetch(`data:${mime};base64,${base64}`);
  if (!res.ok) throw new Error("Could not prepare reference image for upload");
  return res.blob();
}

function extensionForImageMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("jpeg") || m === "image/jpg") return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  return "png";
}

/**
 * @param {unknown} data
 * @returns {string} markdown
 */
function openAiImageDataToMarkdown(data) {
  const item = data && typeof data === "object" && Array.isArray(data.data) ? data.data[0] : null;
  if (!item) throw new Error("Empty image API response");
  if (item.url) {
    return `![Generated image](${item.url})`;
  }
  if (item.b64_json) {
    return `![Generated image](data:image/png;base64,${item.b64_json})`;
  }
  throw new Error("API response contained no image URL or image data");
}

/**
 * References: official `POST /v1/images/edits` + multipart (`image[]`, `prompt`, `model`, `size`).
 * @param {string} prompt
 * @param {string} key
 * @param {Array<{ mimeType: string, base64: string }>} images
 * @param {string} preferredSize
 */
async function openaiImageEditsWithReferences(prompt, key, images, preferredSize) {
  async function postEdits(size) {
    const fd = new FormData();
    fd.append("model", OPENAI_IMAGE_MODEL);
    fd.append("prompt", prompt);
    fd.append("size", size);
    for (let i = 0; i < images.length; i++) {
      const im = images[i];
      const mime = im.mimeType || "image/png";
      const blob = await base64ImageToBlob(mime, im.base64);
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
  return openAiImageDataToMarkdown(data);
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
    model: OPENAI_IMAGE_MODEL,
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
  return openAiImageDataToMarkdown(data);
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

  const url = `/llm/gemini/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      /* Without explicit modalities the API often returns text only; the image arrives in parts as inlineData. */
      generationConfig: {
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
  return prefix ? `${prefix}\n\n${imageMd}` : imageMd;
}

/**
 * Image generation from a text prompt (Create image mode).
 * @param {{ chatAttachments?: { images?: Array<{ mimeType: string, base64: string }> } }} [options] — reference images: Gemini (parts), ChatGPT (`/images/edits` + multipart).
 * @returns {Promise<{ text: string }>} markdown with an image (![]())
 */
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
      const text = await openaiImageGeneration(trimmed, key, options.chatAttachments ?? null);
      return { text };
    }
    case "gemini-flash": {
      const text = await geminiImageGeneration(trimmed, key, options.chatAttachments ?? null);
      return { text };
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
