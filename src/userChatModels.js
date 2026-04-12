/**
 * Persisted AI model ids per provider and role (Settings → AI settings).
 * Legacy: mf0.settings.chatModel.{provider} → dialogue only.
 */

const LEGACY_CHAT_PREFIX = "mf0.settings.chatModel.";
const STORAGE_PREFIX = "mf0.settings.aiModel.";

/** @typedef {"openai" | "anthropic" | "gemini" | "perplexity"} AiSettingsProvider */
/** @typedef {"dialogue" | "images" | "search" | "research"} AiModelRole */

/** Built-in defaults per provider × role. */
export const DEFAULT_AI_MODEL_IDS = {
  openai: {
    dialogue: "gpt-5.4",
    images: "gpt-image-1",
    search: "gpt-5-search-api",
    research: "gpt-5.4",
  },
  anthropic: {
    dialogue: "claude-sonnet-4-6",
    search: "claude-sonnet-4-6",
    research: "claude-sonnet-4-6",
  },
  gemini: {
    dialogue: "gemini-3.1-pro-preview",
    images: "gemini-3-pro-image-preview",
    search: "gemini-3.1-pro-preview",
    research: "gemini-3.1-pro-preview",
  },
  perplexity: {
    dialogue: "sonar",
    search: "sonar-pro",
    research: "sonar-reasoning-pro",
  },
};

/** When list-models APIs fail, Settings still shows these plus any stored id. */
export const FALLBACK_AI_MODEL_LISTS = {
  openai: {
    dialogue: [
      "gpt-5.4",
      "gpt-5-search-api",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4o",
      "gpt-4o-mini",
      "o4-mini",
      "o3-mini",
    ],
    images: ["gpt-image-1", "dall-e-3", "dall-e-2"],
    search: ["gpt-5-search-api", "gpt-4o-search-preview"],
    research: ["gpt-5.4", "o4-mini", "o3-mini", "gpt-4.1", "gpt-5-search-api"],
  },
  anthropic: {
    dialogue: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-3-5-haiku-20241022", "claude-3-7-sonnet-20250219"],
    search: ["claude-sonnet-4-6", "claude-opus-4-6"],
    research: ["claude-sonnet-4-6", "claude-opus-4-6"],
  },
  gemini: {
    dialogue: [
      "gemini-3.1-pro-preview",
      "gemini-3-pro-image-preview",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-2.0-flash",
    ],
    images: ["gemini-3-pro-image-preview", "gemini-2.5-flash-image", "imagen-3.0-generate-002"],
    search: ["gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
    research: ["gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
  },
  perplexity: {
    dialogue: ["sonar", "sonar-pro"],
    search: ["sonar", "sonar-pro"],
    research: ["sonar-reasoning", "sonar-reasoning-pro", "sonar-deep-research"],
  },
};

/**
 * @param {AiSettingsProvider} provider
 * @param {AiModelRole} role
 * @returns {string}
 */
export function getUserAiModel(provider, role) {
  const def = DEFAULT_AI_MODEL_IDS[provider]?.[role];
  try {
    const v = localStorage.getItem(`${STORAGE_PREFIX}${provider}.${role}`);
    const t = String(v ?? "").trim();
    if (t) return t;
  } catch {
    /* ignore */
  }
  if (role === "dialogue") {
    try {
      const legacy = localStorage.getItem(`${LEGACY_CHAT_PREFIX}${provider}`);
      const lt = String(legacy ?? "").trim();
      if (lt) return lt;
    } catch {
      /* ignore */
    }
  }
  if (role === "images" && provider === "openai") {
    try {
      const env = String(import.meta.env.OPENAI_IMAGE_MODEL ?? "").trim();
      if (env) return env;
    } catch {
      /* ignore */
    }
  }
  return def ?? "";
}

/**
 * @param {AiSettingsProvider} provider
 * @param {AiModelRole} role
 * @param {string} modelId
 */
export function setUserAiModel(provider, role, modelId) {
  const t = String(modelId ?? "").trim();
  if (!t) return;
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${provider}.${role}`, t);
  } catch {
    /* ignore */
  }
}

/**
 * @deprecated use getUserAiModel(provider, "dialogue")
 * @param {AiSettingsProvider} provider
 */
export function getUserChatModelId(provider) {
  return getUserAiModel(provider, "dialogue");
}

/**
 * @deprecated use setUserAiModel(provider, "dialogue", id)
 * @param {AiSettingsProvider} provider
 * @param {string} modelId
 */
export function setUserChatModelId(provider, modelId) {
  setUserAiModel(provider, "dialogue", modelId);
}

/**
 * @param {string[]} ids
 * @param {string[]} fallbacks
 * @param {string} current
 * @returns {string[]}
 */
export function mergeModelIdOptions(ids, fallbacks, current) {
  const set = new Set();
  for (const x of fallbacks) {
    const s = String(x).trim();
    if (s) set.add(s);
  }
  for (const x of ids) {
    const s = String(x).trim();
    if (s) set.add(s);
  }
  const cur = String(current).trim();
  if (cur) set.add(cur);
  return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}
