/**
 * Provider calls via server-side LLM proxy `/api/llm/*`.
 */

import {
  callLlm,
  callLlmStream,
  geminiGenerationConfig,
  geminiFlattenMessages,
  openAiContentToString,
  readErrorBody,
  usageFromAnthropic,
  usageFromGemini,
  usageFromOpenAiStyle,
  usageWithFallback,
} from "./llmGateway.js";
import { titleFromUserMessage } from "./chatPersistence.js";
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

/** Backward-compat re-exports (callers such as memoryTreeRouter.js import these names). */
export { usageFromOpenAiStyle as usageFromOpenAiStyleUsage } from "./llmGateway.js";
export { usageFromAnthropic as usageFromAnthropicResponse } from "./llmGateway.js";
export { usageFromGemini as usageFromGeminiResponse } from "./llmGateway.js";

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

/** Returns the dialogue-tier model ID for a provider. */
export function dialogueModel(providerId) {
  switch (providerId) {
    case "openai": return openAiDialogue();
    case "anthropic": return anthropicDialogue();
    case "gemini-flash": return geminiDialogue();
    case "perplexity": return perplexityDialogue();
    default: return "";
  }
}

/** Returns the best model for the current chat mode (search / research / dialogue). */
function pickModel(providerId, webSearch, deepResearch) {
  switch (providerId) {
    case "openai": return pickOpenAi(webSearch, deepResearch);
    case "anthropic": return pickAnthropic(webSearch, deepResearch);
    case "gemini-flash": return pickGemini(webSearch, deepResearch);
    case "perplexity": return pickPerplexity(webSearch, deepResearch);
    default: throw new Error("Unknown provider");
  }
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
 * @param {{ webSearch?: boolean, deepResearch?: boolean, systemInstruction?: string, llmMessages?: Array<{ role: string, content: string }>, chatAttachments?: { images?: Array<{ mimeType: string, base64: string }> }, accessDataDumpMode?: boolean, abortSignal?: AbortSignal | null }} [options] — webSearch/deepResearch: search-capable models where supported; llmMessages: assembled thread context; chatAttachments: images for the last user turn (file text is already in `text`); accessDataDumpMode: #data lockdown
 * @returns {Promise<{ text: string, usage: LlmUsageTotals | null }>}
 */
export async function completeChatMessage(providerId, text, apiKey, options = {}) {
  const key = String(apiKey ?? "").trim();
  if (!key) throw new Error("No API key for the selected model (.env)");
  const trimmed = text.trim();
  const hasLlm = Array.isArray(options.llmMessages) && options.llmMessages.length > 0;
  const hasAttImg = (options.chatAttachments?.images?.length ?? 0) > 0;
  if (!hasLlm && !trimmed && !hasAttImg) throw new Error("Empty message");

  const lockdown = Boolean(options.accessDataDumpMode);
  const webSearch = Boolean(options.webSearch) && !lockdown;
  const deepResearch = Boolean(options.deepResearch) && !lockdown;
  const useWebGrounding = webSearch || deepResearch;
  const abortSignal = options.abortSignal || null;
  const system = options.systemInstruction || undefined;
  const rawMsgs = hasLlm ? options.llmMessages : [{ role: "user", content: trimmed }];
  const promptUsageBasis = [
    String(system ?? "").trim(),
    JSON.stringify(options.llmMessages ?? []),
    trimmed,
  ].filter(Boolean).join("\n");

  let messages, geminiParts;
  if (providerId === "gemini-flash") {
    const combined = geminiFlattenMessages(String(system ?? ""), rawMsgs);
    const imgs = Array.isArray(options.chatAttachments?.images) ? options.chatAttachments.images : [];
    geminiParts = /** @type {Array<{text?: string, inlineData?: {mimeType: string, data: string}}>} */ (
      [{ text: combined }, ...imgs.map((im) => ({ inlineData: { mimeType: im.mimeType || "image/png", data: im.base64 } }))]
    );
  } else if (providerId === "anthropic") {
    messages = applyChatAttachmentsToAnthropicMessages(rawMsgs, options.chatAttachments);
  } else {
    messages = applyChatAttachmentsToOpenAiMessages(rawMsgs, options.chatAttachments);
  }

  return callLlm({
    provider: providerId,
    key,
    model: pickModel(providerId, webSearch, deepResearch),
    messages: messages ?? rawMsgs,
    system: providerId === "gemini-flash" ? undefined : system,
    tools: (providerId === "anthropic" && useWebGrounding)
      ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]
      : undefined,
    googleSearch: (providerId === "gemini-flash" || providerId === "perplexity") ? useWebGrounding : false,
    disableSearch: providerId === "perplexity" && lockdown,
    geminiParts: providerId === "gemini-flash" ? geminiParts : undefined,
    withCitations: true,
    requestKind: null,
    abortSignal,
    promptBasis: promptUsageBasis,
  });
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
  if (!key || !snippet) return titleFromUserMessage(userMessage);
  const model = dialogueModel(providerId);
  if (!model) return titleFromUserMessage(userMessage);
  try {
    const { text } = await callLlm({
      provider: providerId,
      key,
      model,
      messages: [{ role: "user", content: snippet }],
      system: THEME_TITLE_SYSTEM,
      temperature: 0.2,
      maxTokens: 48,
      requestKind: "theme_dialog_title",
      promptBasis: snippet,
    });
    const normalized = normalizeThemeDialogTitle(text);
    return normalized === "New conversation" ? titleFromUserMessage(userMessage) : normalized;
  } catch {
    return titleFromUserMessage(userMessage);
  }
}


