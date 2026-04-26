/**
 * Pre-turn “router” model: reads the Memory tree and selects excerpts useful for the user’s next message.
 * Retrieval design aligned with Cyprus Discovery’s `routeMemoryForUserQuery` (hybrid lexical + 1-hop expand + JSON rerank),
 * adapted to MF0’s graph shape: nodes { id, category, label, blob }, links { source, target, label }.
 */

import {
  usageFromAnthropicResponse,
  usageFromGeminiResponse,
  usageFromOpenAiStyleUsage,
} from "./chatApi.js";
import { recordAuxLlmUsage } from "./chatPersistence.js";

/** First line of the supplement user message — must match fitContextToBudget detection. */
export const MF0_MEMORY_TREE_SUPPLEMENT_PREFIX =
  "<<< MF0_MEMORY_TREE_SUPPLEMENT (personal Memory tree excerpts for this request; not the user's literal message)";

const ROUTER_MODEL = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-20241022",
  "gemini-flash": "gemini-2.0-flash",
  perplexity: "sonar",
};

const ANTHROPIC_BROWSER_ACCESS_HEADER = {
  "anthropic-dangerous-direct-browser-access": "true",
};

/** LLM rerank: same contract shape as Cyprus Discovery `MEMORY_ROUTE_RERANK_INSTRUCTION`. */
const MEMORY_TREE_RERANK_SYSTEM = `You receive USER_QUESTION and candidate nodes from the user's MF0 Memory graph.
Each candidate has: id, category, label, blobExcerpt (notes / facts — truncated).
The user may write in any language; category/label may use another language.

Return JSON only:
{"ids":["bestNodeId1","bestNodeId2",...],"rationale":"short reason"}

Rules:
- Choose up to 22 ids that best help answer the question.
- Use semantic relevance (intent + relation), not literal token overlap only.
- A node may still be relevant when blobExcerpt is short/empty if its category/label itself carries the needed fact.
- Favor factual coverage (lists, names, dates, constraints) over vague topical similarity.
- Use only ids from provided candidates.
- If no candidate is useful, return {"ids":[],"rationale":"none"}.
- No markdown code fences outside the JSON object.`;

const MEMORY_TREE_TITLE_SCAN_SYSTEM = `You receive USER_QUESTION and a chunk of Memory graph node titles (id, category, label).
The user may write in any language; titles may mix languages.

Return JSON only:
{"ids":["nodeId1","nodeId2",...],"rationale":"short reason"}

Rules:
- Pick node ids that may contain facts needed to answer the user question, using semantic intent — not literal word match only.
- Include ids whose category/label may serve as the answer even if no long note text is attached.
- Use only ids from the provided chunk.
- If none look relevant, return {"ids":[],"rationale":"none"}.
- No markdown code fences outside the JSON object.`;

const RERANK_MAX_OUT = 950;
const LEX_RETRIEVE_HAY = 2800;
const BLOB_EXCERPT_RERANK = 720;
const BLOB_SUPPLEMENT_EACH = 1800;
/** Max nodes embedded into the Memory-tree supplement (router + augment). */
const MAX_IDS = 22;
const EXPAND_ID_CAP = 220;
const RERANK_POOL_START = 72;
/** Graphs at or below this size: every node is eligible for rerank (then JSON is trimmed to the model budget). */
const GRAPH_FULL_NODES_FOR_RERANK = 320;
/** For compact trees, append global title index so name-only leaf nodes are always visible to the main model. */
const GRAPH_APPEND_TITLE_INDEX_MAX_NODES = 420;

/** Generic synonym expansion (not project-specific); mirrors Cyprus Discovery’s pattern. */
const QUERY_SYNONYMS = {
  threats: ["risk", "risks", "pressure", "pressures", "danger", "threats"],
  endangered: ["critical", "vulnerable", "decline", "endangered"],
  percentage: ["percent", "%", "ratio", "share", "quota"],
  annually: ["yearly", "per year", "annual"],
  production: ["manufacturing", "making", "process"],
  regulations: ["rules", "law", "legal", "requirement", "requirements"],
  population: ["group", "species", "community"],
};

/**
 * @param {string} text
 */
function estimateTokensFromText(text) {
  const s = String(text ?? "").trim();
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}

/**
 * @param {{ promptTokens: number, completionTokens: number, totalTokens: number } | null} usage
 * @param {string} promptText
 * @param {string} completionText
 */
function withUsageFallback(usage, promptText, completionText) {
  if (usage && Number.isFinite(usage.totalTokens) && Number(usage.totalTokens) > 0) return usage;
  const promptTokens = estimateTokensFromText(promptText);
  const completionTokens = estimateTokensFromText(completionText);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/**
 * @param {Response} res
 */
async function readErrorBody(res) {
  const t = await res.text();
  try {
    const j = JSON.parse(t);
    return j.error?.message ?? j.message ?? t;
  } catch {
    return t || res.statusText;
  }
}

function stripCodeFence(text) {
  const t = String(text).trim();
  const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/im);
  if (m) return m[1].trim();
  return t;
}

