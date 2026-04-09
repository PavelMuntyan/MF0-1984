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
    throw new Error(block ? `Запрос отклонён: ${block}` : "Пустой ответ API");
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
 * Текст ошибки OpenAI для показа в чате (русский там, где типовые формулировки).
 * @param {string} raw
 * @param {number} [status]
 */
function humanizeOpenAiImageError(raw, status) {
  const s = String(raw ?? "").trim();
  const low = s.toLowerCase();
  if (low.includes("server had an error") || low.includes("sorry about that")) {
    const tail = s.length > 400 ? `${s.slice(0, 400)}…` : s;
    return (
      "OpenAI вернул ошибку сервера на этапе генерации изображения. " +
      "Частая причина — устаревшая модель DALL·E; в приложении используется GPT Image. " +
      "Проверьте в кабинете OpenAI доступ к GPT Image и верификацию организации при необходимости. " +
      `Текст API: ${tail}`
    );
  }
  if (low.includes("rate_limit") || low.includes("too many requests") || status === 429) {
    return "Слишком много запросов к OpenAI. Подождите немного и повторите.";
  }
  if (
    low.includes("insufficient_quota") ||
    low.includes("exceeded your current quota") ||
    (low.includes("billing") && low.includes("openai"))
  ) {
    return "Проверьте баланс и тариф API OpenAI (квота или оплата).";
  }
  if (low.includes("invalid_api_key") || low.includes("incorrect api key")) {
    return "Неверный или отозванный ключ OpenAI в .env.";
  }
  if (
    low.includes("model_not_found") ||
    (low.includes("model") && (low.includes("not found") || low.includes("does not exist")))
  ) {
    return (
      `Модель ${OPENAI_IMAGE_MODEL} недоступна для этого ключа или региона. ` +
      `Ответ API: ${s.length > 220 ? `${s.slice(0, 220)}…` : s}`
    );
  }
  if (low.includes("must be verified") || low.includes("organization must be verified")) {
    return (
      "Для GPT Image в OpenAI может требоваться верификация организации в кабинете разработчика. " +
      (s.length > 200 ? `${s.slice(0, 200)}…` : s)
    );
  }
  if (low.includes("content_policy") || low.includes("content_policy_violation")) {
    return "Запрос отклонён политикой контента OpenAI. Сформулируйте описание иначе.";
  }
  if (!s) {
    return status
      ? `Не удалось сгенерировать изображение (код ответа ${status}).`
      : "Не удалось сгенерировать изображение.";
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
    throw new Error("Нет ключа API для выбранной модели (.env)");
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Пустое сообщение");
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
      if (content == null) throw new Error("Пустой ответ API");
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
      if (!Array.isArray(blocks)) throw new Error("Неожиданный формат ответа");
      const textParts = blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text);
      const out = textParts.join("\n").trim();
      if (!out) throw new Error("Пустой ответ API");
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
      if (content == null) throw new Error("Пустой ответ API");
      return { text: typeof content === "string" ? content : String(content) };
    }
    default:
      throw new Error("Неизвестный провайдер");
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
    throw new Error("Нет ключа API для выбранной модели (.env)");
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Пустое сообщение");
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
      throw new Error("Неизвестный провайдер");
  }

  if (!String(full).trim()) {
    throw new Error("Пустой ответ API");
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
      return ws ? `${ANTHROPIC_MODEL} · поиск в сети` : ANTHROPIC_MODEL;
    case "gemini-flash":
      return ws ? `${GEMINI_MODEL_FLASH} · поиск Google` : GEMINI_MODEL_FLASH;
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
  if (!item) throw new Error("Пустой ответ API изображений");
  if (item.url) {
    return `![Сгенерированное изображение](${item.url})`;
  }
  if (item.b64_json) {
    return `![Сгенерированное изображение](data:image/png;base64,${item.b64_json})`;
  }
  throw new Error("В ответе API нет ни ссылки, ни данных изображения");
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
    throw new Error(block ? `Запрос отклонён: ${block}` : "Пустой ответ API");
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
      imageMd = `![Сгенерированное изображение](data:${mime};base64,${b64})`;
    } else if (id?.data && id?.mime_type) {
      const mime = String(id.mime_type);
      const b64 = String(id.data);
      imageMd = `![Сгенерированное изображение](data:${mime};base64,${b64})`;
    }
  }
  if (!imageMd) {
    const t = textBits.join("\n").trim();
    throw new Error(t || "Модель не вернула изображение");
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
    throw new Error("Нет ключа API для выбранной модели (.env)");
  }
  const trimmed = String(prompt ?? "").trim();
  if (!trimmed) {
    throw new Error("Пустое сообщение");
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
        "Эта модель не создаёт изображения. Выберите ChatGPT или Gemini (ключ в .env).",
      );
    default:
      throw new Error("Неизвестный провайдер");
  }
}