/**
 * Streaming reply: `onDelta` is called for each text chunk as it arrives.
 * @param {{ webSearch?: boolean, deepResearch?: boolean, systemInstruction?: string, llmMessages?: Array<{ role: string, content: string }>, chatAttachments?: { images?: Array<{ mimeType: string, base64: string }> }, accessDataDumpMode?: boolean, abortSignal?: AbortSignal | null }} [options]
 * @returns {Promise<{ text: string, usage: LlmUsageTotals | null }>}
 */
export async function completeChatMessageStreaming(providerId, text, apiKey, onDelta, options = {}) {
  const key = String(apiKey ?? "").trim();
  if (!key) throw new Error("No API key for the selected model (.env)");
  const trimmed = text.trim();
  const hasLlm = Array.isArray(options.llmMessages) && options.llmMessages.length > 0;
  const hasAttImg = (options.chatAttachments?.images?.length ?? 0) > 0;
  if (!hasLlm && !trimmed && !hasAttImg) throw new Error("Empty message");

  const lockdown = Boolean(options.accessDataDumpMode);
  const webSearch = Boolean(options.webSearch) && !lockdown;
  const deepResearch = Boolean(options.deepResearch) && !lockdown;
  const useWebGrounding = webSearch || deepResearch;
  const abortSignal = options.abortSignal || null;
  const system = options.systemInstruction || undefined;
  const rawMsgs = hasLlm ? options.llmMessages : [{ role: "user", content: trimmed }];
  const promptUsageBasis = [
    String(system ?? "").trim(),
    JSON.stringify(options.llmMessages ?? []),
    trimmed,
  ].filter(Boolean).join("\n");

  let messages, geminiParts;
  if (providerId === "gemini-flash") {
    const combined = geminiFlattenMessages(String(system ?? ""), rawMsgs);
    const imgs = Array.isArray(options.chatAttachments?.images) ? options.chatAttachments.images : [];
    geminiParts = /** @type {Array<{text?: string, inlineData?: {mimeType: string, data: string}}>} */ (
      [{ text: combined }, ...imgs.map((im) => ({ inlineData: { mimeType: im.mimeType || "image/png", data: im.base64 } }))]
    );
  } else if (providerId === "anthropic") {
    messages = applyChatAttachmentsToAnthropicMessages(rawMsgs, options.chatAttachments);
  } else {
    messages = applyChatAttachmentsToOpenAiMessages(rawMsgs, options.chatAttachments);
  }

  return callLlmStream({
    provider: providerId,
    key,
    model: pickModel(providerId, webSearch, deepResearch),
    messages: messages ?? rawMsgs,
    system: providerId === "gemini-flash" ? undefined : system,
    maxTokens: 4096,
    tools: (providerId === "anthropic" && useWebGrounding)
      ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]
      : undefined,
    googleSearch: (providerId === "gemini-flash" || providerId === "perplexity") ? useWebGrounding : false,
    disableSearch: providerId === "perplexity" && lockdown,
    geminiParts: providerId === "gemini-flash" ? geminiParts : undefined,
    onDelta,
    requestKind: null,
    abortSignal,
    promptBasis: promptUsageBasis,
  });
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
    return fetch("/api/llm/openai/v1/images/edits", {
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
  let res = await fetch("/api/llm/openai/v1/images/generations", {
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
      res = await fetch("/api/llm/openai/v1/images/generations", {
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

  const url = `/api/llm/gemini/v1beta/models/${geminiImage()}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      /* Without explicit modalities the API often returns text only; the image arrives in parts as inlineData. */
      generationConfig: {
        ...geminiGenerationConfig(geminiImage()),
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
  return { text, usage: usageFromGemini(data) };
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
      `${label}: network error (no HTTP response). Ensure the dev server is running and the API server is up.`,
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