/**
 * @param {string} text
 * @returns {{ ids: string[], rationale: string }}
 */
function parseRouteIdsJson(text) {
  let ids = [];
  let rationale = "";
  try {
    const inner = stripCodeFence(text);
    const o = JSON.parse(inner || text);
    if (Array.isArray(o.ids)) ids = o.ids.map((x) => String(x).trim()).filter(Boolean);
    if (o.rationale != null) rationale = String(o.rationale).trim().slice(0, 500);
  } catch {
    /* ignore */
  }
  return { ids, rationale };
}

function normText(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%.\- ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} s
 * @returns {string[]}
 */
function tokenWords(s) {
  return normText(s)
    .split(" ")
    .map((x) => x.trim())
    .filter((x) => x.length >= 3);
}

/**
 * @param {string[]} words
 */
function expandWithSynonyms(words) {
  const out = new Set(words);
  for (const w of words) {
    if (!QUERY_SYNONYMS[w]) continue;
    for (const alt of QUERY_SYNONYMS[w]) out.add(alt);
  }
  return [...out];
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function extractEntitySignals(text) {
  const raw = String(text ?? "");
  const out = [];
  const years = raw.match(/\b(19|20)\d{2}\b/g) || [];
  const perc = raw.match(/\b\d{1,3}(?:[.,]\d+)?\s?%/g) || [];
  out.push(...years, ...perc);
  return [...new Set(out.map((x) => x.trim()))];
}

/**
 * @param {Array<{ id: string, category: string, label: string, blobHay: string }>} rows
 * @param {string[]} queryTerms
 * @param {string[]} entitySignals
 * @returns {{ lexicalTop: string[], entityTop: string[], scoreById: Map<string, number> }}
 */
function retrieveLexicalAndEntity(rows, queryTerms, entitySignals) {
  const scoreById = new Map();
  const entityScoreById = new Map();
  for (const r of rows) {
    const hay = normText(`${r.category} ${r.label} ${r.blobHay}`);
    let lexical = 0;
    for (const q of queryTerms) {
      if (!q) continue;
      if (hay.includes(normText(q))) lexical += q.length >= 6 ? 2 : 1;
    }
    let entity = 0;
    const raw = `${r.category} ${r.label} ${r.blobHay}`;
    for (const sig of entitySignals) {
      if (sig && raw.includes(sig)) entity += 3;
    }
    if (lexical > 0) scoreById.set(r.id, lexical + entity);
    if (entity > 0) entityScoreById.set(r.id, entity);
  }
  const lexicalTop = [...scoreById.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 120)
    .map((x) => x[0]);
  const entityTop = [...entityScoreById.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80)
    .map((x) => x[0]);
  return { lexicalTop, entityTop, scoreById };
}

/**
 * @param {unknown[]} links
 * @returns {Map<string, Set<string>>}
 */
function buildAdjacency(links) {
  const m = new Map();
  for (const e of links) {
    if (!e || typeof e !== "object") continue;
    const from = String(/** @type {{ source?: string }} */ (e).source ?? "").trim();
    const to = String(/** @type {{ target?: string }} */ (e).target ?? "").trim();
    if (!from || !to) continue;
    if (!m.has(from)) m.set(from, new Set());
    if (!m.has(to)) m.set(to, new Set());
    m.get(from)?.add(to);
    m.get(to)?.add(from);
  }
  return m;
}

/**
 * @param {string} q
 */
function queryTokens(q) {
  const s = String(q ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ");
  const parts = s.split(/\s+/).filter((w) => w.length > 2);
  return [...new Set(parts)];
}

/**
 * @param {{ id?: string, category?: string, label?: string, blob?: string }} n
 * @param {string[]} tokens
 */
function nodeRelevanceScore(n, tokens) {
  const hay = `${String(n.category ?? "")} ${String(n.label ?? "")} ${String(n.blob ?? "").slice(0, 1200)}`.toLowerCase();
  let s = 0;
  for (const t of tokens) {
    if (t && hay.includes(t)) s += 2;
  }
  if (String(n.label ?? "").toLowerCase() === "user" && String(n.category ?? "").toLowerCase() === "people") s += 50;
  return s;
}

/**
 * Serialize graph for the router in compact skeleton form (legacy / diagnostics).
 * @param {{ nodes?: unknown[], links?: unknown[] }} graph
 * @param {string} userQuery
 * @param {{ maxTotalChars?: number }} [opts]
 */
export function serializeMemoryGraphForRouter(graph, userQuery, opts = {}) {
  const maxTotal = opts.maxTotalChars ?? 28000;
  const maxNodes = 240;
  const maxEdges = 320;
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const links = Array.isArray(graph?.links) ? graph.links : [];
  const tokens = queryTokens(userQuery);

  const scored = nodes
    .filter((x) => x && typeof x === "object")
    .map((n) => ({
      n,
      score: nodeRelevanceScore(
        /** @type {{ category?: string, label?: string, blob?: string }} */ (n),
        tokens,
      ),
    }));
  scored.sort((a, b) => b.score - a.score);

  const idToLine = new Map();
  for (const { n } of scored) {
    const id = String(n.id ?? "").trim();
    const cat = String(n.category ?? "").trim();
    const lab = String(n.label ?? "").trim();
    idToLine.set(id, `NODE id=${id || "?"} | ${cat || "?"} / ${lab || "?"}`);
  }

  /** @type {string[]} */
  const parts = [];
  parts.push("EDGES (source_node_id -> target_node_id : relation):");
  for (const e of links.slice(0, maxEdges)) {
    if (!e || typeof e !== "object") continue;
    parts.push(`${String(e.source ?? "").trim()} -> ${String(e.target ?? "").trim()} : ${String(e.label ?? "").trim()}`);
  }
  parts.push("\nNODES (most relevant first, then remainder):\n");

  let used = parts.join("\n").length;
  const seen = new Set();
  for (const { n } of scored.slice(0, maxNodes)) {
    const id = String(n.id ?? "").trim();
    const line = idToLine.get(id) ?? "";
    if (seen.has(id)) continue;
    seen.add(id);
    if (used + line.length + 2 > maxTotal) break;
    parts.push(line);
    used += line.length + 2;
  }

  if (scored.length > seen.size) {
    parts.push(`\n… (${scored.length - seen.size} further nodes omitted for size cap)`);
  }

  return parts.join("\n");
}

/**
 * @param {Record<string, string>} allKeys
 * @param {string[]} [analysisPriority]
 * @param {string} activeProviderId
 * @param {string} activeApiKey
 */
function pickRouterKey(allKeys, analysisPriority, activeProviderId, activeApiKey) {
  const preferred = Array.isArray(analysisPriority)
    ? analysisPriority
    : ["openai", "anthropic", "gemini-flash", "perplexity"];
  for (const pid of preferred) {
    const key = String(allKeys?.[pid] ?? "").trim();
    if (key) return { providerId: pid, key };
  }
  const k = String(activeApiKey ?? "").trim();
  if (k) return { providerId: activeProviderId, key: k };
  return { providerId: "", key: "" };
}

/**
 * @param {string} providerId
 * @param {string} key
 * @param {string} systemPrompt
 * @param {string} userBlock
 * @param {number} maxOutTokens
 * @returns {Promise<{ text: string, usage: { promptTokens: number, completionTokens: number, totalTokens: number } | null }>}
 */
async function runRouterLlm(providerId, key, systemPrompt, userBlock, maxOutTokens) {
  const ub = String(userBlock).slice(0, 32000);
  switch (providerId) {
    case "openai": {
      const res = await fetch("/llm/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: ROUTER_MODEL.openai,
          temperature: 0.12,
          max_completion_tokens: maxOutTokens,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: ub },
          ],
        }),
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content : String(content ?? "");
      return { text, usage: usageFromOpenAiStyleUsage(data.usage) };
    }
    case "anthropic": {
      const body = {
        model: ROUTER_MODEL.anthropic,
        max_tokens: maxOutTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: ub }],
      };
      const res = await fetch("/llm/anthropic/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          ...ANTHROPIC_BROWSER_ACCESS_HEADER,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const blocks = data.content;
      if (!Array.isArray(blocks)) throw new Error("Unexpected Anthropic response");
      const text = blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { text, usage: usageFromAnthropicResponse(data) };
    }
    case "gemini-flash": {
      const url = `/llm/gemini/v1beta/models/${ROUTER_MODEL["gemini-flash"]}:generateContent?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: `${systemPrompt}\n\n${ub}` }],
            },
          ],
          generationConfig: {
            temperature: 0.12,
            maxOutputTokens: maxOutTokens,
          },
        }),
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const cand = data.candidates?.[0]?.content?.parts;
      if (!Array.isArray(cand)) throw new Error("Empty Gemini router response");
      const text = cand
        .filter((p) => p && p.thought !== true && p.text)
        .map((p) => String(p.text))
        .join("\n")
        .trim();
      return { text, usage: usageFromGeminiResponse(data) };
    }
    case "perplexity": {
      const res = await fetch("/llm/perplexity/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: ROUTER_MODEL.perplexity,
          temperature: 0.12,
          max_tokens: maxOutTokens,
          disable_search: true,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: ub },
          ],
        }),
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content : String(content ?? "");
      return { text, usage: usageFromOpenAiStyleUsage(data.usage) };
    }
    default:
      throw new Error(`Memory tree router: unsupported provider ${providerId}`);
  }
}

/**
 * Shrink rerank candidate list until JSON fits provider context budget.
 * @param {unknown[]} pool
 * @param {string} userQuery
 * @param {number} maxJsonChars
 */
function trimRerankPoolByJsonSize(pool, userQuery, maxJsonChars) {
  let p = [...pool];
  const header = `USER_QUESTION:\n${String(userQuery ?? "").trim().slice(0, 8000)}\n\nCANDIDATES_JSON:\n`;
  while (p.length > 6) {
    const payload = header + JSON.stringify(p);
    if (payload.length <= maxJsonChars) break;
    p = p.slice(0, p.length - 4);
  }
  return p;
}

/**
 * Split rows into title chunks so every node can be seen by the router.
 * @param {Array<{ id: string, category: string, label: string }>} rows
 * @param {number} [maxChars]
 */
function buildTitleChunks(rows, maxChars = 10_000) {
  /** @type {Array<Array<{ id: string, category: string, label: string }>>} */
  const chunks = [];
  /** @type {Array<{ id: string, category: string, label: string }>} */
  let cur = [];
  let used = 0;
  for (const r of rows) {
    const line = `${r.id} | ${r.category} | ${r.label}`;
    const add = line.length + 2;
    if (cur.length > 0 && used + add > maxChars) {
      chunks.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(r);
    used += add;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/**
 * Phase 1: scan all node titles in chunks and collect potentially relevant ids.
 * @param {string} providerId
 * @param {string} key
 * @param {string} userQuery
 * @param {Array<{ id: string, category: string, label: string }>} rows
 */
async function selectCandidateIdsByTitleChunks(providerId, key, userQuery, rows) {
  const chunks = buildTitleChunks(rows);
  /** @type {Set<string>} */
  const out = new Set();
  /** @type {string[]} */
  const rationales = [];
  let usageSum = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const chunk of chunks) {
    const userBlock =
      `USER_QUESTION:\n${String(userQuery ?? "").trim().slice(0, 8000)}\n\nNODE_TITLES_CHUNK_JSON:\n` +
      JSON.stringify(chunk);
    const { text, usage } = await runRouterLlm(
      providerId,
      key,
      MEMORY_TREE_TITLE_SCAN_SYSTEM,
      userBlock,
      450,
    );
    const parsed = parseRouteIdsJson(String(text ?? ""));
    const allowed = new Set(chunk.map((x) => x.id));
    for (const id of parsed.ids) {
      if (allowed.has(id)) out.add(id);
    }
    if (parsed.rationale) rationales.push(parsed.rationale);
    const usageSafe = withUsageFallback(
      usage,
      `${MEMORY_TREE_TITLE_SCAN_SYSTEM}\n\n${userBlock}`,
      text,
    );
    usageSum = {
      promptTokens: usageSum.promptTokens + usageSafe.promptTokens,
      completionTokens: usageSum.completionTokens + usageSafe.completionTokens,
      totalTokens: usageSum.totalTokens + usageSafe.totalTokens,
    };
  }
  return { ids: [...out], rationale: rationales.filter(Boolean).slice(0, 2).join(" | "), usage: usageSum };
}

/**
 * @param {Map<string, unknown>} byId
 * @param {string[]} validIds
 * @param {string} rationale
 */
function buildSupplementFromNodes(byId, validIds, rationale) {
  const lines = [];
  lines.push("ROUTER_FOCUS (Memory graph — hybrid retrieve + rerank):");
  if (rationale) lines.push(String(rationale).trim());
  lines.push(
    "When a section shows (no notes in this node), the `### category / label` line alone may still be the stored canonical name (common for leaf entity nodes).",
  );
  lines.push("");
  let used = lines.join("\n").length;
  const cap = 24_000;
  // Keep router/graph rank order; relevance is encoded in `validIds`.
  for (const id of validIds) {
    const n = byId.get(id);
    if (!n || typeof n !== "object") continue;
    const cat = String(/** @type {{ category?: string }} */ (n).category ?? "").trim();
    const lab = String(/** @type {{ label?: string }} */ (n).label ?? "").trim();
    const blob = String(/** @type {{ blob?: string }} */ (n).blob ?? "").trim().slice(0, BLOB_SUPPLEMENT_EACH);
    const sec = [`### ${cat || "?"} / ${lab || "?"}`, blob || "(no notes in this node)", ""].join("\n");
    if (used + sec.length > cap) break;
    lines.push(sec);
    used += sec.length;
  }
  return lines.join("\n").trim();
}

