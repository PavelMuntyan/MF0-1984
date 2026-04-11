import { defineConfig } from "vite";

/** `.env` variables with these prefixes are exposed as import.meta.env.* */
const MODEL_ENV_PREFIXES = [
  "VITE_",
  "ANTHROPIC_",
  "OPENAI_",
  "PERPLEXITY_",
  "GEMINI_",
];

/**
 * Less buffering for streaming via dev proxy: drop Content-Length so the response
 * is chunked and fetch + getReader() receive chunks as they arrive.
 * (Otherwise some providers appear to return the whole reply as one block.)
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

/** Proxy LLM calls from the browser without CORS (dev / vite preview only). */
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
    /** If 1984 is taken (another process / old Vite), Vite picks the next port — check the terminal URL. */
    strictPort: false,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.API_PORT || 35184}`,
        changeOrigin: true,
      },
      ...llmProxy,
    },
  },
  preview: {
    port: 1984,
    strictPort: false,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.API_PORT || 35184}`,
        changeOrigin: true,
      },
      ...llmProxy,
    },
  },
});
