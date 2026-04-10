/**
 * Запросы к провайдерам через dev/preview-прокси `/llm/*` (обход CORS в браузере).
 */

import {
  streamAnthropicMessages,
  streamGeminiGenerateContent,
  streamOpenAICompatJson,
} from "./streaming.js";

export const PROVIDER_DISPLAY = {
  openai: "ChatGPT",
  perplexity: "Perplexity",
  "gemini-flash": "Gemini",
  anthropic: "Claude",
};

const OPENAI_MODEL = "gpt-4o-mini";
/** Chat Completions: встроенный веб-поиск (см. platform.openai.com docs/tools-web-search). */
const OPENAI_MODEL_WEB = "gpt-4o-mini-search-preview";
/** GPT Image API: DALL·E 2/3 объявлены устаревшими; актуальный endpoint — gpt-image-*. */
const OPENAI_IMAGE_MODEL = "gpt-image-1.5";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const GEMINI_MODEL_FLASH = "gemini-2.5-flash";
/** Модель нативной генерации изображений (Gemini API). */
const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";
const PERPLEXITY_MODEL = "sonar";
/** Sonar Pro — сильнее привязка к веб-поиску; для режима «Поиск в сети». */
const PERPLEXITY_MODEL_SEARCH = "sonar-pro";

/**
 * Gemini 2.5 Flash: по умолчанию dynamic thinking — видимый текст в стриме часто
 * идёт редкими крупными порциями. thinkingBudget: 0 отключает thinking
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
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: GEMINI_GENERATION_CONFIG,
  };
  if (opts.googleSearch) {
    body.tools = [{ google_search: {} }];
  }
  return body;
}

/** Требование Anthropic при вызове из браузера (в т.ч. через /llm/anthropic-прокси). */
const ANTHROPIC_BROWSER_ACCESS_HEADER = {
  "anthropic-dangerous-direct-browser-access": "true",
};

