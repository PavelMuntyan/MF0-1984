# Security policy — MF0-1984 (mf-lab)

This document describes the **intended threat model** (local single-user application), **sensitive data**, and how to **report** security issues.

## Scope and threat model

- The project is designed to run **on your machine**: a **local HTTP API** (default `127.0.0.1`) and a **browser UI** (e.g. Vite dev server or static `dist/`).
- The API **binds to loopback only** (`127.0.0.1`), not `0.0.0.0`, so it is not exposed to the LAN by default.
- There is **no authentication** on the local API: any process on the same host that can open TCP connections to the API port can read or modify application data. This is acceptable only for **personal local use**.

If you put a reverse proxy or tunnel in front of the app and expose it to the internet, you are **outside the supported model** — do your own hardening (TLS, authentication, rate limits, WAF).

## Sensitive data

- **SQLite database** under `data/` (e.g. `mf-lab.sqlite`) contains chats, themes, memory graph, Access rows (including stored credentials for external services), etc. Database files are **gitignored** — do not commit them.
- **`.env`** holds model API keys and optional settings. It is **gitignored** — do not commit it or paste keys into issues.

## Development vs production builds

- In **development**, Vite may expose variables prefixed like `ANTHROPIC_*`, `OPENAI_*`, etc. to the client bundle. **API keys can end up in the browser context** during local dev. Treat the dev browser profile as sensitive.
- In **production** (`vite build`), the app is configured so model keys from `import.meta.env` are **not** shipped as real secrets in the built client bundle for the paths controlled by `src/modelEnv.js`. You should still **never** bake secrets into source code.

## HTTP API hardening (implemented)

- **Maximum JSON body size** for POST/PUT bodies read by the API (default **10 MiB**, configurable via `API_MAX_BODY_BYTES` in `.env`; see `.env.example`). Oversized bodies yield **413** and the connection is aborted.
- JSON responses include **`X-Content-Type-Options: nosniff`**, **`X-Frame-Options: DENY`**, and **`Cache-Control: no-store`**.

## Fetching third-party JSON (#data / Access)

The API can perform **allowlisted HTTPS GETs** for live JSON used in context. URLs are constrained (e.g. public HTTPS, hostname rules, response size limits, per-request fetch budget). Misconfiguration of environment variables could widen behaviour — review `ACCESS_DATA_DUMP_*` in `.env.example`.

## Dependencies

Run periodically:

```bash
npm audit
```

Address findings according to severity; dev-only tools (e.g. PM2) may report issues that do not affect a minimal production static deploy.

## Content Security Policy (CSP)

The app ships a **Content-Security-Policy** (meta tag) tuned for the current UI: scripts from **same origin** only (including `/pre-app-boot.js` from `public/`), Vite module bundle, and `style-src` allowing **inline styles** where the UI relies on them. Tightening CSP further may require refactoring inline styles.

## Reporting a vulnerability

If you believe you found a security vulnerability:

1. **Do not** open a public issue with exploit details.
2. Prefer **[GitHub Security advisories](https://github.com/PavelMuntyan/MF0-1984/security/advisories)** for this repository (if enabled), or contact the repository owner **privately** with a clear description, affected version/commit, and reproduction steps.

We will treat valid reports seriously; timelines depend on maintainer availability (this is a personal project).

## Disclaimer

Use at your own risk. No warranty. Security properties depend on correct deployment, OS updates, and your own operational practices.
