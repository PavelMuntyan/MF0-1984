# MF0-1984 (`mf-lab`) — Engineering Handoff

This document is a **single-source orientation** for engineers taking over the repository. It describes architecture, runtime layout, data flows, and operational practices. It intentionally **does not** document the internal cryptographic or passphrase-encoding pipeline for `.mf` project profile archives; treat those modules as a black box guarded by existing tests and code review.

---

## Release notes (1.9.27)

### Express 5 migration — monolithic `server/api.mjs` split into route modules

`server/api.mjs` was refactored from a ~1 650-line sequential `if`-chain into a **65-line Express 5 bootstrap** that mounts twelve focused route modules. No API surface or response shapes changed.

**New server layout:**

| Path | Contents |
|------|----------|
| `server/api.mjs` | Express app setup: middleware, router mounts, `app.listen` |
| `server/config.mjs` | `MAX_BODY_BYTES` export (default 48 MiB, env-overridable) |
| `server/middleware/http.mjs` | `securityHeaders`, `notFound`, `errorHandler` |
| `server/routes/health.mjs` | `GET /api/health` |
| `server/routes/attachments.mjs` | `POST /api/attachments/extract` |
| `server/routes/voice.mjs` | Transcription + voice reply CRUD |
| `server/routes/purposeSessions.mjs` | Intro / Rules / Access sessions, keeper-files, keeper-merge |
| `server/routes/access.mjs` | External services CRUD + data-dump enrichment |
| `server/routes/settings.mjs` | AI model lists cache + project cache stats / clear |
| `server/routes/irPanelLock.mjs` | IR panel lock / PIN flows |
| `server/routes/memoryGraph.mjs` | Memory graph GET / import / ingest |
| `server/routes/projectProfile.mjs` | Profile export / import (binary `express.raw()`) |
| `server/routes/analytics.mjs` | Analytics GET, turn costs, aux LLM usage |
| `server/routes/themes.mjs` | All theme / dialog / turn / favorites CRUD |
| `server/routes/llm.mjs` | **Server-side LLM proxy** (see below) |
| `server/services/accessServices.mjs` | `readAccessExternalServicesPayload()` — single source of truth |
| `server/services/contextPipeline.mjs` | `runAfterTurnPipeline`, `clearThreadDerivedData`, context helpers |
| `server/services/aiModelCache.mjs` | AI model lists cache read/write |

**Express 5 notes:**

- Async route handlers throw directly — no `asyncHandler` wrapper needed.
- Global `express.json({ type: ["application/json", "text/json"] })` covers all JSON routes. Binary routes (project-profile import, memory-graph gzip import) apply `express.raw()` locally; they coexist because `express.json()` skips non-matching content types without consuming the stream.
- `req.body = req.body ?? {}` middleware runs after `express.json()` to guarantee routes always get at least `{}`.
- `API_PATH_PREFIX` stripping (reverse-proxy support) is an early middleware slice on `req.url`.

### Server-side LLM proxy — keys moved out of the browser

All LLM calls now route through **`POST /api/llm/<provider>/*`** handled by `server/routes/llm.mjs`, which reads keys from `process.env` on the Node side. The browser never receives real API keys.

