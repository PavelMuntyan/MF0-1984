# MF0-1984 (`mf-lab`) — Engineering Handoff

This document is a **single-source orientation** for engineers taking over the repository. It describes architecture, runtime layout, data flows, and operational practices. It intentionally **does not** document the internal cryptographic or passphrase-encoding pipeline for `.mf` project profile archives; treat those modules as a black box guarded by existing tests and code review.

---

## Release notes (1.9.9)

- Memory tree Optimization controls added to Settings (`Memory tree optimization`, 2x2 grid):
  - `Record linkage`
  - `Knowledge consistency`
  - `Graph pruning`
  - `LLM check`
- Optimizer execution behavior:
  - each run is launched from Settings but continues while Settings is open/hidden flow-safe (not canceled by closing the modal)
  - while one optimizer runs, all optimizer buttons are disabled; active button shows spinner
  - after successful completion, the same button shows a green check in the same icon slot where spinner was
  - success checkmark persists until Settings closes
  - all outcomes are appended to Activity log (start, no-op, applied stats, failures)
- Implemented optimization semantics (current MVP, universal/non-domain-specific):
  - Record linkage: deterministic duplicate candidates by normalized `(category,label)` with merge commands
  - Knowledge consistency: resolves relation conflicts per node pair by canonical (most frequent) relation; emits edge cleanup + canonical links
  - Graph pruning: removes self-loops and duplicate edges; performs relation-scoped transitive reduction (not hardcoded to a single relation)
  - LLM check: model-based quality gate for high-similarity merge candidates; strict JSON command contract
- Analytics integration:
  - optimizer LLM usage now accepted by aux analytics endpoint with request kinds:
    - `optimizer_record_linkage`
    - `optimizer_knowledge_consistency`
    - `optimizer_graph_pruning`
    - `optimizer_llm_check`
- Prior release context retained:
  - document attachment extraction endpoint and parser module (`/api/attachments/extract`, `server/attachmentTextExtract.mjs`)
  - supported parsed docs: `.docx`, `.pdf`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.rtf`
  - 1px border + denser spacing visual update in shared UI shell

---

## 1. Product snapshot

- **Name / repo:** MF0-1984 (internal product id), repository folder **`mf-lab`**.
- **What it is:** A **local-first** single-page web application for multi-provider LLM chat, structured “Human UI” workflows (Intro / Access / Rules panels with optional PIN locks), a **Memory tree** (3D force graph backed by SQLite), **themes** (conversation folders), **analytics** (per-model usage), **assistant favorites**, and **project profile** backup/restore (`.mf` bundle).
- **Primary stack:** **Vanilla ES modules** in the browser, **Vite 6** for dev/build, **Node.js** `http` server with **better-sqlite3**, **PM2** for long-running local processes.
- **Version source of truth:** `package.json` → `version`.

---

## 2. Repository layout (high level)

| Path | Role |
|------|------|
| `index.html` | Shell UI: sidebar, chat, modals, settings, import/export dialogs, CSP meta, script entry. |
| `src/main.js` | Main bootstrap: wiring DOM, chat send/stream, settings, memory tree hooks, profile import/export UI orchestration, activity log. |
| `src/chatApi.js` | Provider routing, prompt assembly, streaming/non-streaming completion, image generation, web-search/research modes, Access `#data` enrichment behavior in prompts. |
| `src/chatPersistence.js` | `fetch` client for `/api/*`, theme/dialog bootstrap, memory graph CRUD, favorites, analytics, project profile HTTP helpers. |
| `src/memoryTree.js` | 3D graph UI (force-graph + three-spritetext), open/close, theme sync, export trigger integration. |
| `src/settingsModelsUi.js` | Dynamic AI model pickers in Settings; remote model list fetch; dirty detection for **Save AI models**; serialized refresh queue. |
| `src/userChatModels.js` | Defaults and `localStorage` keys under `mf0.settings.aiModel.*` (and legacy `mf0.settings.chatModel.*` for dialogue). |
| `src/fetchRemoteModelLists.js` | Provider-specific “list models” HTTP calls from the browser (keys from `import.meta.env` in dev). |
| `src/modelEnv.js` | Reads Vite-exposed env keys for API keys in dev builds. |
| `server/api.mjs` | Monolithic HTTP router: SQLite access, migrations, JSON bodies, streaming-unrelated REST. |
| `server/*.mjs` | Feature slices: memory graph import, access external services DB, project profile export/import, access data dump helpers, port resolver. |
| `db/schema.sql` | Initial schema; migrations in `db/migrations/*.sql`. |
| `data/` | Runtime SQLite (`mf-lab.sqlite` by default), optional JSON caches (e.g. Access enrichment import). **Not** shipped as authoritative content for all installs. |
| `rules/` | JSON keeper files used by Intro/Rules flows (`core_rules.json`, etc.). |
| `vite.config.js` | Dev server port **1984**, `/api` proxy to API port, LLM reverse proxies (`/llm/*`) for CORS-free browser calls. |
| `ecosystem.config.cjs` | PM2: `mf-lab-api` (watches `server/`), `mf-lab-vite` (watches `vite.config.js`). |
| `public/pre-app-boot.js` | Early boot script referenced from HTML (CSP / safety net). |
| `.cursor/rules/*.mdc` | Cursor agent rules for this workspace (backup, API restart, constraints). |

