/**
 * Ключи из `.env` для локальной разработки. В production-сборке намеренно пусто,
 * чтобы секреты не попадали в `dist/`.
 */
export function getModelApiKeys() {
  if (import.meta.env.PROD) {
    return {
      anthropic: "",
      openai: "",
      perplexity: "",
      "gemini-flash": "",
    };
  }
  const geminiKey = import.meta.env.GEMINI_API_KEY ?? "";
  return {
    anthropic: import.meta.env.ANTHROPIC_API_KEY ?? "",
    openai: import.meta.env.OPENAI_API_KEY ?? "",
    perplexity: import.meta.env.PERPLEXITY_API_KEY ?? "",
    "gemini-flash": geminiKey,
  };
}