- **Browser** sends `Authorization: Bearer server-proxy` (placeholder returned by `src/modelEnv.js`).
- **Proxy** replaces the auth header with the real key from `process.env.OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `PERPLEXITY_API_KEY` / `GEMINI_API_KEY` before forwarding.
- **Gemini** key (`?key=`) is replaced in the query string rather than a header.
- Streaming responses (SSE / NDJSON / `streamGenerateContent`): `Content-Length` is dropped, `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` are set.
- `anthropic-dangerous-direct-browser-access` header is stripped on the server — the upstream call is server-to-server, not browser-direct.
- Non-JSON request bodies (multipart/form-data for `/v1/images/edits`) are piped through directly; JSON bodies re-serialized from `req.body`.
- Returns HTTP 503 if the required env key is not set.
- Vite-level `/llm/*` proxy rules **removed** from `vite.config.js`. All LLM traffic flows through `/api/llm/*` in both dev and production.
- `envPrefix` in `vite.config.js` now contains only `VITE_` (provider key prefixes removed).

**Client-side changes:**

- `src/modelEnv.js` — always returns `{ openai: "server-proxy", … }` for all providers; `hasAnyModelApiKey()` always returns `true`.
- All `fetch("/llm/…")` calls in `src/llmGateway.js`, `src/chatApi.js`, `src/fetchRemoteModelLists.js` updated to `fetch("/api/llm/…")`.

### SQLite WAL mode

`server/db/migrations.mjs` now runs `PRAGMA journal_mode = WAL` at startup. Concurrent reads no longer block each other, which benefits background analytics queries running alongside active chat turns.

### `.env` loading for the API server

`npm run api` and the PM2 ecosystem config now pass `--env-file=.env` to Node (requires Node 20.6+), so `process.env.*` keys are populated from `.env` without a separate dotenv dependency.

### Version bump

- `package.json` → **1.9.27**.

---

## Release notes (1.9.26)

### DB adapter layer (internal refactoring)

A new `server/db/adapter.mjs` module provides a **unified async interface** (`get`, `all`, `run`, `exec`, `transaction`) for SQLite access. All server-side DB modules now consume this adapter rather than raw `better-sqlite3`, making the async boundary explicit throughout the stack.

- **`server/db/adapter.mjs`** — exports `createSqliteAdapter(db)`. The `transaction()` implementation uses manual `BEGIN / COMMIT / ROLLBACK` to support async function bodies (safe because better-sqlite3 ops are synchronous).
- **`server/db/migrations.mjs`** — exports `db` (the raw SQLite connection) and `adapter` (top-level `await` factory that wires the adapter once at startup).
- **`server/db/turns.mjs`** — `createDialogUnderTheme` replaced manual `db.transaction()` with `adapter.transaction()`.
- **`server/db/analytics.mjs`**, **`server/db/memoryGraph.mjs`** — both migrated off direct `better-sqlite3` to the shared adapter. All public functions are now async.
- **`server/api.mjs`** — updated all call sites to `await` the now-async graph/analytics functions.

### Mobile UI redesign

#### Header navigation — icon buttons

On viewports ≤ 767 px the four text buttons (New chat, Analytics, Memory tree, Help) and a new **Themes** button replace their labels with SVG icons and fill the full header width as five equal 1/5-width tabs:

| Button | Icon |
|--------|------|
| New chat | FilePlus (document + plus) |
| Analytics | BarChart2 |
| Memory tree | GitBranch (VS Code Source Control style) |
| Help | HelpCircle |
| Themes | Layers (stacked cards) |

- Icons are injected as inline SVG (`class="btn-mobile-icon"`) inside each `.btn`; the text is wrapped in `<span class="btn-label">` and hidden via CSS on mobile.
- The Themes button (`#btn-mobile-themes`, `class="btn btn-mobile-only"`) is `display: none !important` on desktop and `display: inline-flex !important` on mobile. It triggers the same dropdown logic as the now-hidden `#btn-dialogues-menu` (both wired to `toggleThemesDropdown` in `initDialoguesMenu`).
- `#dialogues-panel-header` (the sidebar "Themes" title + chevron row) is `display: none` on mobile — replaced by the header icon button.
- On mobile `memoryTree.css` had a rule that forced `sidebar-panel-header` back to `display: flex` when Memory tree was open; a more-specific override (`#dialogues-panel.dialogues-panel--mt-collapsed #dialogues-panel-header { display: none }`) suppresses it.

#### AI opinion badge — icon on mobile

On mobile the "AI opinion" badge text is replaced by the sparkle-star SVG icon (same path as the attach-menu star). Text wrapped in `<span class="badge-ai-opinion-label">` (hidden on mobile), icon in `<svg class="badge-ai-opinion-icon">` (hidden on desktop).

#### Intro / Rules / Access — mobile themes dropdown

`syncIrToMobileSlot()` (called from `renderThemesSidebar` and `initDialoguesMenu`'s `onMqChange`) moves the three IR buttons (`#btn-ir-intro`, `#btn-ir-rules`, `#btn-ir-access`) into the `#mobile-ir-in-theme-list` slot at the top of `#dialogue-cards` on mobile, and restores them to `#sidebar-intro-rules-access` when the viewport widens to desktop. On mobile the buttons render as a **horizontal row, each occupying 1/3 of the width**, with a bordered card style and the lock icon inline next to the label.

#### Compact bottom bar

On mobile `--input-bar-row-height` is scaled to 70 % of its desktop value (`calc(... * 0.7)`). The textarea vertical padding is reduced to `0.55 rem` (from `1 rem`) and `input-bar-main` padding to `0.25 rem`. All four elements (+, textarea, Send, Mic) share the same CSS variable, so no per-element overrides are needed.

#### Memory tree — mobile camera

On mobile, after the force-simulation settles (`onEngineStop`), the camera centers on the **Interests hub node** (`memoryHubRole === "interests"`) instead of the whole-graph centroid, placing it in the middle of the narrow screen.

#### Removed: "mentioned themes" highlight

`refreshThemeHighlightsFromChat()` and `dialog-card--mentioned` CSS were removed entirely. The feature (highlighting sidebar theme cards whose name appeared in the last user message) caused false positives — e.g. the "1984" theme lit up whenever a chat mentioned the project name.

### Version bump

- `package.json` → **1.9.26**.

---

## Release notes (1.9.24)

### Module extraction: LLM gateway, Memory Keeper pipeline, Memory Optimizer

Three new source modules were extracted from `chatApi.js` and `main.js` to reduce file sizes and isolate responsibilities.

#### `src/llmGateway.js` — single LLM call entry point

- All raw provider HTTP calls (`callLlm`, `callLlmStream`) now live here.
- `requestKind: null` → caller is responsible for analytics recording (main chat turns).
- `requestKind: "string"` → gateway auto-records to `analytics_aux_llm_usage`.
- `chatApi.js` re-exports from this module so existing callers are unaffected.

#### `src/memoryKeepers.js` — post-turn Memory Tree augmentation

- Extracted ~830 lines of keeper orchestration from `chatApi.js` and `main.js`.
- Exports all extractor functions (Intro / Access / Rules / Chat keepers) and orchestration:

```js
export async function runKeepersAfterTurn({
  introContextActive, accessChatOpen, rulesChatOpen, modeForSend,
  accessDataDumpMode, hadAssistantError, persistUserText, persistDialogId,
  tid, providerId, key,
  log,           // callback: (msg) => void
  onGraphUpdate, // callback: () => void
}) { ... }
```

- `log` and `onGraphUpdate` callbacks decouple keeper logic from DOM.
- Also exports `keeperPayloadSummary`, `keeperIngestCommandsLine`, `pickKeeperProviderWithKey`.
- Imports: `callLlm` from `llmGateway.js`, `dialogueModel` from `chatApi.js` (now exported).

#### `src/memoryOptimizer.js` — Memory Tree optimization algorithms

- Extracted ~390 lines of pure algorithmic code from `main.js`.
- Exports four payload builders:
  - `buildRecordLinkageOptimizationPayload`
  - `buildKnowledgeConsistencyOptimizationPayload`
  - `buildInterestsOrphanReconnectPayload`
  - `buildLlmCheckOptimizationPayload`
- Private helpers `estimateTokensFromText` and `ensureUsageTotals` are local copies (not re-exported).
- Imports: `completeChatMessage` from `chatApi.js`, `findMemoryGraphHubPairFromProfileEdge` from `memoryTree.js`.
- UI orchestration (`runMemoryOptimization`, button wiring) stays in `main.js`.

#### File size reduction

| File | Before | After |
|------|--------|-------|
| `src/chatApi.js` | ~1 693 lines | ~871 lines |
| `src/main.js` | ~7 973 lines | ~7 231 lines |

#### Minor: `src/modelEnv.js` cosmetic fix

- Removed unnecessary intermediate `geminiKey` variable; all four provider keys now use the same inline `import.meta.env.X ?? ""` pattern.

### Version bump

- `package.json` → **1.9.24**.

---

## Release notes (1.9.22)

### AI opinion entry and model selection

- **AI opinion** is no longer under the **`+`** attach menu. It appears as **`#btn-ai-opinion`** in **`#model-badges`** (after the Claude badge), with disabled styling when fewer than two model keys exist or when attach modes that conflict with multi-model flow are active (`src/theme.css`, `index.html`, `src/main.js`).
- Entering **Create image**, **Deep research**, **Web search**, or **Access data** from **`+`** while in AI opinion restores the default chat provider (and image mode still picks a capable model when required). Leaving those modes does not silently re-enable AI opinion.
- **Mutual exclusivity:** In AI opinion mode, provider badges no longer show a misleading **`.active`** state; **`getActiveProviderId()`** resolves the primary speaker from **`getDefaultChatProvider()`** + **`PROVIDER_ORDER`**. Before entering AI opinion, the current badge selection is persisted via **`setDefaultChatProvider`**. A second click on **AI opinion** exits to default chat and calls **`restoreDefaultChatProviderBadge()`**.
- Clicking a **model badge** clears AI opinion and refreshes badges so a single model can be selected again.

### Composer Send button

- **`syncComposerSendButtonState()`** now disables Send while **`chatComposerSending`** (explicit **`disabled`**, not a no-op return).
- Send state is recomputed after **model badge** clicks, **AI opinion** toggle, and **attach menu** actions (so text or files already in the composer re-enable Send without requiring another keystroke).
- **`compositionend`** on **`#chat-input`** updates Send after IME composition (same eligibility as **`submitChat`**: trimmed text, attachment rows, or **Access data** mode).

### Version bump

- `package.json` / `package-lock.json` → **1.9.22**.

---

## Release notes (1.9.21)

### Memory graph keeper and aux analytics for API-saved turns

- When a chat turn is created only via **`POST /api/dialogs/:id/turns`** (benchmarks, scripts), an optional server-side **memory graph keeper** can run the same **interest sketch** + **normalize** pipeline as the browser, gated by request body / env (see `server/memoryGraphApiTurnKeeper.mjs` and callers in `server/api.mjs`).
- Keeper LLM calls on that path write **`interests_sketch`** and **`memory_graph_normalize`** rows into **`analytics_aux_llm_usage`** with the new **`conversation_turn_id`** and **`dialog_id`**, via `recordAuxLlmUsageRow` / `recordAuxUsage` callback.

### Memory tree router, chat pipeline, and client analytics

- Router and main-chat wiring improvements for supplement quality, deterministic fallback, and **aux attribution** after `saveConversationTurn` (`src/memoryTreeRouter.js`, `src/main.js`).
- Keeper extractors and aux reporting accept optional **`dialog_id` / `conversation_turn_id`** where applicable (`src/chatApi.js`, `src/chatPersistence.js`).

### Per-response cost UI

- **Response cost breakdown** (assistant bubble): estimated USD uses **five** fractional digits (e.g. `$0.00012`) in `formatTurnUsd` (`src/main.js`).

### Copy feedback on message bubbles

- **Copy** on user and assistant bubbles shows a short **“Copied”** label above the pointer with a quick fade (`makeCopyButton`, `copyTextToClipboard` success boolean, `src/theme.css`).

### Analytics allowlist and dead code

- Removed obsolete **`optimizer_record_linkage`** from **`AUX_LLM_USAGE_KINDS`** in `server/api.mjs` (record linkage is deterministic graph commands only). Labels map updated; older release note in this file corrected accordingly.
- Removed unused **`persistAiTalksAssistantTurn`** from `src/main.js` (AI opinion flow uses `saveConversationTurn` + `flushAiTalksRoundAuxBatch`).

### Version bump

- `package.json` / `package-lock.json` → **1.9.21**.

---

## Release notes (1.9.20)

### Memory tree retrieval bug fixes in chat

- Fixed several retrieval-path bugs where chat could answer as if Memory tree had no relevant data even when matching nodes existed.
- `src/memoryTreeRouter.js` now uses a more robust two-phase flow (title scan + detail rerank), plus deterministic graph fallback that does not depend on router LLM availability.
- Added graph-neighbor expansion safeguards so connected leaf nodes (including short/empty-note entity nodes) are preserved in supplement generation.
- Added compact all-node title index append for compact graphs, improving visibility of label-only facts in main chat context.
- Strengthened supplement retention through context fitting (`src/contextEngine/fitContextToBudget.js`) to reduce over-shrinking of Memory tree context.
- In `src/main.js`, when router output is empty or router call fails, chat now falls back to deterministic Memory tree supplement assembly.

### Important maintenance rule (do not remove)

- **Memory tree retrieval for chat is a required subsystem.**  
  The pre-turn Memory tree supplement path (`fetchMemoryTreeSupplementForPrompt` + deterministic fallback) must stay enabled for normal chat requests.
- Do not remove or bypass this retrieval block during refactors. If behavior changes are needed, update this section and validate against real graph-backed prompts before release.

### Version bump

- `package.json` / `package-lock.json` -> **1.9.20**.

---

## Release notes (1.9.18)

### Memory tree optimization and analytics hardening

- **`Graph pruning` removed completely** after field validation showed it can damage real user graph structure:
  - UI action removed from Settings (`index.html`, `settings-memory-opt-graph-pruning`)
  - client pruning builder removed (`buildGraphPruningOptimizationPayload` in `src/main.js`)
  - optimizer dispatcher/click path removed from `runMemoryOptimization` flow
  - analytics allowlist removed (`optimizer_graph_pruning` deleted from `AUX_LLM_USAGE_KINDS` in `server/api.mjs`)
- **`Knowledge consistency` restored** in Settings and optimizer execution flow (`src/main.js`) as the relation-cleanup action.
- **Current Memory tree optimization set (effective in 1.9.18):**
  - `Record linkage`
  - `Knowledge consistency`
  - `LLM check`
  - `Interests reconnect`

### LLM check analytics reliability

- **Problem:** `LLM check` calls were often recorded with zero tokens when provider usage was absent, so Analytics model spend/tokens looked unchanged.
- **Fixes:**
  - `buildLlmCheckOptimizationPayload` now normalizes usage via `ensureUsageTotals(...)` (same fallback strategy as chat turns) in `src/main.js`
  - optimizer analytics write path now always sends normalized prompt/completion/total token values for `optimizer_llm_check`
  - opened Analytics panel is refreshed right after optimization apply:
    - new `refreshAnalyticsViewIfOpen()` in `src/analyticsDashboard.js`
    - called from optimization success path in `src/main.js`
- **Server-side acceptance:** `/api/analytics/aux-llm-usage` keeps the explicit exception allowing zero-only payloads for `optimizer_llm_check` (defensive compatibility).

### Voice reply TTS now counted in analytics

- **Rule alignment:** every model invocation must land in analytics.
- Added server-side analytics logging for `POST /api/voice/replies/:turnId` when a new MP3 is synthesized:
  - `request_kind = "voice_reply_tts"`
  - provider mapping from TTS runtime id to analytics provider id:
    - `openai` -> `openai`
    - `gemini-3.1-flash-tts` -> `gemini-flash`
  - token accounting uses deterministic fallback from source assistant text (`chars/4` floor) when provider-side usage is unavailable.
- New helpers in `server/api.mjs`:
  - `estimateTokensFromText`
  - `analyticsProviderFromVoiceProvider`
  - `recordAuxLlmUsageRow`

### Documentation scope note

- This release intentionally documents code and product behavior changes only; manual local graph data edits are out of scope for release notes.

### Version bump

- `package.json` / `package-lock.json` -> **1.9.18**.

---

## Release notes (1.9.17)

### Memory tree optimization safety and scope update

- **`Graph pruning` removed from product entirely** (UI + client logic + analytics allowlist):
  - button removed from Settings (`index.html`, `settings-memory-opt-graph-pruning`)
  - pruning builder removed from client (`buildGraphPruningOptimizationPayload` in `src/main.js`)
  - run branch / click handler removed from optimizer flow (`runMemoryOptimization` in `src/main.js`)
  - aux analytics request kind removed from server allowlist (`optimizer_graph_pruning` from `AUX_LLM_USAGE_KINDS` in `server/api.mjs`)
- **`Knowledge consistency` restored** as an explicit optimizer action in Settings and in `src/main.js` optimizer flow.
- **Current optimizer set** in Settings now:
  - `Record linkage`
  - `Knowledge consistency`
  - `LLM check`
  - `Interests reconnect`

### Notes

- This release intentionally documents **product/code behavior only**; it does **not** include ad-hoc manual graph data edits.

### Version bump

- `package.json` / `package-lock.json` → **1.9.17**.

---

## Release notes (1.9.16)

### Composer — paste files from clipboard

Users can attach **images and other files** via **Ctrl/Cmd+V** into the main chat textarea (`#chat-input`), in addition to drag-and-drop onto `#main-chat` and **Add photos & files** from the attach menu.

- **`paste` handler** in `initChatComposer()` (`src/main.js`): reads `clipboardData.items` (`kind === "file"`, `getAsFile()`) and `clipboardData.files`, dedupes by `name` + `size` + `lastModified`, then calls **`addComposerAttachmentsFromFileList`** (same pipeline as file picker / drop).
- If the clipboard contains **both files and `text/plain`**, the handler **`preventDefault`s** (avoids garbage/binary in the textarea for image-only pastes) and then **`insertTextAtCaret`** inserts the plain text at the caret (`setRangeText` when available).
- **Help** chat: file paste is blocked with the same policy as send — **no attachments**; Activity log message matches the existing send guard.
- While **`chat-input` is disabled** (send in flight), clipboard file paste is ignored.
- Helpers: **`collectClipboardFiles`**, **`insertTextAtCaret`** in `src/main.js` (near `addComposerAttachmentsFromFileList`).

### Version bump

- `package.json` / `package-lock.json` → **1.9.16**.

---

## Release notes (1.9.15)

### Project Cache — split disk / database stats

Settings → **Project Cache** no longer shows a single combined **“files & pictures”** number (which mixed `data/` file caches with the whole SQLite file and confused users after clearing embedded media). The table now has **four rows** with separate meanings:

| UI label | JSON field (GET stats) | Meaning |
|----------|------------------------|---------|
| **chat database — other (approx.)** | `chatDbOtherApproxBytes` | `chatDatabaseBytes` (on-disk size of the main SQLite file, usually `data/mf-lab.sqlite` or `API_SQLITE_PATH`) **minus** `chatEmbeddedMediaBytes`, floored at zero. This is **not** a precise accounting of “non-media tables”; it is everything in the DB file that is **not** counted by the embedded-media heuristic (plain chat text, Memory graph, analytics, indexes, SQLite free-list space after deletes, etc.). |
| **chat database — embedded media (approx.)** | `chatEmbeddedMediaBytes` | **Estimate** computed by scanning **only** `conversation_turns`: UTF-8 byte length of `imageBase64` / `base64` strings inside `user_attachments_json` arrays, plus regex matches for inline `data:image/...;base64,...` in `user_text`, `assistant_text`, and `assistant_favorite_markdown`. Capped so it never exceeds `chatDatabaseBytes`. **May overcount** if the same image appears both in JSON attachments and inside markdown text. |
| **data folder (excl. database)** | `dataDirCacheBytes` | Recursive sum of regular files under `data/` **excluding** `*.sqlite` (e.g. `ai-model-lists-cache.json`, other JSON caches). |
| **sound files** | `soundFilesBytes` | Recursive byte sum under the voice-replies directory (`.mp3` / `.wav` on disk). |

**Backward compatibility:** `GET /api/settings/project-cache-stats` still returns `filesAndPicturesBytes` (= `dataDirCacheBytes + chatDatabaseBytes`, same as the old combined metric) for any external consumer; new clients should use the split fields.

**Implementation:** `getProjectCacheStatsPayload`, `estimateEmbeddedMediaBytesInConversationTurns`, helpers `utf8ByteLength`, `estimateMediaBytesFromAttachmentsJson`, `estimateDataImageBytesInPlainText` in `server/api.mjs`. Client: `fetchProjectCacheStats` in `src/chatPersistence.js`; `refreshProjectCacheStatsUi` and element ids `settings-project-cache-db-other-mb`, `settings-project-cache-db-media-mb`, `settings-project-cache-data-dir-mb`, `settings-project-cache-sound-mb` in `src/main.js`; table + `title` tooltips in `index.html`.

**Performance note:** opening Settings triggers a **full-table iterate** over `conversation_turns` for the media estimate. Acceptable for typical DB sizes; if this becomes hot, consider caching with TTL or incremental maintenance later.

### Project Cache — clear multimedia (disk + SQLite + VACUUM)

- **`POST /api/settings/project-cache-clear-multimedia`** runs `clearProjectMultimediaCacheFull()` in `server/api.mjs`:
  1. **`clearProjectMultimediaCacheDiskOnly()`** — deletes `.mp3`/`.wav` under the voice-replies directory and removes `data/tts-selftest/` recursively.
  2. **`stripEmbeddedMultimediaFromConversationTurns(db)`** — for matching rows, strips image payloads from `user_attachments_json` (via `stripImagePayloadsFromUserAttachmentsJson`), strips `data:image/...;base64,...` from the three text columns (via `stripDataImagePayloadsFromTextField`); keeps plain dialog text and non-image attachment metadata; if `user_text` becomes empty after stripping, replaces with a short placeholder string.
  3. **`VACUUM`** on the open DB connection so the SQLite **file size shrinks** on disk (otherwise Project Cache stats would still show a huge DB after clearing blobs). On failure, the JSON response may include **`vacuumWarning`** (string); the client logs this to Activity log (`src/main.js`).
- **Response shape:** `{ ok: true, filesRemoved, bytesFreed, turnsUpdated, vacuumWarning? }`.

### Project Cache — UX

- Clearing uses a **confirmation panel** (English copy) in `index.html`; **Yes** uses the same busy/spinner pattern as other Settings export actions (`settings-export-btn--busy`, `#settings-project-cache-confirm-yes` rules in `src/theme.css`).
- After success, stats refresh so users see updated Mb values.

### Version bump

- `package.json` / `package-lock.json` → **1.9.15**.

---

## Release notes (1.9.14)

- **Analytics includes all dialog purposes:** aggregates over `conversation_turns` no longer filter out Intro / Rules / Access (`analyticsDialogWhereSql` in `server/api.mjs` is always true). Token charts, spend estimates, and dialog counts reflect those threads like any other.
- **Background (aux) LLM usage in the same dashboards:** `analytics_aux_llm_usage` rows now also increment **per-provider request counts** (`requestsSent` / `responsesOk`) and the **daily “requests” chart** (`dailyUsage`), not only token totals and token-by-day series.
- **New aux `request_kind` values** (allowlisted in `server/api.mjs` → `AUX_LLM_USAGE_KINDS`, recorded from the client where applicable):
  - `theme_dialog_title` — `generateThemeDialogTitle` in `src/chatApi.js`
  - `help_chat_turn` — Help panel completions in `src/main.js` (no persisted dialog turn)
  - `rules_keeper_extract`, `access_keeper2_extract` — keeper extractors in `src/chatApi.js`
- **Rule:** every inference path must land in analytics (turn fields or `recordAuxLlmUsage` + allowlist). See `.cursor/rules/mf-lab-analytics-llm-always.mdc`.
- Version bump: `package.json` / `package-lock.json` → `1.9.14`.

---

## Release notes (1.9.13)

- **Voice input v1 (record -> transcribe -> send):** composer mic now records audio, auto-finishes after ~2s of silence, and also finishes on second mic tap.
- **Provider priority for transcription:** server route `POST /api/voice/transcribe` uses **Gemini first** (`gemini-flash`), then falls back to **ChatGPT/OpenAI** (`openai`) when needed.
- **UX during transcription:** a pending user bubble is shown immediately with spinner (`Transcribing voice…`); on success it is replaced with transcript text and sent through the normal chat pipeline; on error, the bubble stays and shows the failure message (does not disappear).
- **Implementation:** `src/main.js`, `src/chatPersistence.js`, `server/api.mjs`, `src/theme.css`.
- Version bump: `package.json` / `package-lock.json` -> `1.9.13`.

---

## Release notes (1.9.12)

- **Chat file drag-and-drop affordance:** when dragging files over the main chat column (`#main-chat`), the **entire dialogue area** is framed by a **dashed border** plus a light inset tint.
- **Implementation:** `#main-chat.main-chat--drag-over-files::after` in `src/theme.css` (`position: relative` on the host, `inset: 0`, `pointer-events: none`, `z-index: 8`); drop detection unchanged in `initChatFileDropZone` (`src/main.js`, class `main-chat--drag-over-files`).
- Version bump: `package.json` / `package-lock.json` → `1.9.12`.

---

## Release notes (1.9.11)

- **Mobile-only (`max-width: 767px`, same breakpoint as the Themes dropdown):** Intro / Rules / Access are no longer shown as a separate always-visible block under the Themes header.
- Those three controls now appear **inside the Themes list** (`#dialogue-cards`): a top row `#mobile-ir-in-theme-list`, visible when the user opens the Themes chevron dropdown — same interaction surface as picking a theme/dialog.
- **Implementation:** real DOM nodes (`#btn-ir-intro`, `#btn-ir-rules`, `#btn-ir-access`) are **reparented** between the desktop IR panel body and the mobile slot on viewport changes and after each `renderThemeCards` refresh (`src/main.js`, `src/themesSidebar.js`, `src/theme.css`). Event handlers and PIN lock UI stay attached to the original buttons.
- **Desktop (`min-width: 768px`):** layout unchanged; the in-list slot stays hidden.
- Version bump: `package.json` / `package-lock.json` → `1.9.11`.

---

## Release notes (1.9.10)

- Settings now includes a new **AI priority** block (placed before **AI settings**) with chat-style provider badges:
  - `ChatGPT`
  - `Perplexity`
  - `Gemini`
  - `Claude`
- Badge behavior:
  - providers without API keys in `.env` are shown as inactive (`badge--no-key`) and cannot be selected
  - clicking an active badge sets that provider as the **default chat model** for new sends
  - default provider choice is persisted in `localStorage` (`mf0.settings.defaultChatProvider`)
  - the selected provider is synchronized with the top chat provider badges and reflected in Activity log
- AI model lists loading in Settings is now cache-first + background refresh:
  - server-side JSON cache file: `data/ai-model-lists-cache.json`
  - new API routes:
    - `GET /api/settings/ai-model-lists-cache`
    - `PUT /api/settings/ai-model-lists-cache`
  - Settings UI first renders cached model ids immediately, then fetches provider lists in the background and updates both UI and cache
  - refresh token guards prevent stale async refreshes from overriding newer state
- Updated version source of truth in `package.json` / `package-lock.json` to `1.9.10`.

---

## Release notes (1.9.9)

- Memory tree Optimization controls added to Settings (`Memory tree optimization`, 2×2 grid):
  - `Record linkage`
  - `Knowledge consistency`
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
  - LLM check: model-based quality gate for high-similarity merge candidates; strict JSON command contract
- Analytics integration:
  - optimizer **LLM** usage is recorded only for **LLM check** (`optimizer_llm_check` via aux analytics). Record linkage and knowledge consistency are deterministic graph commands and do not emit aux rows.
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
| `src/chatApi.js` | Provider routing, prompt assembly, streaming/non-streaming completion, image generation, web-search/research modes, Access `#data` enrichment behavior in prompts. Re-exports from `llmGateway.js`. |
| `src/llmGateway.js` | Single entry point for all raw LLM provider HTTP calls (`callLlm`, `callLlmStream`). Aux-kind calls auto-record analytics; main-turn calls delegate recording to the caller. |
| `src/memoryKeepers.js` | Post-turn Memory Tree augmentation: Intro / Access / Rules / Chat keeper extractors + `runKeepersAfterTurn` orchestrator. Accepts `log` and `onGraphUpdate` callbacks to stay DOM-free. |
| `src/memoryOptimizer.js` | Pure algorithmic Memory Tree optimization: record linkage, knowledge consistency, interests reconnect, LLM-based duplicate check. UI orchestration stays in `main.js`. |
| `src/chatPersistence.js` | `fetch` client for `/api/*`, theme/dialog bootstrap, memory graph CRUD, favorites, analytics, project profile HTTP helpers. |
| `src/memoryTree.js` | 3D graph UI (force-graph + three-spritetext), open/close, theme sync, export trigger integration. |
| `src/themesSidebar.js` | Theme cards + dialog folder menus in `#dialogue-cards`; preserves `#mobile-ir-in-theme-list` slot for mobile Intro/Rules/Access row. |
| `src/settingsModelsUi.js` | Dynamic AI model pickers in Settings; remote model list fetch; dirty detection for **Save AI models**; serialized refresh queue. |
| `src/userChatModels.js` | Defaults and `localStorage` keys under `mf0.settings.aiModel.*` (and legacy `mf0.settings.chatModel.*` for dialogue). |
| `src/fetchRemoteModelLists.js` | Provider-specific “list models” HTTP calls from the browser (keys from `import.meta.env` in dev). |
| `src/modelEnv.js` | Returns `"server-proxy"` placeholder for all provider keys — real keys live in `process.env` on the server. |
| `server/api.mjs` | Thin Express 5 bootstrap (~65 lines): global middleware, router mounts, `app.listen`. |
| `server/config.mjs` | `MAX_BODY_BYTES` (48 MiB default, `API_MAX_BODY_BYTES` override). |
| `server/middleware/http.mjs` | `securityHeaders`, `notFound`, `errorHandler`. |
| `server/routes/` | Twelve route modules — see **Release notes (1.9.27)** for the full list. |
| `server/services/` | Shared logic: `accessServices.mjs`, `contextPipeline.mjs`, `aiModelCache.mjs`. |
| `server/*.mjs` | Feature slices: memory graph import, project profile export/import, access data dump helpers, port resolver. |
| `db/schema.sql` | Initial schema; migrations in `db/migrations/*.sql`. |
| `data/` | Runtime SQLite (`mf-lab.sqlite` by default), optional JSON caches (e.g. Access enrichment import). **Not** shipped as authoritative content for all installs. |
| `rules/` | JSON keeper files used by Intro/Rules flows (`core_rules.json`, etc.). |
| `vite.config.js` | Dev server port **1984**; `/api` proxy to API port. LLM calls go through `/api/llm/*` (server-side proxy); no browser-direct `/llm/*` rules. |
| `ecosystem.config.cjs` | PM2: `mf-lab-api` (watches `server/`, `node_args: --env-file=.env`), `mf-lab-vite` (watches `vite.config.js`). |
| `public/pre-app-boot.js` | Early boot script referenced from HTML (CSP / safety net). |
| `.cursor/rules/*.mdc` | Agent workspace rules (backup, API restart, constraints). |

---

## 3. How to run locally

### 3.1 Prerequisites

- **Node.js** (LTS recommended) with `npm`.
- **`npm install`** at repo root (postinstall fixes `7zip-bin` binary permissions for profile archives).
- **`ffmpeg`** installed on the machine that runs **`mf-lab-api`** and available on **`PATH`** (the API invokes `ffmpeg` for **Gemini text-to-speech** output: PCM/WAV → MP3 for voice-reply downloads; without it, long-reply Gemini audio paths fail with a clear server error). Typical installs: `brew install ffmpeg` (macOS), `apt install ffmpeg` (Debian/Ubuntu), or the [official builds](https://ffmpeg.org/download.html). Verify with `ffmpeg -version`.
- **API keys** in a root **`.env`** file. Keys are read by the **Node API server** via `--env-file=.env` (requires Node 20.6+, already in `npm run api` and `ecosystem.config.cjs`). The browser no longer receives real keys — `src/modelEnv.js` returns a placeholder. See `server/routes/llm.mjs` for the proxy that injects keys server-side.

### 3.2 Commands

- **API only:** `npm run api` → `node --env-file=.env server/api.mjs` (default port **35184**, override with `API_PORT`).
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
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `GEMINI_API_KEY` | API server (`process.env`) | Loaded via `--env-file=.env`. Used exclusively by `server/routes/llm.mjs`; never sent to the browser. |

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

## 6. HTTP API surface

The API is an **Express 5** app with twelve route modules mounted at `/api`. Notable groups:

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
- **Settings — project cache:**  
  `GET /api/settings/project-cache-stats` (disk + DB size breakdown; see **Release notes (1.9.15)**),  
  `POST /api/settings/project-cache-clear-multimedia` (voice cache + strip embedded images in `conversation_turns` + `VACUUM`)
- **Assistant favorites:** `GET/POST` variants under `/api/assistant-favorite(s)` and `/api/dialogs/assistant-favorite(s)` (legacy path compatibility)
- **Themes / dialogs / turns:**  
  `GET /api/themes`, `POST /api/themes/bootstrap`, `POST /api/themes/new-dialog`, `POST /api/themes/delete`, `POST /api/themes/rename`,  
  `GET /api/dialogs/<id>/turns`, `POST /api/dialogs/<id>/turns` (+ clone / archive behaviors where implemented)

- **LLM proxy:** `GET|POST /api/llm/<provider>/*` — forwards to OpenAI / Anthropic / Perplexity / Gemini with server-injected keys; handles streaming (drops `Content-Length`, sets `x-accel-buffering: no`).

**Security headers** (`server/middleware/http.mjs`): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store` on every response. **Body size** enforced by global `express.json({ limit: MAX_BODY_BYTES })`.

---

## 7. Front-end application architecture

### 7.1 Entry and globals

- `index.html` loads `src/main.js` as a module.
- `main.js` coordinates **hundreds of behaviors**; search by feature name or DOM id when navigating.
- **Activity log** is a simple append-only user-visible trace (`appendActivityLog`).

### 7.2 Chat pipeline (simplified)

1. User composes message + optional attach modes (web, research, image, Access `#data`, etc.). **File attachments** can come from the attach menu, drag-and-drop onto `#main-chat`, or **paste into `#chat-input`** (see **Release notes (1.9.16)**); logic lives in `src/main.js` / `src/composerAttachments.js`.
2. Pre-turn context build in `src/main.js` always attempts Memory tree supplement retrieval for regular chat (`fetchMemoryTreeSupplementForPrompt`), and falls back to deterministic graph supplement if router output is empty or router call fails.
3. `chatApi.js` selects provider order, builds model context (`src/contextEngine/*`), calls LLM via **`/api/llm/<provider>/*`** (server-side proxy; keys injected by the API server, not the browser).
4. Responses rendered as markdown (`src/markdown.js`) with optional **syntax highlighting** (`src/markdownCodeHighlight.js`, highlight.js).
5. Turns persisted through `chatPersistence.js` → `/api/dialogs/.../turns`.

### 7.2a Themes sidebar and mobile Intro / Rules / Access

- Theme cards are rendered into `#dialogue-cards` via `src/themesSidebar.js` (`renderThemeCards`, `syncSidebarSelectionState`).
- On **narrow viewports** (`max-width: 767px`), the dedicated IR panel `#sidebar-intro-rules-access` is hidden in CSS; Intro / Rules / Access bubbles are **moved** into `#mobile-ir-in-theme-list` at the **top** of `#dialogue-cards`, so they only appear together with the theme list inside the mobile Themes dropdown (`initDialoguesMenu` in `src/main.js`).
- On **wide viewports**, the same buttons are moved back into `#sidebar-intro-rules-access .sidebar-ir-panel-body`; the in-list slot is hidden.

### 7.3 Settings modal

- Centered modal (`#settings-modal`): Memory tree import/export, project profile import/export, **AI settings** section.
- **Project Cache** (section `settings-project-cache-section` in `index.html`): table of four usage rows (chat DB “other” vs embedded media estimate, `data/` caches excluding `.sqlite`, sound files); **Clear project cache** opens a confirm step then calls `clearProjectMultimediaCache()` in `src/chatPersistence.js` (`POST /api/settings/project-cache-clear-multimedia`). Stats load via `fetchProjectCacheStats` when the modal opens / after clear.
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
- **Optimization UI in Settings:** actions under Memory tree section:
  - `Record linkage`, `Knowledge consistency`, `LLM check`, `Interests reconnect`
  - implemented in `src/main.js` with button ids `settings-memory-opt-*` and related styles in `src/theme.css`
  - runs produce `commands` / `links` payloads and apply through existing `POST /api/memory-graph/ingest`
  - all statuses are logged to Activity; successful runs mark the button with a persistent checkmark until Settings closes

### 7.6 Analytics dashboard

- `src/analyticsDashboard.js` + `GET /api/analytics` — charting and tables; keep XSS in mind when injecting dynamic HTML (historical fixes used escaping helpers).

---

## 8. Vite proxies and streaming

- `vite.config.js` proxies `/api` → Node API server (long timeout, both `server` and `preview` modes).
- **LLM traffic is no longer proxied by Vite.** All provider calls go through `/api/llm/*` on the Node server, which handles streaming headers (`Content-Length` drop, `x-accel-buffering: no`) and key injection itself.
- In production (`npm run build` + `npm run preview` or a real web server), the same `/api/llm/*` routes serve requests directly — no Vite layer required.

---

## 9. Security & safety

- **CSP** and `public/pre-app-boot.js` are part of defense-in-depth; changing `index.html` meta requires coordinated updates.
- **SQLite files under `data/`** are real user data — agents/tests must avoid destructive experiments (see `.cursor/rules/no-destructive-db-in-agent-tests.mdc` for the constraint rule).
- **Assistant markdown** goes through sanitization (`dompurify` where wired); favor established helpers over new `innerHTML`.

---

## 10. GitHub & release discipline

- Remote: **`PavelMuntyan/MF0-1984`** (SSH or HTTPS depending on clone).
- **Commit messages for releases** should be **English**, include **version** from `package.json` or user-declared version.
- After substantive **`server/**/*.mjs`** changes, restart **`mf-lab-api`** (PM2 or `npm run api`).

---

## 11. Localization note

- Application UI strings in HTML/JS are predominantly **English**.
- Some **seed JSON** (e.g. under `data/` for Access enrichment catalog) may still contain **non-English marketing copy** from imports; that is **content**, not control flow. Translate only when product asks.

---

## 12. Quick troubleshooting

| Symptom | Check |
|---------|--------|
| `/api` 502 in dev | API not running or wrong `API_PORT`; Vite proxy target in `vite.config.js`. |
| Chat “no key” or 503 from `/api/llm/*` | `.env` missing the key or API server not started with `--env-file=.env` (check `npm run api` or `pm2 restart mf-lab-api`). |
| Settings models empty | No keys for provider; network to list-models endpoint; fallbacks in `userChatModels.js`. |
| PM2 API stale | `pm2 restart mf-lab-api` from repo root; verify `/api/health`. |
| Import profile odd state | Session flash key `mf0.profileImportSuccessFlash` in `sessionStorage`; import modal panel visibility CSS in `theme.css`. |

---

## 13. Further reading inside the repo

- `SECURITY.md` (if present) — disclosure and scope.
- `db/migrations/*.sql` — authoritative column additions.
- `src/chatApi.js` header regions — large file; use editor outline / search.
- `.cursor/rules/*.mdc` — workspace constraint rules for agents.

---

*End of handoff. Update this file when major subsystems or default ports change.*
