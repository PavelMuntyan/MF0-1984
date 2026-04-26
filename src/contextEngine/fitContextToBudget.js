/**
 * Fit assembled context into a token budget.
 * Shrink RAG retrieved block, then Memory tree supplement, then compact MEMORY in system; keep core/rules/recent and the final user intact.
 * Memory graph excerpts are placed immediately before the final user turn so the model treats them like grounded context for the latest question.
 */

import { estimateTokens } from "./tokenEstimate.js";
import { MF0_MEMORY_TREE_SUPPLEMENT_PREFIX } from "../memoryTreeRouter.js";

/**
 * @typedef {Object} BudgetFitResult
 * @property {import("./types.js").BuiltModelContext} context
 * @property {import("./types.js").ModelMessage[]} messagesForApi
 * @property {string} systemInstruction
 * @property {Object} debug
 */

/**
 * @param {import("./types.js").BuiltModelContext} built
 * @param {number} maxInputTokens
 * @returns {BudgetFitResult}
 */
export function fitContextToBudget(built, maxInputTokens) {
  const reserveAnswer = 2048;
  const maxInput = Math.max(4096, maxInputTokens);
  let budget = maxInput - reserveAnswer;

  const final = built.finalMessagesForModel.at(-1);
  if (!final || final.role !== "user") {
    throw new Error("fitContextToBudget: last message must be user");
  }

  const head = built.finalMessagesForModel.slice(0, -1);
  const retrievedIdx = head.findIndex(
    (m) => m.role === "user" && String(m.content ?? "").startsWith("Context excerpts"),
  );
  const memTreeIdx = head.findIndex(
    (m) => m.role === "user" && String(m.content ?? "").startsWith(MF0_MEMORY_TREE_SUPPLEMENT_PREFIX),
  );
  let retrievedMsg = retrievedIdx >= 0 ? { ...head[retrievedIdx] } : null;
  let memTreeMsg = memTreeIdx >= 0 ? { ...head[memTreeIdx] } : null;
  const recentMsgs = head.filter((_, i) => i !== retrievedIdx && i !== memTreeIdx);

  let retrievedTok = estimateTokens(retrievedMsg?.content ?? "");
  let memTreeTok = estimateTokens(memTreeMsg?.content ?? "");
  let memoryText = String(built.relevantMemoryBlock ?? "");
  let memTok = estimateTokens(memoryText);
  let accessText = String(built.accessCatalogBlock ?? "").trim();
  let accessTok = estimateTokens(accessText);
  let userAddrText = String(built.userAddressingProfile ?? "").trim();
  let userAddrTok = estimateTokens(userAddrText);

  const coreTok = estimateTokens(built.systemCore);
  const rulesTok = estimateTokens(built.activeRulesDigest);
  const recentTok = recentMsgs.reduce((a, m) => a + estimateTokens(m.content), 0);
  const finalTok = estimateTokens(final.content);

  const fixed = coreTok + userAddrTok + rulesTok + recentTok + finalTok + 200;
  let remaining = budget - fixed - memTok - retrievedTok - accessTok - memTreeTok;

  const dropped = [];

  while (remaining < 0 && retrievedTok > 100 && retrievedMsg) {
    const c = retrievedMsg.content;
    const newLen = Math.max(120, Math.floor(c.length * 0.65));
    retrievedMsg = { ...retrievedMsg, content: c.slice(0, newLen) + (newLen < c.length ? "\n…" : "") };
    const newTok = estimateTokens(retrievedMsg.content);
    remaining += retrievedTok - newTok;
    retrievedTok = newTok;
    dropped.push("retrieved_shrink");
  }

  while (remaining < 0 && memTreeTok > 200 && memTreeMsg) {
    const c = memTreeMsg.content;
    const newLen = Math.max(2800, Math.floor(c.length * 0.72));
    memTreeMsg = { ...memTreeMsg, content: c.slice(0, newLen) + (newLen < c.length ? "\n…" : "") };
    const newTok = estimateTokens(memTreeMsg.content);
    remaining += memTreeTok - newTok;
    memTreeTok = newTok;
    dropped.push("memory_tree_supplement_shrink");
  }

  while (remaining < 0 && memTok > 80) {
    memoryText = memoryText.slice(0, Math.max(0, Math.floor(memoryText.length * 0.6)));
    const newTok = estimateTokens(memoryText);
    remaining += memTok - newTok;
    memTok = newTok;
    dropped.push("memory_shrink");
  }

  while (remaining < 0 && accessTok > 40) {
    accessText = accessText.slice(0, Math.max(0, Math.floor(accessText.length * 0.55)));
    const newTok = estimateTokens(accessText);
    remaining += accessTok - newTok;
    accessTok = newTok;
    dropped.push("access_catalog_shrink");
  }

  while (remaining < 0 && userAddrTok > 80 && userAddrText.length > 120) {
    const prevLen = userAddrText.length;
    const newLen = Math.max(120, Math.floor(prevLen * 0.62));
    userAddrText = userAddrText.slice(0, newLen) + (newLen < prevLen ? "\n…" : "");
    const newTok = estimateTokens(userAddrText);
    remaining += userAddrTok - newTok;
    userAddrTok = newTok;
    dropped.push("user_profile_shrink");
  }

  const memTreeForApi =
    memTreeMsg && String(memTreeMsg.content ?? "").trim().length > 80 ? memTreeMsg : null;

  const memoryBehaviorDirective = [
    "=== MEMORY GRAPH BEHAVIOR ===",
    "Memory graph retrieval is automatic for each user message.",
    "Never instruct the user to write a special memory-tree query, to paste a list, or to provide the same facts again just so you can answer.",
    "If retrieved memory data is present, use it as a high-priority grounding source.",
    "If retrieved memory data is absent or insufficient, continue with a normal best-effort assistant answer using general model knowledge.",
    "When memory data and general knowledge conflict, prefer the retrieved memory data for personal/project-specific facts.",
  ].join("\n");

  const memoryTreeDirective = memTreeForApi
    ? [
        "=== MEMORY GRAPH (retrieved for this turn) ===",
        "A user-role message in this request begins with the marker MF0_MEMORY_TREE_SUPPLEMENT. That block was filled automatically from the user's personal Memory graph for the latest user question.",
        "Read it before you answer.",
        "When it contains the facts the user needs (lists, titles, names, dates, constraints, preferences), ground your reply in that text.",
        "Do not say you lack context, cannot see the graph, or cannot produce a list when that block already includes the requested facts.",
        "Never tell the user they must phrase a special query to the memory tree; retrieval is automatic on every message.",
        "If this block is empty or does not contain enough detail, continue with a normal best-effort answer instead of refusing.",
      ].join("\n")
    : "";

  const memoryFallbackOverrideDirective = [
    "=== MEMORY FALLBACK OVERRIDE ===",
    "This instruction has priority over conflicting lower-level habits.",
    "If Memory graph excerpts are missing or insufficient, you MUST still answer as a normal assistant using general model knowledge.",
    "Do not refuse with messages like 'I cannot list' or 'send/provide the list so I can store it'.",
    "You may briefly note that personal Memory graph lacks detail, but continue with a useful answer in the same response.",
  ].join("\n");

  const systemInstruction = [
    "=== CORE ===",
    built.systemCore,
    userAddrText.trim()
      ? "=== USER PROFILE & ADDRESSING (Memory tree: People → User) ===\n" + userAddrText.trim()
      : "",
    "=== RULES DIGEST ===",
    built.activeRulesDigest || "(none)",
    accessText.trim() ? "=== ACCESS CATALOG (metadata only; no API keys) ===\n" + accessText : "",
    memoryText.trim() ? "=== MEMORY ===\n" + memoryText.trim() : "",
    memoryBehaviorDirective,
    memoryTreeDirective,
    memoryFallbackOverrideDirective,
  ]
    .filter(Boolean)
    .join("\n\n");

  /** @type {import("./types.js").ModelMessage[]} */
  const messagesForApi = [];
  if (retrievedMsg && String(retrievedMsg.content ?? "").trim().length > 60) {
    messagesForApi.push(retrievedMsg);
  }
  messagesForApi.push(...recentMsgs);
  if (memTreeForApi) {
    messagesForApi.push(memTreeForApi);
  }
  messagesForApi.push(final);

  const debug = {
    ...built.debug,
    budget: {
      maxInputTokens: maxInput,
      reserveAnswer,
      estimatedSystemTokens: estimateTokens(systemInstruction),
      estimatedMessageTokens: messagesForApi.reduce((a, m) => a + estimateTokens(m.content), 0),
      remainingAfterFit: remaining,
      dropped,
    },
  };

  return {
    context: {
      ...built,
      userAddressingProfile: userAddrText.trim(),
      relevantMemoryBlock: memoryText,
      accessCatalogBlock: accessText,
      combinedSystemInstruction: systemInstruction,
    },
    messagesForApi,
    systemInstruction,
    debug,
  };
}
