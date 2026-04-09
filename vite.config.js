import { defineConfig } from "vite";

/** Переменные из `.env` с этими префиксами доступны в коде как import.meta.env.* */
const MODEL_ENV_PREFIXES = [
  "VITE_",
  "ANTHROPIC_",
  "OPENAI_",
  "PERPLEXITY_",
  "GEMINI_",
];

export default defineConfig({
  envPrefix: MODEL_ENV_PREFIXES,
  server: {
    port: 1984,
    strictPort: true,
  },
  preview: {
    port: 1984,
    strictPort: true,
  },
});