---

## 3. How to run locally

### 3.1 Prerequisites

- **Node.js** (LTS recommended) with `npm`.
- **`npm install`** at repo root (postinstall fixes `7zip-bin` binary permissions for profile archives).
- **API keys** in a root **`.env`** file for development (Vite `envPrefix` exposes `OPENAI_*`, `ANTHROPIC_*`, `GEMINI_*`, `PERPLEXITY_*`, `VITE_*`). See `src/modelEnv.js` and `vite.config.js`.

### 3.2 Commands

- **API only:** `npm run api` → `node server/api.mjs` (default port **35184**, override with `API_PORT`).
- **Vite only:** `npm run dev:vite` (port **1984**, next free if busy).
- **Full dev (typical):** `npm run dev` → **concurrently** runs API + Vite.
- **Production build:** `npm run build` → static assets in `dist/`; `npm run preview` serves with same proxy table as dev.
- **PM2:** `npm run pm2:start` / `pm2:stop` / `pm2:restart` / `pm2:logs`.

### 3.3 Health check

- `GET http://127.0.0.1:<API_PORT>/api/health` must return JSON including `"ok": true` and `"mfLabApi": true`.

---

## 4. Environment variables (non-exhaustive)

| Variable | Where | Purpose |
|----------|--------|---------|
| `API_PORT` | API process | Listen port (default **35184**). |
| `API_SQLITE_PATH` | API process | Optional absolute/relative override for SQLite file. |
| `API_MAX_BODY_BYTES` | API process | Cap for JSON POST/PUT bodies (default 48 MiB, band-clamped). |
| `API_PATH_PREFIX` | API + logs | When behind a reverse proxy that strips a prefix; router canonicalizes paths containing `/api/`. |
| `ACCESS_DATA_DUMP_*` | Server modules | Allowlists / limits for live Access enrichment fetches (see `server/accessDataDump.mjs`). |
| Provider keys | Vite + Node | Prefixed keys per `vite.config.js` `envPrefix`; consumed in browser for model listing and chat proxy calls. |

`.env` is **gitignored**. Project profile **import** can restore a captured `.env` payload into the working tree on the machine performing import (operator responsibility).

---

## 5. Data model (SQLite)

- **Core hierarchy:** `themes` → `dialogs` → `conversation_turns`.
- **Turns** store user text, optional attachments JSON, assistant text, requested/responding provider ids, `request_type` (attach menu / special modes), timestamps, favorite flags + markdown snapshot columns.
- **Memory graph:** tables created by migration `004_memory_graph.sql` (`memory_graph_nodes`, `memory_graph_edges`, …).
- **Rules (structured):** `rule_blocks` from schema; legacy `rules` table may exist for context-engine migrations.
- **Access external services:** migration `008_*` — persisted credentials/catalog entries used by Access keeper flows.
- **Analytics:** migration `009_*` — usage archive and aggregates.
- **PIN / lock state:** migrations `006`, `007` — Intro vs combined IR panel lock semantics; see `src/irPanelPinLock.js` and `/api/ir-panel-lock`.

