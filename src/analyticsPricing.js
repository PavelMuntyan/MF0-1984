/**
 * Illustrative USD per 1M tokens for Analytics cost estimates (not live billing).
 * Provider buckets mix models; rates are a single reference tier per provider.
 */

/** @type {Record<string, { input: number, output: number, tier: string }>} */
export const ANALYTICS_USD_PER_1M = {
  /** User reference: GPT-4o–class ~ $2.50 / $15 per 1M */
  openai: { input: 2.5, output: 15, tier: "GPT-4o class (illustrative)" },
  /** Claude Sonnet–class mid tier */
  anthropic: { input: 3, output: 15, tier: "Claude Sonnet class (illustrative)" },
  /** Gemini Flash list pricing */
  "gemini-flash": { input: 0.5, output: 3, tier: "Gemini Flash (illustrative)" },
  /** Perplexity API varies by underlying model — midpoint of a typical range */
  perplexity: { input: 2.75, output: 9, tier: "Perplexity API mid-range (illustrative)" },
};

/**
 * @param {string} providerId
 * @param {number} promptTokens
 * @param {number} completionTokens
 */
export function estimateProviderUsd(providerId, promptTokens, completionTokens) {
  const r = ANALYTICS_USD_PER_1M[providerId];
  if (!r) return null;
  const p = Math.max(0, Number(promptTokens) || 0);
  const c = Math.max(0, Number(completionTokens) || 0);
  const inputUsd = (p / 1_000_000) * r.input;
  const outputUsd = (c / 1_000_000) * r.output;
  return {
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
    tier: r.tier,
    inputPer1M: r.input,
    outputPer1M: r.output,
  };
}

/**
 * @param {number | null | undefined} usd
 */
export function formatUsdEstimate(usd) {
  if (usd == null || !Number.isFinite(usd)) return "—";
  const x = Math.max(0, usd);
  if (x === 0) return "$0.00";
  if (x < 0.01) return `$${x.toFixed(4)}`;
  if (x < 1) return `$${x.toFixed(3)}`;
  return `$${x.toFixed(2)}`;
}
