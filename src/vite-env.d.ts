/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly ANTHROPIC_API_KEY: string;
  readonly OPENAI_API_KEY: string;
  readonly PERPLEXITY_API_KEY: string;
  readonly GEMINI_API_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