Application code in `server/api.mjs` applies idempotent **PRAGMA / ALTER** guards when adding columns so older DB files upgrade in place.

---

## 6. HTTP API surface (`server/api.mjs`)

The router is a **large sequential `if` chain** on normalized path + method. Notable groups:

- **Health:** `GET /api/health`
- **Attachment text extraction:** `POST /api/attachments/extract` (base64 payload, returns extracted text for supported office/document formats)
- **Purpose sessions (JSON files + SQLite bridge):**  
  `GET /api/intro/session`, `GET /api/access/session`, `GET /api/rules/session`, `GET /api/rules/keeper-files`, `PUT /api/rules/keeper-merge`
- **Access:**  
  `GET/PUT /api/access/external-services`, `GET /api/access/external-services/catalog`, `GET /api/access/data-dump-enrichment`
- **IR panel lock:** `GET /api/ir-panel-lock` (+ related PIN flows in the same module region)
- **Memory graph:**  
  `GET /api/memory-graph`, `POST /api/memory-graph/import`, `POST /api/memory-graph/ingest`
- **Optimizer analytics usage ingestion:**  
  `POST /api/analytics/aux-llm-usage` accepts optimizer request kinds (`optimizer_*`) in addition to existing memory/context kinds
- **Project profile:**  
  `POST /api/project-profile/export` (binary `.mf` response), `POST /api/project-profile/import` (multipart buffer + metadata)
- **Analytics:** `GET /api/analytics`
- **Assistant favorites:** `GET/POST` variants under `/api/assistant-favorite(s)` and `/api/dialogs/assistant-favorite(s)` (legacy path compatibility)
- **Themes / dialogs / turns:**  
  `GET /api/themes`, `POST /api/themes/bootstrap`, `POST /api/themes/new-dialog`, `POST /api/themes/delete`, `POST /api/themes/rename`,  
  `GET /api/dialogs/<id>/turns`, `POST /api/dialogs/<id>/turns` (+ clone / archive behaviors where implemented)

**Security headers** (JSON responses): nosniff, frame deny, cache control — see top of router. **Body size** enforced before JSON parse.

---

## 7. Front-end application architecture

### 7.1 Entry and globals

- `index.html` loads `src/main.js` as a module.
- `main.js` coordinates **hundreds of behaviors**; search by feature name or DOM id when navigating.
- **Activity log** is a simple append-only user-visible trace (`appendActivityLog`).

### 7.2 Chat pipeline (simplified)

1. User composes message + optional attach modes (web, research, image, Access `#data`, etc.).
2. `chatApi.js` selects provider order, builds model context (`src/contextEngine/*`), may call LLM via **Vite dev proxies** (`/llm/openai`, …) using keys from `import.meta.env`.
3. Responses rendered as markdown (`src/markdown.js`) with optional **syntax highlighting** (`src/markdownCodeHighlight.js`, highlight.js).
4. Turns persisted through `chatPersistence.js` → `/api/dialogs/.../turns`.

### 7.3 Settings modal

- Centered modal (`#settings-modal`): Memory tree import/export, project profile import/export, **AI settings** section.
- **AI models:** built only for providers that have keys; lists fetched live where possible; **Save AI models** persists to `localStorage` keys `mf0.settings.aiModel.<provider>.<role>`.
- **Disabled Save styling:** `src/theme.css` — `.settings-ai-save-btn` muted state when `disabled`.

### 7.4 Project profile (`.mf`) — product-level description

