/**
 * Server-side LLM proxy — forwards /api/llm/<provider>/* to provider APIs.
 * Reads API keys from process.env; the browser never sees the real keys.
 */
import { Router } from "express";
import https from "node:https";
import { URL } from "node:url";

const router = Router();
const TIMEOUT_MS = 300_000;

// Headers not forwarded from the browser request to the upstream provider.
const SKIP_REQ_HEADERS = new Set([
  "host", "connection", "transfer-encoding", "te",
  "anthropic-dangerous-direct-browser-access",
]);

// Headers not forwarded from the upstream response back to the browser.
const SKIP_RES_HEADERS = new Set(["transfer-encoding", "connection", "keep-alive"]);

const PROVIDERS = {
  openai: {
    host: "api.openai.com",
    envKey: () => String(process.env.OPENAI_API_KEY ?? "").trim(),
    injectAuth: (h, k) => { h["authorization"] = `Bearer ${k}`; },
  },
  anthropic: {
    host: "api.anthropic.com",
    envKey: () => String(process.env.ANTHROPIC_API_KEY ?? "").trim(),
    injectAuth: (h, k) => { h["x-api-key"] = k; },
  },
  perplexity: {
    host: "api.perplexity.ai",
    envKey: () => String(process.env.PERPLEXITY_API_KEY ?? "").trim(),
    injectAuth: (h, k) => { h["authorization"] = `Bearer ${k}`; },
  },
  gemini: {
    host: "generativelanguage.googleapis.com",
    envKey: () => String(process.env.GEMINI_API_KEY ?? "").trim(),
    injectAuth: null,
    keyInQuery: true,
  },
};

function makeProxyHandler(providerName) {
  const cfg = PROVIDERS[providerName];

  return (req, res) => {
    const apiKey = cfg.envKey();
    if (!apiKey) {
      return res.status(503).json({ ok: false, error: `${providerName} API key not configured on server` });
    }

    // Strip /llm/<provider> prefix, keep query string
    const prefix = `/llm/${providerName}`;
    let upstreamPath = req.url.startsWith(prefix) ? req.url.slice(prefix.length) : req.url;
    if (!upstreamPath.startsWith("/")) upstreamPath = "/" + upstreamPath;

    // Gemini uses ?key= query param — replace whatever the client sent with the real key
    if (cfg.keyInQuery) {
      try {
        const u = new URL(upstreamPath, "https://placeholder.com");
        u.searchParams.set("key", apiKey);
        upstreamPath = u.pathname + (u.search || "");
      } catch { /* passthrough on malformed URL */ }
    }

    // Build request headers: copy client headers, skip hop-by-hop, inject auth
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!SKIP_REQ_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    if (cfg.injectAuth) cfg.injectAuth(headers, apiKey);

    // Body source: express.json() parses application/json bodies; re-serialize for forwarding.
    // Non-JSON bodies (multipart/form-data for image edits) are untouched — pipe req directly.
    const ct = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const isJsonBody = ct === "application/json" || ct === "text/json";
    let bodyBuf = null;
    if (isJsonBody) {
      bodyBuf = Buffer.from(JSON.stringify(req.body));
      headers["content-length"] = String(bodyBuf.length);
      headers["content-type"] = "application/json";
    }

    const proxyReq = https.request({
      hostname: cfg.host,
      path: upstreamPath,
      method: req.method,
      headers,
      timeout: TIMEOUT_MS,
    });

    req.on("close", () => proxyReq.destroy());

    proxyReq.on("response", (proxyRes) => {
      const resCt = String(proxyRes.headers["content-type"] || "").toLowerCase();
      const isStreaming =
        resCt.includes("text/event-stream") ||
        resCt.includes("application/x-ndjson") ||
        upstreamPath.includes("streamGenerateContent");

      const resHeaders = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (!SKIP_RES_HEADERS.has(k.toLowerCase())) resHeaders[k] = v;
      }
      if (isStreaming) {
        delete resHeaders["content-length"];
        resHeaders["cache-control"] = "no-cache, no-transform";
        resHeaders["x-accel-buffering"] = "no";
      }

      res.writeHead(proxyRes.statusCode ?? 200, resHeaders);
      proxyRes.pipe(res, { end: true });

      // If the upstream stream errors after headers are already sent, destroy the
      // client connection so the browser gets a network error instead of hanging.
      proxyRes.on("error", () => res.destroy());
    });

    proxyReq.on("error", (e) => {
      if (!res.headersSent) {
        res.status(502).json({ ok: false, error: e.message });
      } else {
        res.destroy();
      }
    });

    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ ok: false, error: "Upstream timeout" });
      } else {
        res.destroy();
      }
    });

    if (bodyBuf) {
      proxyReq.end(bodyBuf);
    } else {
      req.pipe(proxyReq);
    }
  };
}

for (const name of Object.keys(PROVIDERS)) {
  router.all(`/llm/${name}/*splat`, makeProxyHandler(name));
}

export default router;
