/**
 * Fit assembled context into a token budget.
 * Shrink retrieved block first, then memory text in system; keep core/rules/recent and the final user intact.
 */

import { estimateTokens } from "./tokenEstimate.js";

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
  const ctxIndex = head.findIndex(
    (m) => m.role === "user" && String(m.content ?? "").startsWith("Context excerpts"),
  );
  let retrievedMsg = ctxIndex >= 0 ? { ...head[ctxIndex] } : null;
  const recentMsgs = head.filter((_, i) => i !== ctxIndex);

  let retrievedTok = estimateTokens(retrievedMsg?.content ?? "");
  let memoryText = String(built.relevantMemoryBlock ?? "");
  let memTok = estimateTokens(memoryText);
  let accessText = String(built.accessCatalogBlock ?? "").trim();
  let accessTok = estimateTokens(accessText);

  const coreTok = estimateTokens(built.systemCore);
  const rulesTok = estimateTokens(built.activeRulesDigest);
  const recentTok = recentMsgs.reduce((a, m) => a + estimateTokens(m.content), 0);
  const finalTok = estimateTokens(final.content);

  const fixed = coreTok + rulesTok + recentTok + finalTok + 200;
  let remaining = budget - fixed - memTok - retrievedTok - accessTok;

  const dropped = [];

  while (remaining < 0 && retrievedTok > 100) {
    const c = retrievedMsg.content;
    const newLen = Math.max(120, Math.floor(c.length * 0.65));
    retrievedMsg = { ...retrievedMsg, content: c.slice(0, newLen) + (newLen < c.length ? "\n…" : "") };
    const newTok = estimateTokens(retrievedMsg.content);
    remaining += retrievedTok - newTok;
    retrievedTok = newTok;
    dropped.push("retrieved_shrink");
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

  const systemInstruction = [
    "=== CORE ===",
    built.systemCore,
    "=== RULES DIGEST ===",
    built.activeRulesDigest || "(none)",
    accessText.trim() ? "=== ACCESS CATALOG (metadata only; no API keys) ===\n" + accessText : "",
    memoryText.trim() ? "=== MEMORY ===\n" + memoryText.trim() : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  /** @type {import("./types.js").ModelMessage[]} */
  const messagesForApi = [];
  if (retrievedMsg && String(retrievedMsg.content ?? "").trim().length > 60) {
    messagesForApi.push(retrievedMsg);
  }
  messagesForApi.push(...recentMsgs);
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
      relevantMemoryBlock: memoryText,
      accessCatalogBlock: accessText,
      combinedSystemInstruction: systemInstruction,
    },
    messagesForApi,
    systemInstruction,
    debug,
  };
}