- **Purpose:** Single-file **offline backup** and **restore** of a local workspace: SQLite-derived JSON payloads, rules keeper JSON files, Access external services dump, Access data-dump enrichment snapshot, AI model `localStorage` snapshot, and `.env` restore payload.
- **UX:** Export opens a password modal (policy enforced client-side for minimum complexity). Import: pick `.mf`, password step, wrong-password informer, success informer. Because dev **Vite** watches `.env`, a successful import that rewrites `.env` may trigger a **full page reload**; a **sessionStorage one-shot flag** re-opens the success informer after reload (`src/main.js` + `settingsModelsUi.js` integration).
- **Implementation pointers:** `src/projectProfileExport.js`, `src/projectProfileImportUi.js`, `server/projectProfileExport.mjs`, `server/projectProfileImport.mjs`, API routes above. **Do not** duplicate sensitive crypto documentation here.

### 7.5 Memory tree

- **Export:** tarball / JSON pipeline (`src/memoryTreeExport.js`, settings button).
- **Import:** separate from project profile; success modal in `main.js`.
- **Graph:** `3d-force-graph`, **Three.js**; intro chat can detect commands (`src/introMemoryTreeCommands.js`).
- **Optimization UI in Settings:** four actions under Memory tree section:
  - `Record linkage`, `Knowledge consistency`, `Graph pruning`, `LLM check`
  - implemented in `src/main.js` with button ids `settings-memory-opt-*` and related styles in `src/theme.css`
  - runs produce `commands` / `links` payloads and apply through existing `POST /api/memory-graph/ingest`
  - all statuses are logged to Activity; successful runs mark the button with a persistent checkmark until Settings closes

### 7.6 Analytics dashboard

- `src/analyticsDashboard.js` + `GET /api/analytics` — charting and tables; keep XSS in mind when injecting dynamic HTML (historical fixes used escaping helpers).

---

## 8. Vite proxies and streaming

- `vite.config.js` configures **long timeouts** on LLM proxies and strips `Content-Length` on streaming responses where needed so chunks arrive incrementally in dev.
- Provider base URLs are remote HTTPS endpoints; the browser talks to **same-origin** `/llm/...` only.

---

## 9. Security & safety

- **CSP** and `public/pre-app-boot.js` are part of defense-in-depth; changing `index.html` meta requires coordinated updates.
- **SQLite files under `data/`** are real user data — agents/tests must avoid destructive experiments (see `.cursor/rules/no-destructive-db-in-agent-tests.mdc`).
- **Assistant markdown** goes through sanitization (`dompurify` where wired); favor established helpers over new `innerHTML`.

---

## 10. GitHub & release discipline

- Remote: **`PavelMuntyan/MF0-1984`** (SSH or HTTPS depending on clone).
- **Commit messages for releases** should be **English**, include **version** from `package.json` or user-declared version.
- After substantive **`server/**/*.mjs`** changes, restart **`mf-lab-api`** (PM2 or manual per `.cursor/rules/mf-lab-restart-api.mdc`).

---

## 11. Localization note

- Application UI strings in HTML/JS are predominantly **English**.
- Some **seed JSON** (e.g. under `data/` for Access enrichment catalog) may still contain **non-English marketing copy** from imports; that is **content**, not control flow. Translate only when product asks.

---

## 12. Quick troubleshooting

| Symptom | Check |
|---------|--------|
| `/api` 502 in dev | API not running or wrong `API_PORT`; Vite proxy target in `vite.config.js`. |
| Chat “no key” | `.env` not loaded, wrong prefix, or `import.meta.env` not rebuilt after `.env` change (restart Vite). |
| Settings models empty | No keys for provider; network to list-models endpoint; fallbacks in `userChatModels.js`. |
| PM2 API stale | `pm2 restart mf-lab-api` from repo root; verify `/api/health`. |
| Import profile odd state | Session flash key `mf0.profileImportSuccessFlash` in `sessionStorage`; import modal panel visibility CSS in `theme.css`. |

---

## 13. Further reading inside the repo

- `SECURITY.md` (if present) — disclosure and scope.
- `db/migrations/*.sql` — authoritative column additions.
- `src/chatApi.js` header regions — large file; use editor outline / search.
- `.cursor/rules/*.mdc` — automation expectations for agents working in this repo.

---

*End of handoff. Update this file when major subsystems or default ports change.*
