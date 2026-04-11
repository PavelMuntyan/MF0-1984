/**
 * Разбор потоковых ответов (SSE) от LLM через fetch + прокси.
 *
 * Gemini: в URL обязателен query `alt=sse`, иначе REST отдаёт не классический SSE — см. curl в ai.google.dev (streamGenerateContent).
 * OpenAI / Perplexity: события `data: {...}`; разбор построчно, т.к. часть прокси не вставляет пустую строку между событиями (`\n\n`).
 */

import {
  collectGeminiGroundingEntries,
  collectOpenAiLikeAnnotationUrls,
  pickPerplexityCitationPayload,
} from "./footnoteCitations.js";

/**
 * OpenAI-совместимый SSE (OpenAI, Perplexity): каждая строка `data: {JSON}`.
 * Perplexity: `citations` в корне. OpenAI (web search): URL в `delta.annotations` / `message.annotations`.
 * @returns {Promise<{ text: string, citations: string[] }>}
 */
export async function streamOpenAICompatJson(res, onDelta) {
  if (!res.ok) {
    const err = await res.text();
    let msg = err.slice(0, 400);
    try {
      const j = JSON.parse(err);
      msg = j.error?.message ?? j.message ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg || res.statusText);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const dec = new TextDecoder();
  let buffer = "";
  let full = "";
  /** @type {string[]} */
  let citations = [];
  let sawDone = false;

  function mergeCitationsFromJson(j) {
    const raw = pickPerplexityCitationPayload(j);
    if (raw && raw.length > 0) {
      const next = [];
      for (const item of raw) {
        if (typeof item === "string" && item.trim()) {
          next.push(item.trim());
        } else if (item && typeof item === "object" && typeof item.url === "string" && item.url.trim()) {
          next.push(item.url.trim());
        }
      }
      if (next.length > 0) {
        citations = next;
      }
      return;
    }
    const ch0 = j.choices?.[0];
    for (const u of collectOpenAiLikeAnnotationUrls(ch0?.delta)) {
      if (typeof u === "string" && u.trim() && !citations.includes(u)) {
        citations.push(u);
      }
    }
    for (const u of collectOpenAiLikeAnnotationUrls(ch0?.message)) {
      if (typeof u === "string" && u.trim() && !citations.includes(u)) {
        citations.push(u);
      }
    }
  }

  function handleDataPayload(data) {
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }
    try {
      const j = JSON.parse(data);
      mergeCitationsFromJson(j);
      const piece = j.choices?.[0]?.delta?.content;
      if (typeof piece === "string" && piece.length) {
        full += piece;
        onDelta(piece);
      }
    } catch {
      /* неполная строка / не JSON */
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    buffer += dec.decode(value || new Uint8Array(), { stream: !done });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const line = raw.replace(/\r$/, "").trim();
      if (!line) continue;
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      handleDataPayload(data);
      if (sawDone) return { text: full, citations };
    }
    if (done) break;
  }

  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    handleDataPayload(tail.slice(5).trim());
  }
  return { text: full, citations };
}

/** Anthropic messages stream (SSE, строки data: …) */
export async function streamAnthropicMessages(res, onDelta) {
  if (!res.ok) {
    const t = await res.text();
    let msg = t.slice(0, 400);
    try {
      const j = JSON.parse(t);
      msg = j.error?.message ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg || res.statusText);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const dec = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += dec.decode(value || new Uint8Array(), { stream: !done });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const line = raw.replace(/\r$/, "").trim();
      if (!line.startsWith("data:")) continue;
      const dataLine = line.slice(5).trim();
      if (!dataLine) continue;
      try {
        const j = JSON.parse(dataLine);
        if (j.type !== "content_block_delta" || !j.delta) continue;
        const piece =
          typeof j.delta.text === "string" && j.delta.text.length > 0 ? j.delta.text : "";
        if (piece) {
          full += piece;
          onDelta(piece);
        }
      } catch {
        /* ignore */
      }
    }
    if (done) break;
  }
  return full;
}

/**
 * Google Gemini streamGenerateContent при `alt=sse`: строки `data: {…}`.
 * Части с thought: true — внутренние рассуждения, в чат не показываем.
 * Собирает URL из `groundingMetadata` для сносок [1], [2] в тексте.
 * @returns {Promise<{ text: string, citations: string[], citationLabels: string[] }>}
 */
export async function streamGeminiGenerateContent(res, onDelta) {
  if (!res.ok) {
    const t = await res.text();
    let msg = t.slice(0, 400);
    try {
      const j = JSON.parse(t);
      msg = j.error?.message ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg || res.statusText);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const dec = new TextDecoder();
  let buffer = "";
  let full = "";
  /** @type {string[]} */
  let citations = [];
  /** @type {string[]} */
  let citationLabels = [];

  function mergeGeminiGroundingFromJson(j) {
    const cand = j.candidates?.[0];
    if (!cand) return;
    const ent = collectGeminiGroundingEntries(cand);
    if (ent.urls.length === 0) return;
    citations = ent.urls;
    citationLabels = ent.labels;
  }

  function emitGeminiParts(parts) {
    if (!Array.isArray(parts)) return;
    for (const p of parts) {
      if (!p || p.thought === true) continue;
      const t = p.text;
      if (typeof t === "string" && t.length) {
        full += t;
        onDelta(t);
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    buffer += dec.decode(value || new Uint8Array(), { stream: !done });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const line = raw.replace(/\r$/, "").trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        mergeGeminiGroundingFromJson(j);
        emitGeminiParts(j.candidates?.[0]?.content?.parts);
      } catch {
        /* ignore */
      }
    }
    if (done) break;
  }

  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    const data = tail.slice(5).trim();
    if (data && data !== "[DONE]") {
      try {
        const j = JSON.parse(data);
        mergeGeminiGroundingFromJson(j);
        emitGeminiParts(j.candidates?.[0]?.content?.parts);
      } catch {
        /* ignore */
      }
    }
  }
  return { text: full, citations, citationLabels };
}
