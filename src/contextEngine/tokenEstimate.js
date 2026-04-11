/** Rough token estimate (~4 chars per token) for budgeting. */
export function estimateTokens(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}
