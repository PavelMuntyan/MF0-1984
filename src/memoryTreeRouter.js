/**
 * Pre-turn “router” model: reads the Memory tree and selects excerpts useful for the user’s next message.
 * Injected into the main chat as a marked supplement (alongside existing RAG).
 */

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
  "You are the **Memory tree router** for app MF0. You receive a **text dump** of the user’s saved Memory graph: nodes (id, category, label, text blob/notes) and edges (relations between node ids).\n" +
  "You also receive the user’s **next message** (what they are about to ask the main assistant).\n\n" +
  "**Task:** Pick only subgraphs and blob text that could help the main assistant answer **in a personalized way** (who they are, stable preferences, family/work names they stored, constraints, ongoing projects, interests they track). Copy or tightly paraphrase **only** material grounded in the dump.\n\n" +
  "**Rules:**\n" +
  "- Do **not** invent facts. If nothing in the tree plausibly helps this specific message, reply with exactly the single word: NONE\n" +
  "- Prefer structured sections, e.g. `## Category / Label` then bullets or short quoted excerpts from blobs.\n" +
  "- Ignore graph noise unrelated to the next message.\n" +
  "- Stay under ~6000 words; prefer dense excerpts over chatter.\n" +
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
    .replace(/[^a-z0-9а-яёії\s-]+/gi, " ");
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
 * Serialize graph for the router (size-capped). Full blobs may be truncated here; router still sees structure + substantial text.
 * @param {{ nodes?: unknown[], links?: unknown[] }} graph
 * @param {string} userQuery
 * @param {{ maxTotalChars?: number, blobPreviewPerNode?: number }} [opts]
 */
export function serializeMemoryGraphForRouter(graph, userQuery, opts = {}) {
  const maxTotal = opts.maxTotalChars ?? 92000;
  const blobCap = opts.blobPreviewPerNode ?? 4200;
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
    const blob = String(n.blob ?? "").trim();
    const blobNote =
      blob.length > blobCap ? `${blob.slice(0, blobCap)}\n… (${blob.length} chars total; truncated in router view)` : blob;
    idToLine.set(
      id,
      `NODE id=${id || "?"} | ${cat || "?"} / ${lab || "?"}\n${blobNote || "(empty blob)"}\n---`,
    );
  }

  /** @type {string[]} */
  const parts = [];
  parts.push("EDGES (source_node_id -> target_node_id : relation):");
  for (const e of links) {
    if (!e || typeof e !== "object") continue;
    parts.push(`${String(e.source ?? "").trim()} -> ${String(e.target ?? "").trim()} : ${String(e.label ?? "").trim()}`);
  }
  parts.push("\nNODES (most relevant first, then remainder):\n");

  let used = parts.join("\n").length;
  const seen = new Set();
  for (const { n } of scored) {
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
 * @param {string} activeProviderId
 * @param {string} activeApiKey
 */
function pickRouterKey(allKeys, activeProviderId, activeApiKey) {
  const o = String(allKeys?.openai ?? "").trim();
  if (o) return { providerId: "openai", key: o };
  const a = String(allKeys?.anthropic ?? "").trim();
  if (a) return { providerId: "anthropic", key: a };
  const g = String(allKeys?.["gemini-flash"] ?? "").trim();
  if (g) return { providerId: "gemini-flash", key: g };
  const p = String(allKeys?.perplexity ?? "").trim();
  if (p) return { providerId: "perplexity", key: p };
  const k = String(activeApiKey ?? "").trim();
  if (k) return { providerId: activeProviderId, key: k };
  return { providerId: "", key: "" };
}

/**
 * @param {string} providerId
 * @param {string} key
 * @param {string} treeDump
 * @param {string} userQuery
 */
async function runRouterModel(providerId, key, treeDump, userQuery) {
  const userBlock =
    `USER_NEXT_MESSAGE:\n${String(userQuery ?? "").trim().slice(0, 8000)}\n\n--- MEMORY_TREE_DUMP ---\n` +
    String(treeDump ?? "").slice(0, 95000);

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
          max_completion_tokens: 6000,
          messages: [
            { role: "system", content: MEMORY_TREE_ROUTER_SYSTEM },
            { role: "user", content: userBlock },
          ],
        }),
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      return typeof content === "string" ? content : String(content ?? "");
    }
    case "anthropic": {
      const body = {
        model: ROUTER_MODEL.anthropic,
        max_tokens: 6000,
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
      return blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n")
        .trim();
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
            maxOutputTokens: 6000,
          },
        }),
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      const cand = data.candidates?.[0]?.content?.parts;
      if (!Array.isArray(cand)) throw new Error("Empty Gemini router response");
      return cand
        .filter((p) => p && p.thought !== true && p.text)
        .map((p) => String(p.text))
        .join("\n")
        .trim();
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
          max_tokens: 6000,
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
      return typeof content === "string" ? content : String(content ?? "");
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

  const { providerId, key } = pickRouterKey(args.allKeys ?? {}, args.activeProviderId, args.activeApiKey);
  if (!providerId || !key) return "";

  const treeDump = serializeMemoryGraphForRouter(graph, userQuery);
  if (!treeDump.trim()) return "";

  const raw = await runRouterModel(providerId, key, treeDump, userQuery);
  const out = String(raw ?? "").trim();
  if (!out || /^NONE\.?$/i.test(out) || /^\(none\)$/i.test(out)) return "";
  return out;
}