/**
 * Build compact title index over all nodes (for small graphs).
 * @param {Array<{ id: string, category: string, label: string }>} rows
 * @param {number} [maxChars]
 * @returns {string}
 */
function buildAllNodeTitleIndex(rows, maxChars = 16_000) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const lines = ["=== MEMORY GRAPH TITLE INDEX (all nodes, compact) ==="];
  let used = lines[0].length + 1;
  const sorted = [...rows].sort((a, b) => {
    const pa = `${a.category} / ${a.label}`;
    const pb = `${b.category} / ${b.label}`;
    return pa.localeCompare(pb, undefined, { sensitivity: "base" });
  });
  for (const r of sorted) {
    const line = `- ${r.category} / ${r.label}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n").trim();
}

/**
 * Expand selected ids along graph edges (2 hops), then rank nearby nodes so label-only facts are not dropped.
 * Universal graph heuristic: many names live in short/empty-note leaf nodes a hop or two away from a hub.
 * @param {string[]} ids
 * @param {Map<string, unknown>} byId
 * @param {unknown[]} links
 * @param {number} [cap]
 */
/**
 * Add every direct neighbor of the current id set (reaches parent hubs from leaf picks).
 * @param {string[]} ids
 * @param {Map<string, unknown>} byId
 * @param {unknown[]} links
 */
function expandOneGraphHop(ids, byId, links) {
  const adj = buildAdjacency(links);
  const out = new Set(ids.filter((id) => byId.has(id)));
  for (const id of [...out]) {
    for (const nb of adj.get(id) ?? []) {
      if (byId.has(nb)) out.add(nb);
    }
  }
  return [...out];
}

/**
 * Iteratively attach all neighbors of hub-like nodes (many incident edges), so sibling leaves are not split.
 * Degree bounds avoid exploding on mega-hubs in huge graphs.
 * @param {string[]} ids
 * @param {Map<string, unknown>} byId
 * @param {unknown[]} links
 */
function fullyExpandHubNeighbors(ids, byId, links) {
  const adj = buildAdjacency(links);
  const out = new Set(ids.filter((id) => byId.has(id)));
  const degMin = 2;
  const degMax = 160;
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...out]) {
      const deg = Number(adj.get(id)?.size || 0);
      if (deg < degMin || deg > degMax) continue;
      for (const nb of adj.get(id) ?? []) {
        if (!byId.has(nb) || out.has(nb)) continue;
        out.add(nb);
        changed = true;
      }
    }
  }
  return [...out];
}

/**
 * Keep anchor ids first, then fill remaining slots with graph-ranked ids.
 * @param {string[]} expandedIds
 * @param {string[]} anchorIds
 * @param {Map<string, unknown>} byId
 * @param {unknown[]} links
 * @param {number} cap
 */
function capExpandedWithAnchors(expandedIds, anchorIds, byId, links, cap) {
  const expandedSet = new Set(expandedIds.filter((id) => byId.has(id)));
  const out = [];
  for (const id of anchorIds) {
    if (!expandedSet.has(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= cap) return out.slice(0, cap);
  }
  const rest = [...expandedSet].filter((id) => !out.includes(id));
  const ranked = augmentIdsWithNeighborLeaves(rest, byId, links, cap);
  for (const id of ranked) {
    if (out.length >= cap) break;
    if (!out.includes(id)) out.push(id);
  }
  return out.slice(0, cap);
}

function augmentIdsWithNeighborLeaves(ids, byId, links, cap = MAX_IDS) {
  const adj = buildAdjacency(links);
  const seeds = ids.filter((id) => byId.has(id));
  const out = new Set(seeds);
  let frontier = [...seeds];
  const maxHops = 3;
  const softCap = Math.min(cap * 5, 220);
  for (let hop = 0; hop < maxHops; hop++) {
    const next = [];
    for (const baseId of frontier) {
      for (const nid of adj.get(baseId) ?? []) {
        if (out.has(nid) || !byId.has(nid)) continue;
        out.add(nid);
        next.push(nid);
        if (out.size >= softCap) break;
      }
      if (out.size >= softCap) break;
    }
    frontier = next;
    if (!frontier.length) break;
  }

  const ranked = [...out].map((id) => {
    const deg = Number(adj.get(id)?.size || 0);
    const n = byId.get(id);
    const blobLen = String(/** @type {{ blob?: string }} */ (n)?.blob ?? "").trim().length;
    const labelLen = String(/** @type {{ label?: string }} */ (n)?.label ?? "").trim().length;
    const leaf = deg <= 1 ? 1 : 0;
    const shortBlob = blobLen <= 40 ? 1 : 0;
    const seedPrio = seeds.includes(id) ? 1 : 0;
    return { id, seedPrio, leaf, shortBlob, labelLen, blobLen };
  });
  ranked.sort((a, b) => {
    if (b.seedPrio !== a.seedPrio) return b.seedPrio - a.seedPrio;
    if (b.leaf !== a.leaf) return b.leaf - a.leaf;
    if (b.shortBlob !== a.shortBlob) return b.shortBlob - a.shortBlob;
    if (b.labelLen !== a.labelLen) return b.labelLen - a.labelLen;
    if (b.blobLen !== a.blobLen) return b.blobLen - a.blobLen;
    return a.id.localeCompare(b.id, undefined, { sensitivity: "base" });
  });
  return ranked.map((x) => x.id).slice(0, cap);
}

/**
 * Deterministic fallback when router LLM is unavailable or returns no ids.
 * Guarantees some Memory graph evidence reaches the main model.
 * @param {Map<string, unknown>} byId
 * @param {Array<{ id: string, category: string, label: string, blobHay: string }>} rows
 * @param {unknown[]} links
 * @param {string} userQuery
 */
function buildDeterministicSupplement(byId, rows, links, userQuery) {
  const tokens = [
    ...new Set([
      ...queryTokens(userQuery),
      ...tokenWords(userQuery),
    ]),
  ].filter(Boolean);
  const entitySignals = extractEntitySignals(userQuery);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const adj = buildAdjacency(links);
  const scored = rows
    .map((r) => {
      const hay = `${r.category} ${r.label} ${r.blobHay}`;
      let lexical = 0;
      for (const t of tokens) {
        if (!t) continue;
        if (normText(hay).includes(normText(t))) lexical += t.length >= 6 ? 2 : 1;
      }
      let entity = 0;
      for (const sig of entitySignals) {
        if (sig && hay.includes(sig)) entity += 3;
      }
      return { id: r.id, score: lexical + entity };
    })
    .sort((a, b) => b.score - a.score);

  /** @type {string[]} */
  let ids = scored.filter((x) => x.score > 0).map((x) => x.id).slice(0, MAX_IDS);

  // Expand via 1-hop to catch list nodes connected to matched project/title nodes.
  if (ids.length > 0) {
    const exp = new Set(ids);
    for (const id of ids) {
      const ns = adj.get(id);
      if (!ns) continue;
      for (const nId of ns) {
        if (exp.size >= MAX_IDS * 2) break;
        exp.add(nId);
      }
    }
    ids = [...exp]
      .filter((id) => byId.has(id))
      .sort((a, b) => {
        const sa = Number(scored.find((x) => x.id === a)?.score || 0);
        const sb = Number(scored.find((x) => x.id === b)?.score || 0);
        if (sb !== sa) return sb - sa;
        return String(rowById.get(b)?.blobHay ?? "").length - String(rowById.get(a)?.blobHay ?? "").length;
      })
      .slice(0, MAX_IDS);
  }

  // If no lexical/entity matches at all, include richest notes so model still sees real stored facts.
  if (ids.length === 0) {
    ids = [...rows]
      .sort((a, b) => String(b.blobHay ?? "").length - String(a.blobHay ?? "").length)
      .map((r) => r.id)
      .filter((id) => byId.has(id))
      .slice(0, MAX_IDS);
  }

  const oneHop = [...new Set(expandOneGraphHop(ids, byId, links))];
  ids = fullyExpandHubNeighbors(oneHop, byId, links);
  if (ids.length > 96) {
    ids = capExpandedWithAnchors(ids, oneHop, byId, links, 96);
  }

  return buildSupplementFromNodes(
    byId,
    ids,
    "deterministic fallback: memory-graph lexical/entity + neighbor expansion.",
  );
}

/**
 * Deterministic Memory graph supplement (no LLM). Used when the router fails or returns nothing.
 * @param {{ nodes?: unknown[], links?: unknown[] }} graph
 * @param {string} userQuery
 * @returns {string}
 */
export function buildMemoryTreeDeterministicSupplement(graph, userQuery) {
  const g = graph && typeof graph === "object" ? graph : { nodes: [], links: [] };
  const rawNodes = Array.isArray(g.nodes) ? g.nodes : [];
  const links = Array.isArray(g.links) ? g.links : [];
  const q = String(userQuery ?? "").trim();
  if (!q || rawNodes.length === 0) return "";

  /** @type {Map<string, unknown>} */
  const byId = new Map();
  /** @type {Array<{ id: string, category: string, label: string, blobHay: string }>} */
  const rows = [];
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(/** @type {{ id?: string }} */ (raw).id ?? "").trim();
    if (!id) continue;
    const category = String(/** @type {{ category?: string }} */ (raw).category ?? "").trim();
    const label = String(/** @type {{ label?: string }} */ (raw).label ?? "").trim();
    const blob = String(/** @type {{ blob?: string }} */ (raw).blob ?? "").trim();
    if (!label) continue;
    byId.set(id, raw);
    rows.push({
      id,
      category,
      label,
      blobHay: blob.slice(0, LEX_RETRIEVE_HAY),
    });
  }
  if (rows.length === 0) return "";
  return buildDeterministicSupplement(byId, rows, links, q);
}

/**
 * @param {{
 *   userQuery: string,
 *   graph: { nodes?: unknown[], links?: unknown[] },
 *   allKeys: Record<string, string>,
 *   analysisPriority?: string[],
 *   activeProviderId: string,
 *   activeApiKey: string,
 * }} args
 * @returns {Promise<string>} Plain supplement body (no outer markers), or "" if nothing to add.
 */
export async function fetchMemoryTreeSupplementForPrompt(args) {
  const userQuery = String(args.userQuery ?? "").trim();
  const graph = args.graph && typeof args.graph === "object" ? args.graph : { nodes: [], links: [] };
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const links = Array.isArray(graph.links) ? graph.links : [];
  if (!userQuery || rawNodes.length === 0) return "";

  const { providerId, key } = pickRouterKey(
    args.allKeys ?? {},
    args.analysisPriority,
    args.activeProviderId,
    args.activeApiKey,
  );

  /** @type {Map<string, unknown>} */
  const byId = new Map();
  /** @type {Array<{ id: string, category: string, label: string, blobHay: string }>} */
  const rows = [];
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(/** @type {{ id?: string }} */ (raw).id ?? "").trim();
    if (!id) continue;
    const category = String(/** @type {{ category?: string }} */ (raw).category ?? "").trim();
    const label = String(/** @type {{ label?: string }} */ (raw).label ?? "").trim();
    const blob = String(/** @type {{ blob?: string }} */ (raw).blob ?? "").trim();
    if (!label) continue;
    byId.set(id, raw);
    rows.push({
      id,
      category,
      label,
      blobHay: blob.slice(0, LEX_RETRIEVE_HAY),
    });
  }
  if (rows.length === 0) return "";
  if (!providerId || !key) {
    const det0 = buildDeterministicSupplement(byId, rows, links, userQuery);
    if (rows.length <= GRAPH_APPEND_TITLE_INDEX_MAX_NODES) {
      const idx0 = buildAllNodeTitleIndex(rows, 14_000);
      return [det0, idx0].filter(Boolean).join("\n\n").trim();
    }
    return det0;
  }

  const subqueries = [userQuery];
  const queryTerms = expandWithSynonyms(
    [
      ...new Set([
        ...subqueries.flatMap((q) => tokenWords(q)),
        ...queryTokens(userQuery),
      ]),
    ]
      .filter(Boolean)
      .slice(0, 120),
  );
  const entitySignals = [...new Set(subqueries.flatMap((q) => extractEntitySignals(q)))];
  const { lexicalTop, entityTop, scoreById } = retrieveLexicalAndEntity(rows, queryTerms, entitySignals);

  /** Small graphs: scan every node. Large graphs: lexical/entity seeds + 1-hop neighbors (Cyprus-style). */
  /** @type {Set<string>} */
  let expandedIds;
  if (rows.length <= GRAPH_FULL_NODES_FOR_RERANK) {
    expandedIds = new Set(rows.map((r) => r.id));
  } else {
    const adj = buildAdjacency(links);
    let seedIds = [...new Set([...lexicalTop.slice(0, 80), ...entityTop.slice(0, 40)])];
    if (seedIds.length === 0) {
      seedIds = rows.map((r) => r.id).slice(0, 120);
    }
    expandedIds = new Set(seedIds);
    for (const id of seedIds) {
      const neighbors = adj.get(id);
      if (!neighbors) continue;
      for (const nId of neighbors) {
        if (expandedIds.size >= EXPAND_ID_CAP) break;
        expandedIds.add(nId);
      }
    }
  }

  // Phase 1 (global): ensure title-level coverage across all nodes via chunked scans.
  let titleScan = { ids: [], rationale: "", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  try {
    titleScan = await selectCandidateIdsByTitleChunks(
      providerId,
      key,
      userQuery,
      rows.map((r) => ({ id: r.id, category: r.category, label: r.label })),
    );
  } catch {
    /* fall through to deterministic behavior below if rerank also fails */
  }
  for (const id of titleScan.ids) expandedIds.add(id);

  /** @type {{ id: string, category: string, label: string, blobExcerpt: string, lexicalScore: number }[]} */
  let poolFull = [...expandedIds]
    .map((id) => {
      const n = byId.get(id);
      if (!n || typeof n !== "object") return null;
      const blobFull = String(/** @type {{ blob?: string }} */ (n).blob ?? "").trim();
      return {
        id,
        category: String(/** @type {{ category?: string }} */ (n).category ?? "").trim().slice(0, 120),
        label: String(/** @type {{ label?: string }} */ (n).label ?? "").trim().slice(0, 220),
        blobExcerpt: blobFull.slice(0, BLOB_EXCERPT_RERANK),
        lexicalScore: Number(scoreById.get(id) || 0),
      };
    })
    .filter(Boolean);

  poolFull.sort((a, b) => {
    const dLex = Number(b.lexicalScore) - Number(a.lexicalScore);
    if (dLex !== 0) return dLex;
    const dBlob = String(b.blobExcerpt ?? "").length - String(a.blobExcerpt ?? "").length;
    if (dBlob !== 0) return dBlob;
    return `${a.category}/${a.label}`.localeCompare(`${b.category}/${b.label}`, undefined, { sensitivity: "base" });
  });

  const rerankPool = poolFull.slice(0, RERANK_POOL_START);

  const poolForJson = trimRerankPoolByJsonSize(rerankPool, userQuery, 26_000);
  const userBlock =
    `USER_QUESTION:\n${userQuery.slice(0, 8000)}\n\nCANDIDATES_JSON:\n` + JSON.stringify(poolForJson);

  let rawText = "";
  let usage = null;
  try {
    const out = await runRouterLlm(
      providerId,
      key,
      MEMORY_TREE_RERANK_SYSTEM,
      userBlock,
      RERANK_MAX_OUT,
    );
    rawText = out.text;
    usage = out.usage;
  } catch {
    const det = buildDeterministicSupplement(byId, rows, links, userQuery);
    if (det.trim()) return det;
    throw new Error("Memory tree router failed and deterministic fallback was empty.");
  }
  const parsed = parseRouteIdsJson(String(rawText ?? ""));
  let validIds = parsed.ids.filter((id) => poolForJson.some((x) => x.id === id)).slice(0, 32);
  /** Title-scan ids can be cut from JSON-trimmed rerank pool; still merge them — they are title-level picks. */
  const titlePick = titleScan.ids.filter((id) => byId.has(id));
  /** Keep a wider seed set before graph hop/hub expansion (avoids dropping a sibling leaf early). */
  validIds = [...new Set([...validIds, ...titlePick])].slice(0, 48);
  let rationale = [titleScan.rationale, parsed.rationale].filter(Boolean).join(" | ");

  if (validIds.length === 0) {
    const fromLex = [...new Set([...lexicalTop.slice(0, 10), ...entityTop.slice(0, 6)])]
      .map((id) => {
        const n = byId.get(id);
        if (!n) return null;
        return String(/** @type {{ id?: string }} */ (n).id ?? "").trim();
      })
      .filter(Boolean)
      .slice(0, MAX_IDS);
    if (fromLex.length > 0) {
      validIds = fromLex;
      rationale = rationale || "fallback: top lexical / entity matches (rerank returned no ids).";
    } else if (poolForJson.length > 0) {
      validIds = [...poolForJson]
        .sort((a, b) => {
          const db = String(b.blobExcerpt ?? "").length - String(a.blobExcerpt ?? "").length;
          if (db !== 0) return db;
          const dl = String(b.label ?? "").length - String(a.label ?? "").length;
          if (dl !== 0) return dl;
          return String(a.id).localeCompare(String(b.id), undefined, { sensitivity: "base" });
        })
        .slice(0, 48)
        .map((x) => x.id)
        .filter(Boolean);
      rationale = rationale || "fallback: rerank returned no ids; using ranked candidate pool (includes empty-note nodes).";
    }
  }

  validIds = validIds.filter((id) => byId.has(id));
  if (validIds.length === 0) {
    const det = buildDeterministicSupplement(byId, rows, links, userQuery);
    if (det.trim()) return det;
    return "";
  }
  const oneHopValid = [...new Set(expandOneGraphHop(validIds, byId, links))];
  validIds = fullyExpandHubNeighbors(oneHopValid, byId, links);
  if (validIds.length > 96) {
    validIds = capExpandedWithAnchors(validIds, oneHopValid, byId, links, 96);
  }

  let supplement = buildSupplementFromNodes(byId, validIds, rationale);
  const det = buildDeterministicSupplement(byId, rows, links, userQuery);
  if (!supplement.trim() && det.trim()) {
    supplement = det;
  } else if (det.trim() && supplement.trim() && supplement.length < 2200 && det.length > supplement.length * 1.2) {
    supplement = det;
  }

  const usageSafe = withUsageFallback(
    usage,
    `${MEMORY_TREE_RERANK_SYSTEM}\n\n${userBlock}`,
    rawText,
  );
  void recordAuxLlmUsage({
    provider_id: providerId,
    request_kind: "memory_tree_router",
    llm_prompt_tokens: usageSafe.promptTokens + Number(titleScan.usage?.promptTokens || 0),
    llm_completion_tokens: usageSafe.completionTokens + Number(titleScan.usage?.completionTokens || 0),
    llm_total_tokens: usageSafe.totalTokens + Number(titleScan.usage?.totalTokens || 0),
  }).catch(() => {});

  if (rows.length <= GRAPH_APPEND_TITLE_INDEX_MAX_NODES) {
    const idx = buildAllNodeTitleIndex(rows, 14_000);
    supplement = [supplement, idx].filter(Boolean).join("\n\n").trim();
  }
  return supplement;
}
