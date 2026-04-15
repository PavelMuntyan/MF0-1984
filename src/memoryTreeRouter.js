/**
 * Pre-turn “router” model: reads the Memory tree and selects excerpts useful for the user’s next message.
 * Injected into the main chat as a marked supplement (alongside existing RAG).
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

const MEMORY_TREE_ROUTER_SYSTEM =
  "You are the **Memory tree router** for app MF0. You receive a compact **skeleton dump** of the user’s saved Memory graph: nodes (id, category, label) and edges (relations between node ids).\n" +
  "You also receive the user’s **next message** (what they are about to ask the main assistant).\n\n" +
  "**Task:** Pick only subgraphs that could help the main assistant answer **in a personalized way** (who they are, stable preferences, family/work names they stored, constraints, ongoing projects, interests they track). Use node titles and edges only.\n\n" +
  "**Rules:**\n" +
  "- Do **not** invent facts. If nothing in the tree plausibly helps this specific message, reply with exactly the single word: NONE\n" +
  "- Prefer structured sections, e.g. `## Category / Label` then bullets with node IDs and relation hints.\n" +
  "- Ignore graph noise unrelated to the next message.\n" +
  "- Stay concise (target <= 250 words).\n" +
  "- Output **plain text only** (no JSON, no markdown code fences).";

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

/**
 * @param {string} q
 */
function queryTokens(q) {
  const s = String(q ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ");
  const parts = s.split(/\s+/).filter((w) => w.length > 1);
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
 * Serialize graph for the router in compact skeleton form.
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
 * @param {string} treeDump
 * @param {string} userQuery
 * @returns {Promise<{ text: string, usage: { promptTokens: number, completionTokens: number, totalTokens: number } | null }>}
 */
async function runRouterModel(providerId, key, treeDump, userQuery) {
  const userBlock =
    `USER_NEXT_MESSAGE:\n${String(userQuery ?? "").trim().slice(0, 8000)}\n\n--- MEMORY_TREE_DUMP ---\n` +
    String(treeDump ?? "").slice(0, 30000);

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
          temperature: 0.15,
          max_completion_tokens: 900,
          messages: [
            { role: "system", content: MEMORY_TREE_ROUTER_SYSTEM },
            { role: "user", content: userBlock },
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
        max_tokens: 900,
        system: MEMORY_TREE_ROUTER_SYSTEM,
        messages: [{ role: "user", content: userBlock }],
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
              parts: [{ text: `${MEMORY_TREE_ROUTER_SYSTEM}\n\n${userBlock}` }],
            },
          ],
          generationConfig: {
            temperature: 0.15,
            maxOutputTokens: 900,
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
          temperature: 0.15,
          max_tokens: 900,
          disable_search: true,
          messages: [
            { role: "system", content: MEMORY_TREE_ROUTER_SYSTEM },
            { role: "user", content: userBlock },
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
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  if (!userQuery || nodes.length === 0) return "";

  const { providerId, key } = pickRouterKey(
    args.allKeys ?? {},
    args.analysisPriority,
    args.activeProviderId,
    args.activeApiKey,
  );
  if (!providerId || !key) return "";

  const treeDump = serializeMemoryGraphForRouter(graph, userQuery);
  if (!treeDump.trim()) return "";

  const { text: rawText, usage } = await runRouterModel(providerId, key, treeDump, userQuery);
  if (usage) {
    void recordAuxLlmUsage({
      provider_id: providerId,
      request_kind: "memory_tree_router",
      llm_prompt_tokens: usage.promptTokens,
      llm_completion_tokens: usage.completionTokens,
      llm_total_tokens: usage.totalTokens,
    }).catch(() => {});
  }
  const out = String(rawText ?? "").trim();
  if (!out || /^NONE\.?$/i.test(out) || /^\(none\)$/i.test(out)) return "";
  return out;
}
