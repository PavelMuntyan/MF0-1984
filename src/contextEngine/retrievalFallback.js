/**
 * Fallback without embeddings: simple token overlap score + type priority.
 * @import { RetrievedChunk } from "./types.js"
 */

const STOP = new Set(
  "the a an to of in for on with and or is are was were be been being it this that these those at by from as if not"
    .split(" "),
);

function tokens(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function scoreText(hay, needleTokens) {
  const h = String(hay ?? "").toLowerCase();
  if (!h || needleTokens.length === 0) return 0;
  let sc = 0;
  for (const t of needleTokens) {
    if (h.includes(t)) sc += 2 + Math.min(t.length, 8) * 0.1;
  }
  return sc;
}

/**
 * @param {string} query
 * @param {string} threadTitle
 * @param {string} themeTitle
 * @param {import("./types.js").ContextPackSummary[]} summaries
 * @param {import("./types.js").ContextPackMemory[]} memoryItems
 * @param {Array<{ id: string, role: string, content: string, created_at?: string }>} olderMessages
 * @returns {RetrievedChunk[]}
 */
export function retrieveRelevantChunksFallback(
  query,
  threadTitle,
  themeTitle,
  summaries,
  memoryItems,
  olderMessages,
) {
  const qTokens = tokens(query);
  const titleTokens = [...tokens(threadTitle), ...tokens(themeTitle)];
  const needle = [...new Set([...qTokens, ...titleTokens])];

  /** @type {{ id: string, source: string, text: string, score: number }[]} */
  const scored = [];

  for (const s of summaries) {
    const text = String(s.summary_text ?? "").trim();
    if (!text) continue;
    let bonus = s.summary_type === "decision_log" ? 4 : s.summary_type === "rolling" ? 2 : 1;
    const sc = scoreText(text, needle) + bonus;
    if (sc > 0) {
      scored.push({
        id: `summary:${s.id}`,
        source: `summary:${s.summary_type}`,
        text: text.slice(0, 4000),
        score: sc,
      });
    }
  }

  for (const m of memoryItems) {
    const text = `${m.title}\n${m.content}`.trim();
    if (!text) continue;
    const typeBonus =
      m.memory_type === "decision" || m.memory_type === "constraint"
        ? 5
        : m.memory_type === "fact"
          ? 3
          : m.memory_type === "preference"
            ? 2
            : 1;
    const prBonus =
      m.priority === "critical" ? 6 : m.priority === "high" ? 3 : m.priority === "medium" ? 1 : 0;
    const sc = scoreText(text, needle) + typeBonus + prBonus;
    if (sc > 0) {
      scored.push({
        id: `memory:${m.id}`,
        source: `memory:${m.memory_type}`,
        text: text.slice(0, 2000),
        score: sc,
      });
    }
  }

  for (const msg of olderMessages) {
    const text = String(msg.content ?? "").trim();
    if (!text) continue;
    const sc = scoreText(text, needle) + (msg.role === "user" ? 0.5 : 0);
    if (sc > 1) {
      scored.push({
        id: `msg:${msg.id}`,
        source: `thread_message:${msg.role}`,
        text: text.slice(0, 2500),
        score: sc,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const out = [];
  for (const row of scored) {
    const key = row.text.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= 16) break;
  }
  return out;
}
