import { defineConfig } from "vite";

/** Переменные из `.env` с этими префиксами доступны в коде как import.meta.env.* */
const MODEL_ENV_PREFIXES = [
  "VITE_",
  "ANTHROPIC_",
  "OPENAI_",
  "PERPLEXITY_",
  "GEMINI_",
];

/**
 * Меньше буферизации при стриминге через dev-прокси: снимаем Content-Length,
 * чтобы ответ шёл chunked и fetch + getReader() получали куски по мере готовности.
 * (Иначе часть провайдеров визуально отдаёт ответ «одним блоком».)
 */
function configureLlmStreamingProxy(proxy) {
  proxy.on("proxyRes", (proxyRes, req) => {
    const ct = String(proxyRes.headers["content-type"] || "").toLowerCase();
    const path = req.url || "";
    const streaming =
      ct.includes("text/event-stream") ||
      ct.includes("application/x-ndjson") ||
      path.includes("streamGenerateContent");
    if (!streaming) return;
    delete proxyRes.headers["content-length"];
    proxyRes.headers["cache-control"] = "no-cache, no-transform";
    proxyRes.headers["x-accel-buffering"] = "no";
  });
}

/** Прокси для вызовов LLM из браузера без CORS (только dev / vite preview). */
const llmProxy = {
  "/llm/openai": {
    target: "https://api.openai.com",
    changeOrigin: true,
    secure: true,
    rewrite: (path) => path.replace(/^\/llm\/openai/, ""),
    configure: configureLlmStreamingProxy,
  },
  "/llm/anthropic": {
    target: "https://api.anthropic.com",
    changeOrigin: true,
    secure: true,
    rewrite: (path) => path.replace(/^\/llm\/anthropic/, ""),
    configure: configureLlmStreamingProxy,
  },
  "/llm/perplexity": {
    target: "https://api.perplexity.ai",
    changeOrigin: true,
    secure: true,
    rewrite: (path) => path.replace(/^\/llm\/perplexity/, ""),
    configure: configureLlmStreamingProxy,
  },
  "/llm/gemini": {
    target: "https://generativelanguage.googleapis.com",
    changeOrigin: true,
    secure: true,
    rewrite: (path) => path.replace(/^\/llm\/gemini/, ""),
    configure: configureLlmStreamingProxy,
  },
};

export default defineConfig({
  envPrefix: MODEL_ENV_PREFIXES,
  server: {
    port: 1984,
    strictPort: true,
    proxy: llmProxy,
  },
  preview: {
    port: 1984,
    strictPort: true,
    proxy: llmProxy,
  },
});
