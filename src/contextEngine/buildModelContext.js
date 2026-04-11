/**
 * Сборка слоёв контекста для одного запроса в тред (threadId = dialog id в БД).
 */

import { retrieveRelevantChunksFallback } from "./retrievalFallback.js";
import { estimateTokens } from "./tokenEstimate.js";

const PRI_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * @param {import("./types.js").ContextPackRule[]} rules
 */
function pickSystemCore(rules) {
  const core = rules.filter((r) => r.rule_type === "core" && r.is_active);
  core.sort((a, b) => PRI_ORDER[a.priority] ?? 9 - (PRI_ORDER[b.priority] ?? 9));
  const fromDb = core.map((r) => String(r.content ?? "").trim()).find(Boolean);
  if (fromDb) return fromDb;
  return "You are a helpful assistant. Be concise and accurate.";
}

/**
 * @param {import("./types.js").ContextPackRule[]} rules
 */
function buildRulesDigest(rules) {
  const active = rules.filter((r) => r.is_active && r.rule_type !== "core");
  active.sort((a, b) => {
    const pa = PRI_ORDER[a.priority] ?? 9;
    const pb = PRI_ORDER[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return String(a.title ?? "").localeCompare(String(b.title ?? ""));
  });
  const lines = [];
  for (const r of active) {
    const line = `- [${r.rule_type}/${r.priority}] ${r.title}: ${String(r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 220)}`;
    lines.push(line);
    if (lines.length >= 24) break;
  }
  return lines.join("\n");
}

/**
 * @param {import("./types.js").ContextPackMemory[]} memoryItems
 * @param {string} threadId
 */
function buildMemoryLayers(memoryItems, threadId) {
  const tid = String(threadId ?? "").trim();
  const globalHigh = memoryItems.filter(
    (m) => m.scope === "global" && (m.priority === "critical" || m.priority === "high"),
  );
  const project = memoryItems.filter((m) => m.scope === "project");
  const threadScoped = memoryItems.filter((m) => m.scope === "thread" && m.thread_id === tid);
  const decisions = memoryItems.filter(
    (m) =>
      m.thread_id === tid &&
      (m.memory_type === "decision" || m.memory_type === "state" || m.memory_type === "constraint"),
  );

  const pick = [...globalHigh, ...project, ...threadScoped, ...decisions];
  const seen = new Set();
  const out = [];
  for (const m of pick) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  out.sort((a, b) => (PRI_ORDER[a.priority] ?? 9) - (PRI_ORDER[b.priority] ?? 9));
  return out.slice(0, 40);
}

/**
 * Нормализуем историю в плоские сообщения (user/assistant).
 * @param {import("./types.js").ContextPack} pack
 */
/**
 * @param {string} base
 * @param {string|null|undefined} attachmentsJson
 */
function userTurnContentForModel(base, attachmentsJson) {
  const b = String(base ?? "").trim();
  let names = [];
  try {
    const j = JSON.parse(String(attachmentsJson ?? "null"));
    if (Array.isArray(j)) {
      names = j.map((x) => (x && x.name ? String(x.name) : "")).filter(Boolean);
    }
  } catch {
    /* ignore */
  }
  if (names.length === 0) return b;
  const hint = `[Attached: ${names.join(", ")}]`;
  return b ? `${b}\n\n${hint}` : hint;
}

function flattenHistoryMessages(pack) {
  /** @type {Array<{ id: string, role: string, content: string, created_at: string }>} */
  const fromMirror = (pack.threadMessages ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    created_at: m.created_at,
  }));

  if (fromMirror.length > 0) {
    return fromMirror;
  }

  /** @type {typeof fromMirror} */
  const out = [];
  for (const t of pack.turns ?? []) {
    out.push({
      id: `${t.id}:u`,
      role: "user",
      content: userTurnContentForModel(t.user_text, t.user_attachments_json),
      created_at: t.user_message_at,
    });
    if (t.assistant_text != null && String(t.assistant_text).trim()) {
      out.push({
        id: `${t.id}:a`,
        role: "assistant",
        content: String(t.assistant_text),
        created_at: t.user_message_at,
      });
    }
  }
  return out;
}