async function geminiGenerateContent(modelId, trimmed, key, googleSearch = false) {
  const url = `/llm/gemini/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(geminiJsonBody(trimmed, { googleSearch })),
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
  return { text: out };
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
 * @param {{ webSearch?: boolean }} [options] — true = реальный поиск через API провайдера
 * @returns {Promise<{ text: string }>}
 */
export async function completeChatMessage(providerId, text, apiKey, options = {}) {
  const key = String(apiKey ?? "").trim();
  if (!key) {
    throw new Error("No API key for the selected model (.env)");
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Empty message");
  }
  const webSearch = Boolean(options.webSearch);

  switch (providerId) {
    case "openai": {
      const res = await fetch("/llm/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: webSearch ? OPENAI_MODEL_WEB : OPENAI_MODEL,
          messages: [{ role: "user", content: trimmed }],
        }),
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content == null) throw new Error("Empty API response");
      return { text: typeof content === "string" ? content : String(content) };
    }
    case "anthropic": {
      const anthropicBody = {
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: trimmed }],
      };
      if (webSearch) {
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
    case "gemini-flash":
      return geminiGenerateContent(GEMINI_MODEL_FLASH, trimmed, key, webSearch);
    case "perplexity": {
      const perplexityBody = {
        model: webSearch ? PERPLEXITY_MODEL_SEARCH : PERPLEXITY_MODEL,
        messages: [{ role: "user", content: trimmed }],
      };
      if (webSearch) {
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
      return { text: typeof content === "string" ? content : String(content) };
    }
    default:
      throw new Error("Unknown provider");
  }
}

/**
 * Потоковый ответ: onDelta вызывается для каждой порции текста по мере прихода.
 * @param {{ webSearch?: boolean }} [options]
 * @returns {Promise<string>} полный накопленный текст
 */
export async function completeChatMessageStreaming(providerId, text, apiKey, onDelta, options = {}) {
  const key = String(apiKey ?? "").trim();
  if (!key) {
    throw new Error("No API key for the selected model (.env)");
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Empty message");
  }
  const webSearch = Boolean(options.webSearch);

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
          model: webSearch ? OPENAI_MODEL_WEB : OPENAI_MODEL,
          messages: [{ role: "user", content: trimmed }],
          stream: true,
        }),
      });
      full = await streamOpenAICompatJson(res, onDelta);
      break;
    }
    case "perplexity": {
      const pBody = {
        model: webSearch ? PERPLEXITY_MODEL_SEARCH : PERPLEXITY_MODEL,
        messages: [{ role: "user", content: trimmed }],
        stream: true,
      };
      if (webSearch) {
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
      full = await streamOpenAICompatJson(res, onDelta);
      break;
    }
    case "anthropic": {
      const aStreamBody = {
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: trimmed }],
        stream: true,
      };
      if (webSearch) {
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
      // Без alt=sse Google отдаёт не классический SSE (см. ai.google.dev streamGenerateContent) — парсер не получает data:-чанки по мере генерации.
      const url = `/llm/gemini/v1beta/models/${GEMINI_MODEL_FLASH}:streamGenerateContent?key=${encodeURIComponent(key)}&alt=sse`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(geminiJsonBody(trimmed, { googleSearch: webSearch })),
      });
      full = await streamGeminiGenerateContent(res, onDelta);
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
 * Подпись модели в подвале пузыря (в т.ч. режим реального поиска в сети).
 * @param {{ webSearch?: boolean }} [extras]
 */
export function apiModelHint(providerId, extras = {}) {
  const ws = Boolean(extras.webSearch);
  switch (providerId) {
    case "openai":
      return ws ? OPENAI_MODEL_WEB : OPENAI_MODEL;
    case "anthropic":
      return ws ? `${ANTHROPIC_MODEL} · web search` : ANTHROPIC_MODEL;
    case "gemini-flash":
      return ws ? `${GEMINI_MODEL_FLASH} · Google search` : GEMINI_MODEL_FLASH;
    case "perplexity":
      return ws ? PERPLEXITY_MODEL_SEARCH : PERPLEXITY_MODEL;
    default:
      return "";
  }
}

/** Подпись модели в подвале пузыря при генерации изображения. */
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

async function openaiImageGeneration(prompt, key) {
  const res = await fetch("/llm/openai/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      n: 1,
      size: "1024x1024",
    }),
  });
  if (!res.ok) {
    const msg = await readErrorBody(res);
    throw new Error(humanizeOpenAiImageError(msg, res.status));
  }
  const data = await res.json();
  const item = data.data?.[0];
  if (!item) throw new Error("Empty image API response");
  if (item.url) {
    return `![Generated image](${item.url})`;
  }
  if (item.b64_json) {
    return `![Generated image](data:image/png;base64,${item.b64_json})`;
  }
  throw new Error("API response contained no image URL or image data");
}

async function geminiImageGeneration(prompt, key) {
  const url = `/llm/gemini/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });
  if (!res.ok) throw new Error(await readErrorBody(res));
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    const block = data.promptFeedback?.blockReason;
    throw new Error(block ? `Request blocked: ${block}` : "Empty API response");
  }
  const textBits = [];
  let imageMd = "";
  for (const p of parts) {
    if (p?.thought === true) continue;
    if (p?.text) textBits.push(String(p.text));
    const id = p?.inlineData ?? p?.inline_data;
    if (id?.data && id?.mimeType) {
      const mime = String(id.mimeType);
      const b64 = String(id.data);
      imageMd = `![Generated image](data:${mime};base64,${b64})`;
    } else if (id?.data && id?.mime_type) {
      const mime = String(id.mime_type);
      const b64 = String(id.data);
      imageMd = `![Generated image](data:${mime};base64,${b64})`;
    }
  }
  if (!imageMd) {
    const t = textBits.join("\n").trim();
    throw new Error(t || "Model did not return an image");
  }
  const prefix = textBits.filter(Boolean).join("\n\n").trim();
  return prefix ? `${prefix}\n\n${imageMd}` : imageMd;
}

/**
 * Генерация изображения по текстовому описанию (режим «Создать изображение»).
 * @returns {Promise<{ text: string }>} markdown с картинкой (![]())
 */
export async function completeImageGeneration(providerId, prompt, apiKey) {
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
      const text = await openaiImageGeneration(trimmed, key);
      return { text };
    }
    case "gemini-flash": {
      const text = await geminiImageGeneration(trimmed, key);
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
