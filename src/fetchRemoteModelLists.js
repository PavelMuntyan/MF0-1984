/**
 * Fetches model id lists from provider APIs via the server-side `/api/llm/*` proxy.
 */

/**
 * @param {string} id
 */
function isLikelyOpenAiChatModel(id) {
  const s = String(id).toLowerCase();
  if (!s || s.includes("embedding") || s.includes("whisper") || s.includes("tts")) return false;
  if (s.includes("moderation") || s.includes("dall-e") || s.includes("dalle") || s.includes("realtime")) return false;
  if (s.startsWith("ft:") || s.startsWith("davinci") || s.startsWith("babbage") || s.startsWith("curie")) return false;
  return (
    s.startsWith("gpt-") ||
    s.startsWith("o") ||
    s.startsWith("chatgpt") ||
    s === "gpt-3.5-turbo" ||
    s.startsWith("gpt-3.5-turbo")
  );
}

/**
 * @param {string} id
 */
function isLikelyOpenAiImageModel(id) {
  const s = String(id).toLowerCase();
  if (!s) return false;
  return (
    s.includes("dall-e") ||
    s.includes("dalle") ||
    s.includes("gpt-image") ||
    s.includes("chatgpt-image") ||
    (s.includes("image") && (s.includes("gpt") || s.includes("o")))
  );
}

/**
 * @param {string} id
 */
function isLikelyOpenAiSearchModel(id) {
  const s = String(id).toLowerCase();
  return s.includes("search");
}

/**
 * Chat / reasoning models (excludes search-only SKUs where possible).
 * @param {string} id
 */
function isLikelyOpenAiResearchModel(id) {
  if (!isLikelyOpenAiChatModel(id)) return false;
  const s = id.toLowerCase();
  if (/-search-|search-api|search-preview/i.test(s)) return false;
  return true;
}

/**
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function fetchOpenAiRawModelIds(key) {
  const k = String(key ?? "").trim();
  if (!k) return [];
  const res = await fetch("/api/llm/openai/v1/models", {
    headers: { Authorization: `Bearer ${k}` },
  });
  if (!res.ok) return [];
  const j = await res.json();
  const rows = Array.isArray(j?.data) ? j.data : [];
  return [...new Set(rows.map((r) => String(r?.id ?? "").trim()).filter(Boolean))];
}

/**
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function fetchOpenAiDialogueModelIds(key) {
  const raw = await fetchOpenAiRawModelIds(key);
  return raw.filter(isLikelyOpenAiChatModel);
}

/**
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function fetchOpenAiImageModelIds(key) {
  const raw = await fetchOpenAiRawModelIds(key);
  return raw.filter(isLikelyOpenAiImageModel);
}

/**
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function fetchOpenAiSearchModelIds(key) {
  const raw = await fetchOpenAiRawModelIds(key);
  const fromApi = raw.filter(isLikelyOpenAiSearchModel);
  return fromApi.length ? fromApi : raw.filter(isLikelyOpenAiChatModel);
}

/**
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function fetchOpenAiResearchModelIds(key) {
  const raw = await fetchOpenAiRawModelIds(key);
  const fromApi = raw.filter(isLikelyOpenAiResearchModel);
  return fromApi.length ? fromApi : raw.filter(isLikelyOpenAiChatModel);
}

/**
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function fetchAnthropicModelIds(key) {
  const k = String(key ?? "").trim();
  if (!k) return [];
  const res = await fetch("/api/llm/anthropic/v1/models", {
    headers: {
      "x-api-key": k,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) return [];
  const j = await res.json();
  const rows = Array.isArray(j?.data) ? j.data : [];
  const ids = rows
    .map((r) => String(r?.id ?? "").trim())
    .filter((id) => id.toLowerCase().includes("claude"));
  return [...new Set(ids)];
}

/**
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function fetchGeminiGenerateContentModelIds(key) {
  const k = String(key ?? "").trim();
  if (!k) return [];
  /** @type {string[]} */
  const out = [];
  let pageToken = "";
  for (let page = 0; page < 30; page += 1) {
    const q = new URLSearchParams({ pageSize: "100", key: k });
    if (pageToken) q.set("pageToken", pageToken);
    const res = await fetch(`/api/llm/gemini/v1beta/models?${q.toString()}`);
    if (!res.ok) break;
    const j = await res.json();
    const models = Array.isArray(j?.models) ? j.models : [];
    for (const m of models) {
      const methods = m?.supportedGenerationMethods ?? m?.supportedActions ?? [];
      const ok = Array.isArray(methods) && methods.some((x) => String(x) === "generateContent");
      if (!ok) continue;
      const name = String(m?.name ?? "").trim();
      const short = name.startsWith("models/") ? name.slice("models/".length) : name;
      const base = String(m?.baseModelId ?? "").trim();
      const id = base || short;
      if (id) out.push(id);
    }
    pageToken = String(j?.nextPageToken ?? "").trim();
    if (!pageToken) break;
  }
  return [...new Set(out)];
}

/**
 * @param {string} id
 */
function isLikelyGeminiImageModel(id) {
  const s = String(id).toLowerCase();
  return s.includes("image") || s.includes("imagen");
}

/**
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function fetchGeminiImageModelIds(key) {
  const all = await fetchGeminiGenerateContentModelIds(key);
  const img = all.filter(isLikelyGeminiImageModel);
  return img.length ? img : all.filter((id) => id.toLowerCase().includes("imagen"));
}

/**
 * @param {string} id
 */
function isLikelyPerplexitySearchModel(id) {
  const s = String(id).toLowerCase();
  if (s.includes("reasoning") || s.includes("deep-research") || s.includes("deep_research")) return false;
  return s.includes("sonar") || s.includes("pplx");
}

/**
 * @param {string} id
 */
function isLikelyPerplexityResearchModel(id) {
  const s = String(id).toLowerCase();
  return s.includes("reasoning") || s.includes("deep-research") || s.includes("deep_research") || s.includes("research");
}

/**
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function fetchPerplexityModelIds(key) {
  const k = String(key ?? "").trim();
  if (!k) return [];
  const res = await fetch("/api/llm/perplexity/v1/models", {
    headers: { Authorization: `Bearer ${k}` },
  });
  if (!res.ok) return [];
  const j = await res.json();
  const rows = Array.isArray(j?.data) ? j.data : [];
  return [...new Set(rows.map((r) => String(r?.id ?? "").trim()).filter(Boolean))];
}

/**
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function fetchPerplexityDialogueModelIds(key) {
  const all = await fetchPerplexityModelIds(key);
  const d = all.filter((id) => !isLikelyPerplexityResearchModel(id));
  return d.length ? d : all;
}

/**
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function fetchPerplexitySearchModelIds(key) {
  const all = await fetchPerplexityModelIds(key);
  const s = all.filter(isLikelyPerplexitySearchModel);
  return s.length ? s : all;
}

/**
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function fetchPerplexityResearchModelIds(key) {
  const all = await fetchPerplexityModelIds(key);
  const r = all.filter(isLikelyPerplexityResearchModel);
  return r.length ? r : all;
}