/**
 * @param {import("./types.js").BuildModelContextInput} input
 * @returns {import("./types.js").BuiltModelContext}
 */
export function buildModelContext(input) {
  const { threadId, userPrompt, contextPack, modelFlags } = input;
  const pack = contextPack;
  const rules = pack.rules ?? [];

  const systemCore = pickSystemCore(rules);
  const activeRulesDigest = buildRulesDigest(rules);
  const memoryLayer = buildMemoryLayers(pack.memoryItems ?? [], threadId);

  const relevantMemoryBlock = memoryLayer
    .map(
      (m) =>
        `[${m.scope}/${m.memory_type}/${m.priority}] ${m.title}: ${String(m.content ?? "").trim().slice(0, 500)}`,
    )
    .join("\n");

  const flat = flattenHistoryMessages(pack);
  const recentN = Number(modelFlags?.recentMessageCount);
  const recentCount = Number.isFinite(recentN) && recentN > 0 ? Math.min(24, Math.max(6, recentN)) : 10;
  const recentSlice = flat.slice(-recentCount);
  const olderForRetrieval = flat.slice(0, Math.max(0, flat.length - recentSlice.length));

  const retrievedChunks = retrieveRelevantChunksFallback(
    pack.userQuery || userPrompt,
    pack.dialogTitle ?? "",
    pack.themeTitle ?? "",
    pack.summaries ?? [],
    pack.memoryItems ?? [],
    olderForRetrieval,
  );

  /** @type {import("./types.js").ModelMessage[]} */
  const recentMessages = [];
  for (const m of recentSlice) {
    const role = m.role === "assistant" ? "assistant" : "user";
    recentMessages.push({ role, content: m.content });
  }

  const retrievedText = retrievedChunks.map((c) => `[${c.source}] ${c.text}`).join("\n\n---\n\n");

  /** @type {import("./types.js").ModelMessage[]} */
  const historyBeforeUser = [];

  if (retrievedText.trim()) {
    historyBeforeUser.push({
      role: "user",
      content: "Context excerpts (older thread / memory retrieval; may overlap with recent messages):\n\n" + retrievedText,
    });
  }

  for (const rm of recentMessages) {
    historyBeforeUser.push(rm);
  }

  const finalUserContent = String(userPrompt ?? "").trim();
  const finalMessagesForModel = [...historyBeforeUser, { role: "user", content: finalUserContent }];

  const globalConstraints = memoryLayer
    .filter((m) => m.priority === "critical" && (m.memory_type === "constraint" || m.scope === "global"))
    .map((m) => `- ${m.title}: ${m.content.slice(0, 200)}`)
    .join("\n");

  const combinedSystemInstruction = [
    "=== CORE ===",
    systemCore,
    "=== ACTIVE RULES (digest) ===",
    activeRulesDigest || "(none)",
    "=== MEMORY (compact) ===",
    relevantMemoryBlock || "(none)",
    globalConstraints ? "=== CRITICAL CONSTRAINTS ===\n" + globalConstraints : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const debug = {
    modelFlags: modelFlags ?? {},
    layerTokens: {
      systemCore: estimateTokens(systemCore),
      rulesDigest: estimateTokens(activeRulesDigest),
      memory: estimateTokens(relevantMemoryBlock),
      retrieved: estimateTokens(retrievedText),
      recent: recentMessages.reduce((a, m) => a + estimateTokens(m.content), 0),
      finalUser: estimateTokens(finalUserContent),
    },
    counts: {
      rulesActive: rules.filter((r) => r.is_active).length,
      memoryPicked: memoryLayer.length,
      retrievedChunks: retrievedChunks.length,
      recentMessages: recentMessages.length,
      historyTotal: flat.length,
    },
    rulesIncluded: rules.filter((r) => r.is_active).map((r) => ({ id: r.id, type: r.rule_type, priority: r.priority })),
    retrievedIds: retrievedChunks.map((c) => c.id),
  };

  return {
    systemCore,
    activeRulesDigest,
    relevantMemoryBlock,
    retrievedChunks,
    recentMessages,
    finalMessagesForModel,
    combinedSystemInstruction,
    debug,
  };
}
