/**
 * Model API keys from `.env` in local dev. In production builds values are empty
 * so secrets are not shipped in `dist/`.
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
  return {
    anthropic: import.meta.env.ANTHROPIC_API_KEY ?? "",
    openai: import.meta.env.OPENAI_API_KEY ?? "",
    perplexity: import.meta.env.PERPLEXITY_API_KEY ?? "",
    "gemini-flash": import.meta.env.GEMINI_API_KEY ?? "",
  };
}

/** True if at least one model API key is set (dev / `.env`). */
export function hasAnyModelApiKey() {
  const keys = getModelApiKeys();
  return Object.values(keys).some((v) => String(v ?? "").trim().length > 0);
}
