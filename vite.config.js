import { defineConfig } from "vite";
import { resolveApiPort } from "./server/resolveApiPort.mjs";

/** Long uploads (e.g. image multipart → OpenAI) and streaming: avoid short default proxy socket timeouts. */
const PROXY_LONG_TIMEOUT_MS = 300000;

export default defineConfig({
  envPrefix: ["VITE_"],
  server: {
    port: 1984,
    /** If 1984 is taken (another process / old Vite), Vite picks the next port — check the terminal URL. */
    strictPort: false,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${resolveApiPort(process.env.API_PORT)}`,
        changeOrigin: true,
        timeout: PROXY_LONG_TIMEOUT_MS,
        proxyTimeout: PROXY_LONG_TIMEOUT_MS,
      },
    },
  },
  preview: {
    port: 1984,
    strictPort: false,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${resolveApiPort(process.env.API_PORT)}`,
        changeOrigin: true,
        timeout: PROXY_LONG_TIMEOUT_MS,
        proxyTimeout: PROXY_LONG_TIMEOUT_MS,
      },
    },
  },
});
