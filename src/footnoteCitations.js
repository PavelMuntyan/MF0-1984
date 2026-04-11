/**
 * Единая обработка сносок [1], [2] и markdown-ссылок [n](https…)
 * для ответов любых моделей (Perplexity, OpenAI, Gemini, Claude и т.д.).
 */

export function escapeHtmlAttrHref(url) {
  return String(url ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Сырой массив citations из ответа/чанка Perplexity (и похожих), плюс search_results.
 * @param {object} data — JSON чанка SSE или полного ответа
 * @returns {unknown[] | null}
 */
export function pickPerplexityCitationPayload(data) {
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.citations) && data.citations.length > 0) {
    return data.citations;
  }
  const ch0 = data.choices?.[0];
  if (Array.isArray(ch0?.citations) && ch0.citations.length > 0) {
    return ch0.citations;
  }
  if (Array.isArray(ch0?.message?.citations) && ch0.message.citations.length > 0) {
    return ch0.message.citations;
  }
  const sr = data.search_results ?? ch0?.search_results;
  if (!Array.isArray(sr) || sr.length === 0) {
    return null;
  }
  return sr;
}

/** URL из массива citations API (строки или объекты с `url` / `uri` / `link`). */
export function normalizeCitationUrlList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim());
    } else if (item && typeof item === "object") {
      const u = item.url ?? item.uri ?? item.link ?? item.href;
      if (typeof u === "string" && u.trim()) {
        out.push(u.trim());
      }
    }
  }
  return out.filter((u) => /^https?:\/\//i.test(u));
}

/** Чтобы markdown-ссылка `[n](url)` не обрывалась на `)` внутри URL. */
export function escapeUrlForMarkdownDestination(url) {
  return String(url ?? "")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

/**
 * Извлекает URL из OpenAI Chat Completions: `annotations` / `url_citation`.
 * @param {object|null|undefined} holder — `delta`, `message` или весь chunk
 */
export function collectOpenAiLikeAnnotationUrls(holder) {
  const ann = holder?.annotations;
  if (!Array.isArray(ann)) return [];
  const out = [];
  for (const a of ann) {
    const u =
      (a && typeof a.url_citation === "object" && typeof a.url_citation.url === "string"
        ? a.url_citation.url
        : null) ?? (typeof a?.url === "string" ? a.url : null);
    const s = typeof u === "string" ? u.trim() : "";
    if (s && /^https?:\/\//i.test(s) && !out.includes(s)) {
      out.push(s);
    }
  }
  return out;
}

/**
 * Источники из Gemini `groundingMetadata.groundingChunks`.
 * `uri` часто редирект на vertexaisearch — для UI важен `title` (заголовок страницы).
 * @param {object|null|undefined} candidate — `candidates[0]`
 * @returns {{ urls: string[], labels: string[] }}
 */
export function collectGeminiGroundingEntries(candidate) {
  const gm = candidate?.groundingMetadata;
  const chunks = gm?.groundingChunks;
  if (!Array.isArray(chunks)) {
    return { urls: [], labels: [] };
  }
  const urls = [];
  const labels = [];
  for (const ch of chunks) {
    const web = ch?.web;
    const ret = ch?.retrievedContext;
    const uri =
      (web && typeof web.uri === "string" && web.uri.trim()) ||
      (ret && typeof ret.uri === "string" && ret.uri.trim()) ||
      "";
    if (!uri || !/^https?:\/\//i.test(uri)) continue;
    const title =
      (web && typeof web.title === "string" && web.title.trim()) ||
      (ret && typeof ret.title === "string" && ret.title.trim()) ||
      "";
    let host = "";
    try {
      host = new URL(uri).hostname.replace(/^www\./i, "");
    } catch {
      /* ignore */
    }
    const n = urls.length + 1;
    const isVertexRedirect = /vertexaisearch\.cloud\.google\.com$/i.test(host);
    const label =
      title ||
      (isVertexRedirect ? `Web source ${n}` : host) ||
      `Source ${n}`;
    urls.push(uri);
    labels.push(label);
  }
  return { urls, labels };
}

/** Только URL (обратная совместимость). */
export function collectGeminiGroundingUrls(candidate) {
  return collectGeminiGroundingEntries(candidate).urls;
}

/**
 * @typedef {{ citationLabels?: string[] }} MergeCitationsOptions
 */

function sanitizeMarkdownLinkLabel(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/[\[\]]/g, "")
    .trim()
    .slice(0, 200);
}

/**
 * Голые сноски [n] в тексте + параллельный список URL из API → markdown `[n](url)`,
 * затем `preprocessMarkdownNumericFootnoteLinks` превращает их в HTML (надёжнее, чем сырой `<a>` в marked).
 * Если в тексте нет [n], но URL есть — блок **Sources**.
 * @param {MergeCitationsOptions} [options] — `citationLabels[i]` подпись для строки Sources (например title из Gemini).
 */
export function mergePlainBracketRefsWithCitationList(body, citationUrls, options = {}) {
  const urls = normalizeCitationUrlList(citationUrls);
  const text = String(body ?? "");
  if (urls.length === 0) return text;

  const labelArr = Array.isArray(options.citationLabels) ? options.citationLabels : null;

  const linked = text.replace(/\[(\d+)\](?!\()/g, (match, numStr) => {
    const idx = parseInt(numStr, 10) - 1;
    if (idx < 0 || idx >= urls.length) return match;
    const url = urls[idx];
    const dest = escapeUrlForMarkdownDestination(url);
    return `[${numStr}](${dest})`;
  });

  if (linked !== text) {
    return linked.replace(/(\]\([^)]+\))(?=\[\d+\]\()/g, "$1 ");
  }

  const lines = urls.map((u, i) => {
    let linkText = "";
    if (labelArr && typeof labelArr[i] === "string" && labelArr[i].trim()) {
      linkText = sanitizeMarkdownLinkLabel(labelArr[i]);
    }
    if (!linkText) {
      try {
        linkText = new URL(u).hostname.replace(/^www\./i, "") || `${i + 1}`;
      } catch {
        linkText = `${i + 1}`;
      }
    }
    return `${i + 1}. [${linkText}](${escapeUrlForMarkdownDestination(u)})`;
  });
  return `${text}\n\n---\n\n**Sources**\n\n${lines.join("\n")}`;
}

/**
 * Markdown-сноски `[n](https…)` (не изображения `![`) → вики-`<a>[n]</a>` + пробелы между соседними ссылками.
 * Вызывается перед `marked.parse` для всех ответов ассистента.
 */
export function preprocessMarkdownNumericFootnoteLinks(md) {
  let s = String(md ?? "");
  if (!s) return s;
  s = s.replace(/(?<!\!)\[(\d+)\]\((https?:[^)\s]+)\)/g, (_, num, url) => {
    return `<a href="${escapeHtmlAttrHref(url)}">[${num}]</a>`;
  });
  s = s.replace(/<\/a>(?=<a\s)/gi, "</a> ");
  s = s.replace(/(\]\([^)]+\))(?=\[\d+\]\(https?:)/g, "$1 ");
  return s;
}
