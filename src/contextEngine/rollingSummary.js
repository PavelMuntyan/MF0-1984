/**
 * Incremental rolling summary and decision_log updates (no full thread recompute).
 */

/**
 * @param {string|null|undefined} previous
 * @param {string} userLine
 * @param {string} assistantLine
 * @param {number} [maxChars]
 */
export function mergeRollingSummary(previous, userLine, assistantLine, maxChars = 6000) {
  const u = String(userLine ?? "").replace(/\s+/g, " ").trim().slice(0, 1200);
  const a = String(assistantLine ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
  const chunk = `User: ${u}\nAssistant: ${a}\n`;
  const base = String(previous ?? "").trim();
  const merged = base ? `${base}\n\n${chunk}` : chunk;
  if (merged.length <= maxChars) return merged;
  return merged.slice(-maxChars);
}

/**
 * @param {string|null|undefined} previous
 * @param {string} userLine
 * @param {string} assistantLine
 * @param {number} [maxChars]
 */
export function appendDecisionLogLine(previous, userLine, assistantLine, maxChars = 4000) {
  const decisionCue =
    /(we decided|\u0440\u0435\u0448\u0438\u043b\u0438|decision|it was agreed|\u0434\u043e\u0433\u043e\u0432\u043e\u0440\u0438\u043b\u0438\u0441\u044c|confirmed that|\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u043b\u0438)/i.test(
      userLine + assistantLine,
    );
  const constraintCue =
    /(must not|\u043d\u0435\u043b\u044c\u0437\u044f|forbidden|constraint|\u043d\u0435 \u0434\u0435\u043b\u0430\u0442\u044c|always do|\u043d\u0438\u043a\u043e\u0433\u0434\u0430)/i.test(
      userLine + assistantLine,
    );
  if (!decisionCue && !constraintCue) {
    return String(previous ?? "").trim();
  }
  const line = `[${new Date().toISOString().slice(0, 10)}] ${String(userLine ?? "").slice(0, 200)} → ${String(assistantLine ?? "").slice(0, 280)}`;
  const base = String(previous ?? "").trim();
  const merged = base ? `${base}\n${line}` : line;
  if (merged.length <= maxChars) return merged;
  return merged.slice(-maxChars);
}

/**
 * Threshold for a “long” thread by mirror message count (user and assistant counted separately).
 * @param {number} messageCount
 * @param {number} [threshold]
 */
export function shouldUpdateRollingSummary(messageCount, threshold = 20) {
  return messageCount >= threshold;
}
