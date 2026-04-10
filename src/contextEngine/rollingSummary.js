/**
 * Инкрементальное обновление rolling summary и decision_log (без полного пересчёта треда).
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
    /(we decided|решили|decision|it was agreed|договорились|confirmed that|подтвердили)/i.test(
      userLine + assistantLine,
    );
  const constraintCue = /(must not|нельзя|forbidden|constraint|не делать|always do|никогда)/i.test(
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
 * Порог «длинного» треда по числу сообщений в mirror (user+assistant считаются отдельно).
 * @param {number} messageCount
 * @param {number} [threshold]
 */
export function shouldUpdateRollingSummary(messageCount, threshold = 20) {
  return messageCount >= threshold;
}
