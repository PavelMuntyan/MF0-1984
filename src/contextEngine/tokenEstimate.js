/** Грубая оценка токенов (~4 символа на токен) для бюджета. */
export function estimateTokens(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}
