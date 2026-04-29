/**
 * LLM calls are proxied through /api/llm/* — keys live in server process.env, not the browser.
 * Return a non-empty placeholder so gateway callers pass their `!key` guards.
 */
export function getModelApiKeys() {
  return {
    anthropic: "server-proxy",
    openai: "server-proxy",
    perplexity: "server-proxy",
    "gemini-flash": "server-proxy",
  };
}

/** True if the server proxy is in use (always, for this build). */
export function hasAnyModelApiKey() {
  return true;
}
