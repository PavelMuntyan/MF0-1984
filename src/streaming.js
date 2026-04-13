/**
 * Parse streaming LLM responses (SSE) from fetch + proxy.
 *
 * Gemini: URL must include `alt=sse` or REST returns non-classic SSE — see ai.google.dev streamGenerateContent.
 * OpenAI / Perplexity: `data: {...}` lines; line-based parse because some proxies omit blank lines between events (`\n\n`).
 */

import {
  collectGeminiGroundingEntries,
  collectOpenAiLikeAnnotationUrls,
  pickPerplexityCitationPayload,
} from "./footnoteCitations.js";

/**
 * OpenAI-compatible SSE (OpenAI, Perplexity): each line `data: {JSON}`.
 * Perplexity: root `citations`. OpenAI (web search): URLs in `delta.annotations` / `message.annotations`.
 * @returns {Promise<{ text: string, citations: string[], usage: { promptTokens: number, completionTokens: number, totalTokens: number } | null }>}
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
  /** @type {{ promptTokens: number, completionTokens: number, totalTokens: number } | null} */
  let usage = null;

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
      if (j.usage && typeof j.usage === "object") {
        const p = Number(j.usage.prompt_tokens);
        const c = Number(j.usage.completion_tokens);
        const t = Number(j.usage.total_tokens);
        if (Number.isFinite(p) || Number.isFinite(c) || Number.isFinite(t)) {
          usage = {
            promptTokens: Number.isFinite(p) ? Math.max(0, Math.floor(p)) : 0,
            completionTokens: Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 0,
            totalTokens: Number.isFinite(t)
              ? Math.max(0, Math.floor(t))
              : (Number.isFinite(p) ? Math.max(0, Math.floor(p)) : 0) +
                (Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 0),
          };
        }
      }
      mergeCitationsFromJson(j);
      const piece = j.choices?.[0]?.delta?.content;
      if (typeof piece === "string" && piece.length) {
        full += piece;
        onDelta(piece);
      }
    } catch {
      /* incomplete line / not JSON */
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
      if (sawDone) return { text: full, citations, usage };
    }
    if (done) break;
  }

  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    handleDataPayload(tail.slice(5).trim());
  }
  return { text: full, citations, usage };
}

/** Anthropic messages stream (SSE, `data:` lines)
 * @returns {Promise<{ text: string, usage: { promptTokens: number, completionTokens: number, totalTokens: number } | null }>}
 */
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
  /** @type {{ promptTokens: number, completionTokens: number, totalTokens: number } | null} */
  let usage = null;

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
        if (j.usage && typeof j.usage === "object") {
          const inp = Number(j.usage.input_tokens);
          const outp = Number(j.usage.output_tokens);
          if (Number.isFinite(inp) || Number.isFinite(outp)) {
            const promptTokens = Number.isFinite(inp) ? Math.max(0, Math.floor(inp)) : 0;
            const completionTokens = Number.isFinite(outp) ? Math.max(0, Math.floor(outp)) : 0;
            usage = {
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            };
          }
        }
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
  return { text: full, usage };
}

/**
 * Google Gemini streamGenerateContent with `alt=sse`: `data: {...}` lines.
 * Parts with thought: true are internal reasoning — not shown in chat.
 * Collects URLs from `groundingMetadata` for numeric refs [1], [2] in text.
 * @returns {Promise<{ text: string, citations: string[], citationLabels: string[], usage: { promptTokens: number, completionTokens: number, totalTokens: number } | null }>}
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
  /** @type {{ promptTokens: number, completionTokens: number, totalTokens: number } | null} */
  let usage = null;

  function mergeGeminiGroundingFromJson(j) {
    const um = j.usageMetadata;
    if (um && typeof um === "object") {
      const p = Number(um.promptTokenCount);
      const c = Number(um.candidatesTokenCount);
      const t = Number(um.totalTokenCount);
      if (Number.isFinite(p) || Number.isFinite(c) || Number.isFinite(t)) {
        const promptTokens = Number.isFinite(p) ? Math.max(0, Math.floor(p)) : 0;
        const completionTokens = Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 0;
        usage = {
          promptTokens,
          completionTokens,
          totalTokens: Number.isFinite(t) ? Math.max(0, Math.floor(t)) : promptTokens + completionTokens,
        };
      }
    }
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
  return { text: full, citations, citationLabels, usage };
}
