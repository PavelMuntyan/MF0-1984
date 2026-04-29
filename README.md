# MF0-1984 (`mf-lab`)

**MF0-1984** is a **local-first** single-page app for multi-provider LLM chat, structured workflows (Intro / Access / Rules / Help), a **Memory tree** (3D graph over SQLite), **themes** and dialogs, **analytics**, **favorites**, and **project profile** backup/restore (`.mf` bundles).

| | |
|---|---|
| **UI dev server** | Vite — default port **1984** (`vite.config.js`) |
| **Local API** | Node + `better-sqlite3` — default port **35184** (`API_PORT`) |
| **Version** | **1.9.27** (`package.json`) |

For architecture, data model, env vars, and operations, see **[HANDOFF.md](./HANDOFF.md)** (engineering handoff).

---

## Prerequisites

- **Git**, **Node.js** (LTS / 18+ recommended) and **npm** on your PATH
- After the one-liner below, edit **`.env`** and add provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`). Keys are read by the API server via `--env-file=.env` and are never sent to the browser. The repo ships **`.env.example`** only; **`.env`** is gitignored.

---

## Clone and run (single bash line, macOS / Linux)

From a directory where you want the project folder created:

```bash
git clone https://github.com/PavelMuntyan/MF0-1984.git && cd MF0-1984 && ([ -f .env ] || cp .env.example .env) && npm install && npm run dev
```

This clones the repo, enters **`MF0-1984`**, creates **`.env`** from the example if missing, installs dependencies, and starts **API + Vite**. Open the URL Vite prints (typically **`http://127.0.0.1:1984`**).

If you already cloned the repo:

```bash
cd MF0-1984 && git pull && ([ -f .env ] || cp .env.example .env) && npm install && npm run dev
```

(Adjust the folder name if you cloned into a different path.)

---

## Quick start (already in repo root)

```bash
npm install
npm run dev
```

The dev setup runs the API and Vite together.

**API health:** `GET http://127.0.0.1:35184/api/health` — expect JSON with `"ok": true` and `"mfLabApi": true` (adjust port if `API_PORT` is set).

---

## npm scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | API + Vite (recommended for local work) |
| `npm run api` | API only (`node server/api.mjs`) |
| `npm run dev:vite` | Vite only |
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Preview production build |
| `npm run db:init` | Initialize DB (see `scripts/init-db.mjs`) |
| `npm run pm2:start` / `pm2:stop` / `pm2:restart` / `pm2:logs` | PM2 process manager (`ecosystem.config.cjs`) |

---

## Repository layout (short)

| Path | Role |
|------|------|
| `index.html` | App shell |
| `src/` | Browser ES modules — chat, settings, memory tree, persistence client, etc. |
| `server/api.mjs` | Thin Express 5 bootstrap — middleware + router mounts |
| `server/routes/` | Twelve route modules (health, voice, LLM proxy, themes, analytics, …) |
| `server/services/` | Shared server-side logic (context pipeline, access services, AI model cache) |
| `server/*.mjs` | Feature modules: memory graph import, project profile export/import, access data dump, port resolver |
| `db/` | Schema and migrations |
| `data/` | Runtime SQLite and optional caches (not treated as canonical for every clone) |
| `HANDOFF.md` | Full technical orientation |

---

## Security note

Do not commit **`.env`** or live **SQLite** files with private data. Use project profile export/import and your own backup policy for sensitive environments.

---

## Contributing / fork

There is no separate contributor guide in this repo; use **HANDOFF.md** and existing code style. Issues and PRs follow your GitHub workflow.
