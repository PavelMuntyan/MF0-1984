/**
 * Unified handling of bracket refs [1], [2] and markdown links [n](https…)
 * for replies from any model (Perplexity, OpenAI, Gemini, Claude, etc.).
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
 * Raw citations array from a Perplexity-like response/chunk, plus search_results.
 * @param {object} data — SSE chunk JSON or full response JSON
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

/** URLs from a citations API array (strings or objects with `url` / `uri` / `link`). */
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

/** So markdown `[n](url)` does not break on `)` inside the URL. */
export function escapeUrlForMarkdownDestination(url) {
  return String(url ?? "")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

/**
 * Extract URLs from OpenAI Chat Completions: `annotations` / `url_citation`.
 * @param {object|null|undefined} holder — `delta`, `message`, or whole chunk
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
 * Sources from Gemini `groundingMetadata.groundingChunks`.
 * `uri` often redirects via vertexaisearch — for UI, prefer `title` (page title).
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

/** URLs only (backward compatibility). */
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
 * Bare [n] refs in text + parallel URL list from API → markdown `[n](url)`,
 * then `preprocessMarkdownNumericFootnoteLinks` turns them into HTML (safer than raw `<a>` in marked).
 * If there are URLs but no [n] in text — append a **Sources** block.
 * @param {MergeCitationsOptions} [options] — `citationLabels[i]` label for Sources rows (e.g. Gemini title).
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
 * Markdown footnotes `[n](https…)` (not images `![`) → wiki-style `<a>[n]</a>` + spaces between adjacent links.
 * Called before `marked.parse` for all assistant replies.
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
