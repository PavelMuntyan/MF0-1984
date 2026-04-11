import "./theme.css";
import pkg from "../package.json";
import {
  apiImageGenerationModelHint,
  apiModelHint,
  completeChatMessage,
  completeChatMessageStreaming,
  completeImageGeneration,
  extractIntroMemoryGraphForIngest,
  extractChatInterestSketchForIngest,
  extractAccessKeeper2EntriesFromTranscript,
  extractRulesKeeper3FromTranscript,
  extractRulesListStubsFromUserText,
  extractAccessExternalServiceStubsFromBulkListText,
  introUserNotesFallbackPack,
  normalizeIntroMemoryGraphForDb,
  generateThemeDialogTitle,
  PROVIDER_DISPLAY,
} from "./chatApi.js";
import { renderAssistantMarkdown } from "./markdown.js";
import { getModelApiKeys, hasAnyModelApiKey } from "./modelEnv.js";
import { setTheme } from "./theme.js";
import {
  closeMemoryTree,
  enrichMemoryGraphFromApi,
  initMemoryTree,
  memoryTreeCoversIntroChat,
  openMemoryTree,
  setMemoryGraphData,
} from "./memoryTree.js";
import { detectIntroMemoryTreeCommands } from "./introMemoryTreeCommands.js";
import {
  getIrPanelLockedSync,
  initIrPanelPinLock,
  openSetPinModal,
  openUnlockModal,
  refreshIrPanelLockFromApi,
} from "./irPanelPinLock.js";
import { closeAnalyticsView, initAnalyticsDashboard } from "./analyticsDashboard.js";
import {
  apiHealth,
  bootstrapThemeAndDialog,
  createDialogInTheme,
  deleteTheme,
  renameTheme,
  fetchAssistantFavorites,
  fetchContextPack,
  fetchIntroSession,
  fetchAccessSession,
  fetchRulesSession,
  fetchRulesKeeperBundle,
  mergeRulesKeeperPatch,
  clearDialogTurnsArchive,
  fetchAccessExternalServices,
  fetchAccessDataDumpEnrichment,
  fetchAccessExternalServicesCatalog,
  putAccessExternalServices,
  fetchMemoryGraphFromApi,
  fetchAnalytics,
  fetchThemesPayload,
  fetchTurns,
  ingestMemoryGraphPayload,
  requestTypeFromAttachMode,
  saveConversationTurn,
  setAssistantTurnFavorite,
  titleFromUserMessage,
} from "./chatPersistence.js";
import { buildModelContext } from "./contextEngine/buildModelContext.js";
import { fitContextToBudget } from "./contextEngine/fitContextToBudget.js";
import { fetchMemoryTreeSupplementForPrompt } from "./memoryTreeRouter.js";
import { renderThemeCards } from "./themesSidebar.js";
import {
  getFavoriteThemeIdSet,
  removeFavoriteThemeId,
  sortThemesFavoritesFirst,
  toggleFavoriteThemeId,
} from "./themeFavorites.js";
import {
  classifyComposerAttachmentKind,
  MAX_COMPOSER_ATTACHMENTS,
  prepareComposerAttachmentsForApi,
  revokeComposerAttachmentPreview,
} from "./composerAttachments.js";

const MAX_LOG_LINES = 400;
/** Upper bound for estimated input tokens when building thread context (before the model reply). */
const MF0_MAX_CONTEXT_INPUT_TOKENS = 12000;

/** Active conversation for DB persistence (null = new chat until first send). */
let activeThemeId = null;
let activeDialogId = null;

/** Intro section dialog (created by API `/api/intro/session`). */
let introSessionDialogId = null;

/** Access section dialog (created by API `/api/access/session`). */
let accessSessionDialogId = null;

/** Rules section dialog (created by API `/api/rules/session`). */
let rulesSessionDialogId = null;

async function ensureIntroSessionClient() {
  if (introSessionDialogId) return introSessionDialogId;
  const s = await fetchIntroSession();
  introSessionDialogId = s.dialogId;
  return introSessionDialogId;
}

async function ensureAccessSessionClient() {
  if (accessSessionDialogId) return accessSessionDialogId;
  const s = await fetchAccessSession();
  accessSessionDialogId = s.dialogId;
  return accessSessionDialogId;
}

async function ensureRulesSessionClient() {
  if (rulesSessionDialogId) return rulesSessionDialogId;
  const s = await fetchRulesSession();
  rulesSessionDialogId = s.dialogId;
  return rulesSessionDialogId;
}

async function loadIntroChatThreadIntoUi() {
  try {
    const s = await fetchIntroSession();
    introSessionDialogId = s.dialogId;
    const list = document.getElementById("messages-list");
    list?.replaceChildren();
    const turns = await fetchTurns(introSessionDialogId);
    replayDialogTurnsGrouped(turns);
    scrollMessagesToEnd();
    await loadMemoryGraphIntoUi();
  } catch (e) {
    appendActivityLog(`Intro: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function loadAccessChatThreadIntoUi() {
  try {
    const s = await fetchAccessSession();
    accessSessionDialogId = s.dialogId;
    const list = document.getElementById("messages-list");
    list?.replaceChildren();
    const turns = await fetchTurns(accessSessionDialogId);
    replayDialogTurnsGrouped(turns);
    scrollMessagesToEnd();
  } catch (e) {
    appendActivityLog(`Access: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function loadRulesChatThreadIntoUi() {
  try {
    const s = await fetchRulesSession();
    rulesSessionDialogId = s.dialogId;
    const list = document.getElementById("messages-list");
    list?.replaceChildren();
    const turns = await fetchTurns(rulesSessionDialogId);
    replayDialogTurnsGrouped(turns);
    scrollMessagesToEnd();
  } catch (e) {
    appendActivityLog(`Rules: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const ACCESS_ENTRY_NOTES_MAX = 12000;

/**
 * Merge Keeper 2 patches into the Access external-services list (key = normalized name).
 * @param {Array<{ id?: string, name?: string, description?: string, endpointUrl?: string, accessKey?: string, notes?: string, updatedAt?: string }>} existing
 * @param {Array<{ name?: string, description?: string, endpointUrl?: string, accessKey?: string, notes?: string }>} patch
 */
function mergeAccessExternalServiceEntries(existing, patch) {
  const map = new Map();
  const keyOf = (n) => String(n ?? "").trim().toLowerCase();
  for (const e of existing) {
    const k = keyOf(e.name);
    if (k) map.set(k, { ...e, notes: String(e.notes ?? "").trim() });
  }
  const now = new Date().toISOString();
  for (const p of patch) {
    const name = String(p.name ?? "").trim().slice(0, 200);
    if (!name) continue;
    const k = keyOf(name);
    const prev = map.get(k) ?? {};
    const id = String(prev.id ?? "").trim() || crypto.randomUUID();
    const patchNotes = String(p.notes ?? "").trim();
    const notesOut = patchNotes
      ? patchNotes.slice(0, ACCESS_ENTRY_NOTES_MAX)
      : String(prev.notes ?? "").trim().slice(0, ACCESS_ENTRY_NOTES_MAX);
    map.set(k, {
      id,
      name,
      description: String(p.description ?? prev.description ?? "").trim().slice(0, 2000),
      endpointUrl: String(p.endpointUrl ?? prev.endpointUrl ?? "").trim().slice(0, 2000),
      accessKey: String(p.accessKey ?? prev.accessKey ?? "").trim().slice(0, 2000),
      notes: notesOut,
      updatedAt: now,
    });
  }
  return [...map.values()].slice(0, 200);
}

/**
 * Short text-only summary of saved Rules buckets for the extractor prompt.
 * @param {{
 *   core_rules: { text?: string }[],
 *   private_rules: { text?: string }[],
 *   forbidden_actions: { text?: string }[],
 *   workflow_rules: { text?: string }[],
 * }} bundle
 */
function rulesKeeperExistingSummaryForExtract(bundle) {
  const slice = (arr, n) =>
    (Array.isArray(arr) ? arr : [])
      .slice(0, n)
      .map((x) => (x && typeof x === "object" ? String(x.text ?? "").trim() : String(x ?? "").trim()))
      .filter((s) => s.length > 0)
      .map((s) => s.slice(0, 120));
  return JSON.stringify({
    core_rules: slice(bundle.core_rules, 24),
    private_rules: slice(bundle.private_rules, 24),
    forbidden_actions: slice(bundle.forbidden_actions, 24),
    workflow_rules: slice(bundle.workflow_rules, 24),
  }).slice(0, 12000);
}

/**
 * @param {{
 *   core_rules: string[],
 *   private_rules: string[],
 *   forbidden_actions: string[],
 *   workflow_rules: string[],
 * }} a
 * @param {typeof a} b
 */
function mergeRulesKeeperClientPatches(a, b) {
  return {
    core_rules: [...(a.core_rules ?? []), ...(b.core_rules ?? [])],
    private_rules: [...(a.private_rules ?? []), ...(b.private_rules ?? [])],
    forbidden_actions: [...(a.forbidden_actions ?? []), ...(b.forbidden_actions ?? [])],
    workflow_rules: [...(a.workflow_rules ?? []), ...(b.workflow_rules ?? [])],
  };
}

function syncIrPanelVaultDom() {
  const chat = document.getElementById("main-chat");
  if (!chat) return;
  for (const panel of /** @type {const} */ (["intro", "rules", "access"])) {
    const gate = document.getElementById(`${panel}-vault-gate`);
    const vault = getIrPanelLockedSync(panel) && chat.classList.contains(`chat--${panel}`);
    chat.classList.toggle(`main-chat--${panel}-vault`, Boolean(vault));
    if (gate) {
      if (vault) {
        gate.removeAttribute("hidden");
        gate.setAttribute("aria-hidden", "false");
      } else {
        gate.setAttribute("hidden", "");
        gate.setAttribute("aria-hidden", "true");
      }
    }
  }
}

/**
 * @param {"intro"|"rules"|"access"} panel
 * @param {MouseEvent} e
 */
function handleIrPanelBubbleClick(panel, e) {
  const lockHit = e.target.closest(`#btn-ir-${panel} .sidebar-ir-lock-icon`);
  if (lockHit) {
    e.preventDefault();
    if (getIrPanelLockedSync(panel)) openUnlockModal(panel);
    else openSetPinModal(panel);
    return;
  }
  if (getIrPanelLockedSync(panel)) {
    const chat = document.getElementById("main-chat");
    if (chat?.classList.contains(`chat--${panel}`)) closeIrChatPanel();
    else openIrChatPanel(panel);
  } else {
    toggleIrChatPanel(panel);
  }
}

async function loadMemoryGraphIntoUi() {
  try {
    if (!(await apiHealth())) return;
    const raw = await fetchMemoryGraphFromApi();
    setMemoryGraphData(enrichMemoryGraphFromApi(raw));
  } catch (e) {
    appendActivityLog(`Memory graph: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const INTRO_COACH_SYSTEM_APPEND =
  "You are in the Intro section: the user is sharing about themselves so the project can remember them.\n" +
  "Do not behave like a generic Q&A assistant on unrelated topics; stay with the person and their context.\n" +
  "Tone: warm, respectful, curious — like a skilled psychologist: reflect, ask gentle follow-ups when helpful, invite them to say more.\n" +
  "If you still know very little about them, start with basics (how they want to be addressed, what matters now, what they do) before going deep.\n" +
  "When the user explicitly asks to **open**, **close**, or **refresh** the **Memory tree** (the 3D memory graph), the app runs that action automatically when possible: confirm briefly what happened, or say the graph is not ready yet if there is no data.\n" +
  "**Memory tree data:** You cannot edit the stored graph yourself. The **Keeper** runs after each turn and updates the tree from **the user's message alone** (not from your reply); do **not** tell the user you merged nodes, saved the graph, or did the Keeper's job — acknowledge in natural language only; the UI will change when that pipeline succeeds.";

const ACCESS_SECTION_SYSTEM_APPEND =
  "You are in the **Access** section: the user records **third-party** services they rely on — HTTP APIs, hosted inference or job-queue endpoints, geodata feeds, docs URLs, and **credentials those services require** (API keys, bearer tokens, `Authorization: …` lines).\n" +
  "**Only** out of scope here: keys or configuration for **this app’s chat LLM providers** (OpenAI, Anthropic, Google Gemini, Perplexity as in `.env`) and internal model routing — not user-managed external APIs.\n" +
  "When the user shares a third-party key or token for a named external product, **do not** refuse, lecture that you cannot store secrets, or pivot to generic tutorials unless they asked. The machine runs **Keeper 2** after each turn and merges structured rows into the **local** Access store (SQLite) from the transcript; you do not write the database yourself. Respond briefly and helpfully: acknowledge, confirm what you understood, ask only for missing fields — **never** claim the project cannot record what they pasted.\n" +
  "**What actually lands in the store:** only what Keeper 2 extracts into fixed fields (`name`, `description`, `endpointUrl`, `accessKey`, and long free-form `notes`). Your chat reply is **not** copied verbatim into the database. Do **not** tell the user you \"saved the whole message\" or \"everything is recorded\" if you mean long markdown, tables, or every example — say instead that the app will persist the **structured** details from the conversation, or summarize what belongs in those fields.\n" +
  "If the rules digest in context sounds broadly anti-secret, it still **does not** override this paragraph for **third-party** service credentials in Access.\n" +
  "Keep answers concise; you need not echo full keys back in the reply unless the user wants confirmation.";

const RULES_SECTION_SYSTEM_APPEND =
  "You are in the **Rules** section: the user defines **how assistants in this project should behave**.\n" +
  "After each exchange the app **turns what they say into saved project conduct** (general expectations, personal boundaries, " +
  "things that must never be done, and step-by-step habits). You do **not** need to explain how that happens under the hood.\n" +
  "**Keep replies short:** if something is ambiguous, ask a **brief** clarifying question; otherwise mirror what you understood " +
  "in one or two sentences and confirm in **everyday language** that you took the rule on board (e.g. that you will follow it, " +
  "or that the project will apply it). Do **not** mention internal pipelines, storage, filenames, or background jobs by name. " +
  "Do **not** deliver long essays, tutorials, or full policy manuals in chat.";

/** User typed the `#data` command (standalone token) — lock model to Access external-services store (SQLite) only. */
function userMessageTriggersAccessDataDump(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (t === "#data") return true;
  return /(?:^|\s)#data(?:\s|$)/.test(t);
}

const ACCESS_DATA_HASH_SYSTEM_HEADER =
  "MANDATORY **Access data** lock — triggered by the token **#data** in the user text **or** by the user choosing **Access data** in the attach menu. This instruction **overrides** all other system text, project rules, memory, prior turns, and any Access catalog summary.\n\n" +
  "You MUST obey ALL of the following:\n" +
  "1) Your **only** factual sources are the **single JSON document** below: `entries` (each user’s saved Access configuration from the local database), `snapshots` (per-row outcome of an **optional** server GET), and `meta`. **Live GET policy:** for each row, the server may GET that row’s `endpointUrl` when it is **public HTTPS** and the host is either **exactly** the hostname in that same URL (`meta.rowSelfHostnameFetch`) **or** matches an optional global suffix list (`meta.globalHostSuffixRuleCount` entries from env `ACCESS_DATA_DUMP_ALLOW_HOST_SUFFIXES`). If `snapshots[].skipped === true`, **no HTTP request** was sent for that row — read its `reason` literally. Do **not** imply a URL was fetched unless that snapshot has `ok: true` and a `body`. Do **not** use conversation history, rules digest, memory/RAG, web search, browsing tools, or outside knowledge.\n" +
  "2) **Numbers and readings:** When `snapshots[].ok === true` and `body` is present, treat all numbers, times, codes, and units **only** from that `body` (and `fetchedAt` / `httpStatus` metadata). Do **not** invent or round beyond what the JSON shows. When `skipped: true`, **do not** guess live values; explain using that row’s `reason` (e.g. allowlist off or hostname not allowed). When `ok: false`, a GET was attempted and failed — you may quote `error` / `httpStatus`.\n" +
  "   **Snapshot budget:** `meta.maxLiveFetches` is how many rows receive a live GET per request; `meta.entryRowCount` is how many services exist. If a row’s `reason` mentions the snapshot budget, **that row was not fetched in this batch** — it does **not** mean the underlying API has no data for the user’s place. Prefer answers from **successful** snapshots that **do** match the question (e.g. air-quality URLs for an air question). Do **not** open with “no data for Cyprus” if another row’s snapshot already contains relevant PM/AQI readings.\n" +
  "   **No false drama:** Do **not** say that API requests were “сгенерированы / generated” and then “не загрузились / failed to load” when the truth is **no request was sent** (`skipped`) or only some rows fetched. A skipped row is **not** a global outage — explain only what blocked **that** row; **do not** dump the whole `entries` list as consolation.\n" +
  "   **Scope honesty:** If the user asks for a **time range** (e.g. “last 14 days”) but the stored URL is clearly **latest-only** (e.g. `/v6/latest/…`) or only one dated snapshot exists, say plainly what the snapshot **can** show vs what would require a **different** documented URL (still under the same allowlist) or turning off Access data — **never** sound as if “the system refused” data that the configured endpoint simply does not return.\n" +
  "3) **Inference / image / video / upscale / job-queue requests** (anything that would require **calling** a third-party API from this chat, using credentials in `entries`): This mode **does not** execute POST calls, queues, or paid inference **from this app** — there is no agent step that performs HTTP with their key; you only **read** the injected `entries` plus GET `snapshots`. **Never** explain refusal by saying the service “does not support real-time data extraction”, “cannot extract data”, or that the request “failed” in that sense — that is the wrong frame.\n" +
  "   **Mandatory answer order** when the user asks for generation, editing, upscaling, or rendering: (1) **First** a short, practical block built **only** from `entries` — which row matches their ask, `endpointUrl`, and anything in `description` / `notes` (method, path, headers, JSON keys, queue URL). Do **not** invent hosts or tokens not present in the JSON. (2) **Then** one clear sentence that **you** cannot execute that call or return a new image **in this locked mode** (read-only snapshot). (3) **Optionally** suggest turning off **Access data** / **#data** for free-form help or image flows — but **never** skip step (1); a reply that is **only** refusal with no concrete detail from `entries` is **invalid**.\n" +
  "4) **Answer shape (not an API manual):** Use the **same language as the user’s message**. **Stay on topic:** deliver **only** what they asked (weather → forecast snapshot fields; air → air-quality snapshot fields; sea state → marine snapshot; etc.). Other `entries` / `snapshots` may inform your choice of row but **must not** appear in the visible answer unless the user explicitly asks for **all configured services**, a **full Access overview**, or **copy-paste URLs/keys**.\n" +
  "   • **If** they ask for environmental **measurements** and a matching snapshot has `ok: true` with `body`, reply with a **short** consumer block: bullets or a small table of **only** the requested readings (units and observation time from that `body` / snapshot metadata).\n" +
  "   • **If** there are **no** such snapshots for their question (e.g. image API / upscale), **do not** use a weather-style lead — answer directly from `entries` and snapshot status where relevant.\n" +
  "   • **Forbidden by default:** numbered “configured services” lists with links; sections titled like configured-services / available-APIs catalogs; repeating the same URL in prose **and** in a code block; dumping query strings or every row’s `endpointUrl`; long `[label](https://…)` link lines. **Optional:** at most **one** short line naming the matched row’s `name` (which feed the numbers came from). Raw URLs or keys **only** if the user explicitly asked for technical copy-paste — then **one** short fenced block, no duplicate.\n" +
  "   • **Do not** close with filler like «эти API могут быть использованы» — state facts or what is missing, briefly.\n" +
  "5) **Row selection:** Internally use the **minimal** set of rows that answers the question; do not inventory unrelated services.\n" +
  "6) **Secrets / URLs:** Do **not** print `accessKey` or full stored URLs unless the user explicitly asks for keys, headers, or exact endpoints.\n" +
  "7) **Catalog mode only:** If the user **clearly** asks to list everything, show the whole Access store, or describe every saved API, **then** give a structured per-row overview (still avoid duplicate URL spam).\n\n" +
  "JSON document:\n";

/** Which theme has its dialog list expanded; closes only via folder button or opening another theme's folder. */
let expandedThemeDialogListThemeId = null;

/** Send debounce: when true, ignore duplicate submits. Cleared in send `finally` and on theme/dialog change. */
let chatComposerSending = false;

/**
 * Attachments for the current message (before send).
 * @type {Array<{ id: string, file: File, kind: ReturnType<typeof classifyComposerAttachmentKind>, previewUrl?: string | null }>}
 */
let composerAttachmentRows = [];

/** Calendar dates everywhere as YYYY-MM-DD */
function formatDateYmd(d) {
  const x = d instanceof Date ? d : new Date(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

function formatLogTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${formatDateYmd(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** @type {{ id: string, t: number, text: string }[]} */
let activityLogLines = [];
let logId = 0;

function appendActivityLog(text) {
  const id = `log-${++logId}`;
  activityLogLines = [...activityLogLines.slice(-(MAX_LOG_LINES - 1)), { id, t: Date.now(), text }];
  renderActivityLog();
}

/** Short graph pack summary for the activity log (Keeper). */
function keeperPayloadSummary(pack, maxEntities = 8) {
  const entities = Array.isArray(pack?.entities) ? pack.entities : [];
  const links = Array.isArray(pack?.links) ? pack.links : [];
  const parts = entities.slice(0, maxEntities).map((e) => {
    const lab = String(e?.label ?? "").trim().slice(0, 40);
    const cat = String(e?.category ?? "").trim().slice(0, 24);
    return lab ? `${cat}/${lab}` : cat || "?";
  });
  const extra = entities.length > maxEntities ? ` (+more ${entities.length - maxEntities})` : "";
  const cmds = Array.isArray(pack?.commands) ? pack.commands.length : 0;
  const cmdPart = cmds ? `; cmds: ${cmds}` : "";
  const core = `${entities.length} nodes, ${links.length} edges${cmdPart}${parts.length ? ` — ${parts.join("; ")}${extra}` : ""}`;
  return core.length > 480 ? `${core.slice(0, 477)}...` : core;
}

/** Summary line from ingest response `commandsApplied`. */
function keeperIngestCommandsLine(ing) {
  const ca = ing?.commandsApplied;
  if (!ca || typeof ca !== "object") return "";
  const bits = ["mergeNodes", "deleteNode", "renameNode", "deleteEdge", "moveEdge", "skipped"]
    .map((k) => {
      const n = Number(ca[k]);
      return Number.isFinite(n) && n > 0 ? `${k}: ${n}` : "";
    })
    .filter(Boolean);
  return bits.length ? ` Commands: ${bits.join(", ")}.` : "";
}

/** "+" menu mode label for the activity log */
function attachModeLogLabel(mode) {
  const m = String(mode ?? "");
  if (m === "web") return "web search";
  if (m === "image") return "image";
  if (m === "research") return "deep research";
  if (m === "accessData") return "access data";
  return "default text";
}

/** First URL or data: from a markdown image `![](...)` */
function extractMarkdownImageSrc(markdown) {
  const m = String(markdown ?? "").match(/!\[[^\]]*\]\(\s*([^)]+?)\s*\)/);
  if (!m) return null;
  return m[1].trim().replace(/^<|>$/g, "");
}

/**
 * Copy a raster image to the clipboard (data: or http(s)).
 * @returns {Promise<boolean>}
 */
async function copyRasterImageToClipboard(src) {
  if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
    return false;
  }
  const writeBlob = async (blob) => {
    const mime =
      blob.type && /^image\//i.test(blob.type) ? blob.type : "image/png";
    await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
  };
  try {
    const res = await fetch(src, { mode: "cors", credentials: "omit" });
    if (!res.ok) return false;
    const blob = await res.blob();
    await writeBlob(blob);
    return true;
  } catch {
    /* try canvas path if host allows CORS for <img> */
  }
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("img"));
      im.src = src;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return false;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise((res, rej) => {
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/png");
    });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

function renderActivityLog() {
  const list = document.getElementById("activity-log-list");
  if (!list) return;
  list.replaceChildren(
    ...activityLogLines.map((line) => {
      const li = document.createElement("li");
      const time = document.createElement("span");
      time.className = "activity-log-time";
      time.textContent = `${formatLogTime(line.t)} `;
      li.appendChild(time);
      li.appendChild(document.createTextNode(line.text));
      return li;
    }),
  );
  const body = list.closest(".activity-log-body");
  if (body) body.scrollTop = body.scrollHeight;
}

function syncThemeIcons() {
  const dark = document.documentElement.classList.contains("dark");
  const sun = document.getElementById("icon-theme-sun");
  const moon = document.getElementById("icon-theme-moon");
  const btn = document.getElementById("btn-theme-toggle");
  if (sun && moon) {
    sun.classList.toggle("is-hidden", !dark);
    moon.classList.toggle("is-hidden", dark);
  }
  if (btn) {
    btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    btn.title = dark ? "Light theme" : "Dark theme";
  }
}

function initThemeToggle() {
  const btn = document.getElementById("btn-theme-toggle");
  if (!btn) return;
  syncThemeIcons();
  btn.addEventListener("click", () => {
    const isDark = document.documentElement.classList.contains("dark");
    setTheme(isDark ? "light" : "dark");
    syncThemeIcons();
    appendActivityLog(isDark ? "Theme: light" : "Theme: dark");
  });
}

/** @param {{ log?: boolean }} [options] — log=false: close only (e.g. after Clear already logged). */
function closeActivityPanel(options = {}) {
  const panel = document.getElementById("activity-log-panel");
  const toggleBtn = document.getElementById("btn-activity-toggle");
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  if (toggleBtn) {
    toggleBtn.setAttribute("aria-pressed", "false");
    toggleBtn.setAttribute("aria-label", "Show activity log");
  }
  if (options.log !== false) {
    appendActivityLog("Activity log: closed");
  }
}

function initActivityPanel() {
  const panel = document.getElementById("activity-log-panel");
  const toggleBtn = document.getElementById("btn-activity-toggle");
  const clearBtn = document.getElementById("activity-log-clear");
  const closeBtn = document.getElementById("activity-log-close");

  function setOpen(open) {
    if (!panel || !toggleBtn) return;
    panel.hidden = !open;
    toggleBtn.setAttribute("aria-pressed", open ? "true" : "false");
    toggleBtn.setAttribute("aria-label", open ? "Hide activity log" : "Show activity log");
  }

  toggleBtn?.addEventListener("click", () => {
    const show = panel?.hidden ?? true;
    setOpen(show);
    appendActivityLog(show ? "Activity log: opened" : "Activity log: hidden");
  });

  clearBtn?.addEventListener("click", () => {
    appendActivityLog("Activity log: cleared");
    activityLogLines = [];
    renderActivityLog();
    closeActivityPanel({ log: false });
  });

  closeBtn?.addEventListener("click", () => {
    closeActivityPanel();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!panel || panel.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    closeActivityPanel();
  });

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!panel || panel.hidden) return;
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (panel.contains(t)) return;
      if (toggleBtn && (toggleBtn === t || toggleBtn.contains(t))) return;
      closeActivityPanel();
    },
    true,
  );
}

/** @param {{ log?: boolean }} [options] — log=false: do not append to the log (e.g. when opening from a row). */
function closeFavoritesPanel(options = {}) {
  const panel = document.getElementById("favorites-panel");
  const toggleBtn = document.getElementById("btn-favorites");
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  if (toggleBtn) {
    toggleBtn.setAttribute("aria-pressed", "false");
    toggleBtn.setAttribute("aria-label", "Show favorites");
  }
  if (options.log !== false) {
    appendActivityLog("Favorites: closed");
  }
}

/**
 * Scroll the chat to the assistant reply with the given turn id (`data-turn-id` on `.msg-assistant`).
 * @param {string} turnId
 */
function scrollChatToAssistantTurn(turnId) {
  const tid = String(turnId ?? "").trim();
  const list = document.getElementById("messages-list");
  if (!tid || !list) return;
  const esc = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(tid) : tid;
  const el = list.querySelector(`.msg-assistant[data-turn-id="${esc}"]`);
  if (!el || !(el instanceof HTMLElement)) {
    scrollMessagesToEnd();
    return;
  }
  el.classList.add("msg-assistant--jump-highlight");
  window.setTimeout(() => {
    el.classList.remove("msg-assistant--jump-highlight");
  }, 2000);
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function renderFavoritesPanel() {
  const list = document.getElementById("favorites-list");
  if (!list) return;
  list.replaceChildren();
  /** @type {Array<{ turnId: string; dialogId: string; themeId: string; themeTitle: string; dialogTitle: string; userPreview?: string; markdown: string; assistantMessageAt: string }>} */
  let rows = [];
  try {
    rows = await fetchAssistantFavorites();
  } catch (e) {
    const li = document.createElement("li");
    li.className = "favorites-empty";
    li.textContent = e instanceof Error ? e.message : String(e);
    list.appendChild(li);
    return;
  }
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.className = "favorites-empty";
    li.textContent =
      "No saved replies yet — use the star on a model reply after the message is saved to the chat.";
    list.appendChild(li);
    return;
  }
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "favorites-item";
    const meta = document.createElement("div");
    meta.className = "favorites-item-meta";
    meta.textContent = [row.themeTitle, row.dialogTitle].filter(Boolean).join(" · ");
    const prev = document.createElement("div");
    prev.className = "favorites-item-preview";
    prev.textContent = row.userPreview || "(no preview)";
    const act = document.createElement("div");
    act.className = "favorites-item-actions";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "favorites-item-btn";
    openBtn.textContent = "Open thread";
    openBtn.addEventListener("click", async () => {
      await openDialogById(row.dialogId, row.themeId, row.turnId);
      closeFavoritesPanel({ log: false });
    });
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "favorites-item-btn";
    copyBtn.textContent = "Copy markdown";
    copyBtn.addEventListener("click", async () => {
      const md = String(row.markdown ?? "");
      const imgSrc = extractMarkdownImageSrc(md);
      if (imgSrc) {
        if (await copyRasterImageToClipboard(imgSrc)) {
          appendActivityLog("Favorites: image copied to clipboard");
          return;
        }
        appendActivityLog(
          "Favorites: could not copy image (network or browser limits); copied markdown text instead",
        );
      }
      await copyTextToClipboard(md);
    });
    act.appendChild(openBtn);
    act.appendChild(copyBtn);
    li.appendChild(meta);
    li.appendChild(prev);
    li.appendChild(act);
    list.appendChild(li);
  }
}

function initFavoritesPanel() {
  const panel = document.getElementById("favorites-panel");
  const toggleBtn = document.getElementById("btn-favorites");
  const closeBtn = document.getElementById("favorites-panel-close");

  function setOpen(open) {
    if (!panel || !toggleBtn) return;
    panel.hidden = !open;
    toggleBtn.setAttribute("aria-pressed", open ? "true" : "false");
    toggleBtn.setAttribute("aria-label", open ? "Hide favorites" : "Show favorites");
  }

  toggleBtn?.addEventListener("click", async () => {
    const show = Boolean(panel?.hidden);
    if (show) {
      setOpen(true);
      await renderFavoritesPanel();
      appendActivityLog("Favorites: opened");
    } else {
      closeFavoritesPanel();
    }
  });

  closeBtn?.addEventListener("click", () => {
    closeFavoritesPanel();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!panel || panel.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    closeFavoritesPanel();
  });

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!panel || panel.hidden) return;
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (panel.contains(t)) return;
      if (toggleBtn && (toggleBtn === t || toggleBtn.contains(t))) return;
      closeFavoritesPanel();
    },
    true,
  );
}

const versionEl = document.getElementById("app-version");
if (versionEl) {
  versionEl.textContent = `v${pkg.version ?? "0.0.1"}`;
}

/** Default order for picking the active provider */
const PROVIDER_ORDER = ["openai", "perplexity", "gemini-flash", "anthropic"];

function providerHasKey(keys, id) {
  return Boolean(String(keys[id] ?? "").trim());
}

/** Web search mode: Gemini → Perplexity → Claude → ChatGPT */
const WEB_SEARCH_PROVIDER_PRIORITY = [
  "gemini-flash",
  "perplexity",
  "anthropic",
  "openai",
];

/**
 * "+" button mode (attachment menu). For `web`, the API gets an expanded prompt with web-search instructions.
 * @type {string}
 */
let composerAttachMode = "";

/** Deep research mode: Perplexity → ChatGPT → Gemini → Claude */
const DEEP_RESEARCH_PROVIDER_PRIORITY = [
  "perplexity",
  "openai",
  "gemini-flash",
  "anthropic",
];

/** Create image mode: only providers with image-generation API */
const IMAGE_CREATION_PROVIDER_PRIORITY = ["openai", "gemini-flash"];

function setActiveProviderBadge(providerId) {
  const wrap = document.getElementById("model-badges");
  if (!wrap) return false;
  const target = wrap.querySelector(`[data-provider="${providerId}"]`);
  if (!target || target.disabled || target.classList.contains("badge--no-key")) {
    return false;
  }
  wrap.querySelectorAll("[data-provider]").forEach((b) => b.classList.remove("active"));
  target.classList.add("active");
  return true;
}

/** Activates the first provider in the priority list that has a key in .env */
function activateProviderForWebSearch() {
  const keys = getModelApiKeys();
  for (const id of WEB_SEARCH_PROVIDER_PRIORITY) {
    if (providerHasKey(keys, id) && setActiveProviderBadge(id)) {
      const label = PROVIDER_DISPLAY[id] ?? id;
      appendActivityLog(`Web search: using ${label}`);
      return;
    }
  }
  appendActivityLog(
    "Web search: no Gemini / Perplexity / Claude / ChatGPT keys in .env",
  );
}

function activateProviderForDeepResearch() {
  const keys = getModelApiKeys();
  for (const id of DEEP_RESEARCH_PROVIDER_PRIORITY) {
    if (providerHasKey(keys, id) && setActiveProviderBadge(id)) {
      const label = PROVIDER_DISPLAY[id] ?? id;
      appendActivityLog(`Deep research: using ${label}`);
      return;
    }
  }
  appendActivityLog(
    "Deep research: no Perplexity / ChatGPT / Gemini / Claude keys in .env",
  );
}

function activateProviderForImageCreation() {
  const keys = getModelApiKeys();
  for (const id of IMAGE_CREATION_PROVIDER_PRIORITY) {
    if (providerHasKey(keys, id) && setActiveProviderBadge(id)) {
      const label = PROVIDER_DISPLAY[id] ?? id;
      appendActivityLog(`Create image: using ${label}`);
      return;
    }
  }
  appendActivityLog("Create image: no ChatGPT or Gemini keys in .env");
}

/** In Create image mode, providers without image API are unavailable */
const IMAGE_MODE_DISABLED_PROVIDERS = new Set(["perplexity", "anthropic"]);

function refreshModelBadges() {
  const wrap = document.getElementById("model-badges");
  if (!wrap) return;
  const keys = getModelApiKeys();
  const buttons = [...wrap.querySelectorAll("[data-provider]")];

  for (const btn of buttons) {
    const id = btn.getAttribute("data-provider");
    if (!id) continue;
    btn.classList.remove("badge--mode-locked");
    if (!providerHasKey(keys, id)) {
      btn.classList.add("badge--no-key");
      btn.classList.remove("active");
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
      btn.removeAttribute("title");
      continue;
    }
    btn.classList.remove("badge--no-key");
    if (composerAttachMode === "image" && IMAGE_MODE_DISABLED_PROVIDERS.has(id)) {
      btn.classList.add("badge--mode-locked");
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
      btn.title = "In Create image mode only ChatGPT and Gemini are available";
    } else {
      btn.disabled = false;
      btn.removeAttribute("aria-disabled");
      btn.removeAttribute("title");
    }
  }

  const active = wrap.querySelector("[data-provider].active");
  if (active && active.disabled) {
    active.classList.remove("active");
    const order =
      composerAttachMode === "image" ? IMAGE_CREATION_PROVIDER_PRIORITY : PROVIDER_ORDER;
    const next = order
      .map((pid) => wrap.querySelector(`[data-provider="${pid}"]`))
      .find((b) => b && !b.disabled);
    next?.classList.add("active");
  }
}

function initProviderBadges() {
  const wrap = document.getElementById("model-badges");
  if (!wrap) return;

  const buttons = [...wrap.querySelectorAll("[data-provider]")];

  refreshModelBadges();

  for (const btn of buttons) {
    btn.classList.remove("active");
  }
  const firstOk = PROVIDER_ORDER.find((id) => {
    const b = wrap.querySelector(`[data-provider="${id}"]`);
    return b && !b.disabled;
  });
  if (firstOk) {
    wrap.querySelector(`[data-provider="${firstOk}"]`)?.classList.add("active");
  }

  wrap.addEventListener("click", (e) => {
    const t = e.target.closest("[data-provider]");
    if (!t || t.disabled || t.classList.contains("badge--no-key") || t.classList.contains("badge--mode-locked")) {
      return;
    }
    for (const b of buttons) {
      b.classList.remove("active");
    }
    t.classList.add("active");
    const pid = t.getAttribute("data-provider");
    appendActivityLog(`Model: ${PROVIDER_DISPLAY[pid] ?? pid ?? "—"}`);
  });
}

const THEME_DELETE_BODY_P1 =
  "If you delete this theme, all dialogs in it will be removed, along with message context and the details of conversations with AI agents.";
const THEME_DELETE_BODY_P2 =
  "However, rules and data stored in project memory will remain in the project structure, because it is not possible to extract them from what is being deleted.";

let themeDeleteModalCallback = null;

function closeThemeDeleteModal(confirmed) {
  const el = document.getElementById("theme-delete-modal");
  if (!el || el.hidden) return;
  el.hidden = true;
  document.documentElement.classList.remove("theme-delete-modal-open");
  const cb = themeDeleteModalCallback;
  themeDeleteModalCallback = null;
  if (cb) cb(Boolean(confirmed));
}

function ensureThemeDeleteModal() {
  let el = document.getElementById("theme-delete-modal");
  if (el) return el;

  el = document.createElement("div");
  el.id = "theme-delete-modal";
  el.className = "theme-delete-modal";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "theme-delete-modal-title");
  el.hidden = true;

  const backdrop = document.createElement("div");
  backdrop.className = "theme-delete-modal-backdrop";

  const panel = document.createElement("div");
  panel.className = "theme-delete-modal-panel";

  const title = document.createElement("h2");
  title.id = "theme-delete-modal-title";
  title.className = "theme-delete-modal-title";
  title.textContent = "Delete theme";

  const themeLine = document.createElement("p");
  themeLine.className = "theme-delete-modal-theme-line";

  const p1 = document.createElement("p");
  p1.className = "theme-delete-modal-text";
  p1.textContent = THEME_DELETE_BODY_P1;

  const p2 = document.createElement("p");
  p2.className = "theme-delete-modal-text";
  p2.textContent = THEME_DELETE_BODY_P2;

  const actions = document.createElement("div");
  actions.className = "theme-delete-modal-actions";

  const btnCancel = document.createElement("button");
  btnCancel.type = "button";
  btnCancel.className = "btn-ghost theme-delete-modal-btn-cancel";
  btnCancel.textContent = "Cancel";

  const btnDelete = document.createElement("button");
  btnDelete.type = "button";
  btnDelete.className = "theme-delete-modal-btn-delete";
  btnDelete.textContent = "Delete";

  actions.append(btnCancel, btnDelete);
  panel.append(title, themeLine, p1, p2, actions);
  el.append(backdrop, panel);

  backdrop.addEventListener("click", () => closeThemeDeleteModal(false));
  btnCancel.addEventListener("click", () => closeThemeDeleteModal(false));
  btnDelete.addEventListener("click", () => closeThemeDeleteModal(true));

  document.body.appendChild(el);
  return el;
}

function openThemeDeleteModal(themeTitle, onClose) {
  const el = ensureThemeDeleteModal();
  themeDeleteModalCallback = onClose;
  const t = String(themeTitle ?? "").trim();
  const nameEl = el.querySelector(".theme-delete-modal-theme-line");
  if (nameEl) {
    nameEl.textContent = t ? `Theme: "${t}"` : "Theme: (untitled)";
  }
  el.hidden = false;
  document.documentElement.classList.add("theme-delete-modal-open");
  requestAnimationFrame(() => {
    el.querySelector(".theme-delete-modal-btn-delete")?.focus();
  });
}

const IR_CLEAR_THREAD_TITLE = "Clearing a thread";
const IR_CLEAR_THREAD_BODY =
  "All messages in this thread will be permanently deleted. All extracted data, decisions, and settings are already saved and will continue to be used by the system. If you want to change anything later, simply describe your changes in a new conversation — the system will update them accordingly. Confirm clearing?";

let irClearThreadModalCallback = null;

function closeIrClearThreadModal(confirmed) {
  const el = document.getElementById("ir-clear-thread-modal");
  if (!el || el.hidden) return;
  el.hidden = true;
  document.documentElement.classList.remove("theme-delete-modal-open");
  const cb = irClearThreadModalCallback;
  irClearThreadModalCallback = null;
  if (cb) cb(Boolean(confirmed));
}

function ensureIrClearThreadModal() {
  let el = document.getElementById("ir-clear-thread-modal");
  if (el) return el;

  el = document.createElement("div");
  el.id = "ir-clear-thread-modal";
  el.className = "theme-delete-modal ir-clear-thread-modal";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "ir-clear-thread-modal-title");
  el.hidden = true;

  const backdrop = document.createElement("div");
  backdrop.className = "theme-delete-modal-backdrop";

  const panel = document.createElement("div");
  panel.className = "theme-delete-modal-panel";

  const title = document.createElement("h2");
  title.id = "ir-clear-thread-modal-title";
  title.className = "theme-delete-modal-title";
  title.textContent = IR_CLEAR_THREAD_TITLE;

  const body = document.createElement("p");
  body.className = "theme-delete-modal-text";
  body.textContent = IR_CLEAR_THREAD_BODY;

  const actions = document.createElement("div");
  actions.className = "theme-delete-modal-actions";

  const btnCancel = document.createElement("button");
  btnCancel.type = "button";
  btnCancel.className = "btn-ghost theme-delete-modal-btn-cancel";
  btnCancel.textContent = "Cancel";

  const btnClear = document.createElement("button");
  btnClear.type = "button";
  btnClear.className = "theme-delete-modal-btn-delete";
  btnClear.textContent = "Clear";

  actions.append(btnCancel, btnClear);
  panel.append(title, body, actions);
  el.append(backdrop, panel);

  backdrop.addEventListener("click", () => closeIrClearThreadModal(false));
  btnCancel.addEventListener("click", () => closeIrClearThreadModal(false));
  btnClear.addEventListener("click", () => closeIrClearThreadModal(true));

  document.body.appendChild(el);
  return el;
}

function openIrClearThreadModal(onClose) {
  const el = ensureIrClearThreadModal();
  irClearThreadModalCallback = onClose;
  el.hidden = false;
  document.documentElement.classList.add("theme-delete-modal-open");
  requestAnimationFrame(() => {
    el.querySelector(".theme-delete-modal-btn-delete")?.focus();
  });
}

function initIrClearArchiveButton() {
  const btn = document.getElementById("btn-ir-panel-archive");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const chat = document.getElementById("main-chat");
    /** @type {"intro"|"rules"|"access"|null} */
    let panel = null;
    if (chat?.classList.contains("chat--intro")) panel = "intro";
    else if (chat?.classList.contains("chat--rules")) panel = "rules";
    else if (chat?.classList.contains("chat--access")) panel = "access";
    if (!panel) return;

    openIrClearThreadModal(async (confirmed) => {
      if (!confirmed) return;
      try {
        let dialogId = "";
        if (panel === "intro") dialogId = await ensureIntroSessionClient();
        else if (panel === "access") dialogId = await ensureAccessSessionClient();
        else dialogId = await ensureRulesSessionClient();
        await clearDialogTurnsArchive(dialogId);
        if (panel === "intro") await loadIntroChatThreadIntoUi();
        else if (panel === "access") await loadAccessChatThreadIntoUi();
        else await loadRulesChatThreadIntoUi();
        appendActivityLog(
          `${panel === "intro" ? "Intro" : panel === "rules" ? "Rules" : "Access"}: thread cleared.`,
        );
      } catch (err) {
        appendActivityLog(`Clear thread: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });
}

let themeRenameModalCallback = null;

function closeThemeRenameModal(result) {
  const el = document.getElementById("theme-rename-modal");
  if (!el || el.hidden) return;
  el.hidden = true;
  document.documentElement.classList.remove("theme-rename-modal-open");
  const cb = themeRenameModalCallback;
  themeRenameModalCallback = null;
  if (cb) cb(result);
}

function syncThemeRenameSaveEnabled() {
  const el = document.getElementById("theme-rename-modal");
  if (!el || el.hidden) return;
  const input = el.querySelector(".theme-rename-modal-input");
  const saveBtn = el.querySelector(".theme-rename-modal-btn-save");
  if (!input || !saveBtn) return;
  const ok = String(input.value ?? "").trim().length > 0;
  saveBtn.disabled = !ok;
}

function ensureThemeRenameModal() {
  let el = document.getElementById("theme-rename-modal");
  if (el) return el;

  el = document.createElement("div");
  el.id = "theme-rename-modal";
  el.className = "theme-rename-modal";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "theme-rename-modal-title");
  el.hidden = true;

  const backdrop = document.createElement("div");
  backdrop.className = "theme-rename-modal-backdrop";

  const panel = document.createElement("div");
  panel.className = "theme-rename-modal-panel";
  panel.addEventListener("click", (e) => e.stopPropagation());

  const title = document.createElement("h2");
  title.id = "theme-rename-modal-title";
  title.className = "theme-rename-modal-title";
  title.textContent = "Rename theme";

  const label = document.createElement("label");
  label.className = "theme-rename-modal-label";
  label.setAttribute("for", "theme-rename-modal-field");
  label.textContent = "Theme name";

  const input = document.createElement("input");
  input.type = "text";
  input.id = "theme-rename-modal-field";
  input.className = "theme-rename-modal-input";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("maxlength", "200");

  const actions = document.createElement("div");
  actions.className = "theme-rename-modal-actions";

  const btnCancel = document.createElement("button");
  btnCancel.type = "button";
  btnCancel.className = "btn-ghost theme-rename-modal-btn-cancel";
  btnCancel.textContent = "Cancel";

  const btnSave = document.createElement("button");
  btnSave.type = "button";
  btnSave.className = "theme-rename-modal-btn-save";
  btnSave.textContent = "Save";

  actions.append(btnCancel, btnSave);
  panel.append(title, label, input, actions);
  el.append(backdrop, panel);

  backdrop.addEventListener("click", () => closeThemeRenameModal(null));
  btnCancel.addEventListener("click", () => closeThemeRenameModal(null));
  btnSave.addEventListener("click", () => {
    const v = String(input.value ?? "").trim();
    if (!v) return;
    closeThemeRenameModal(v);
  });
  input.addEventListener("input", () => syncThemeRenameSaveEnabled());
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const v = String(input.value ?? "").trim();
    if (!v) return;
    closeThemeRenameModal(v);
  });

  document.body.appendChild(el);
  return el;
}

function openThemeRenameModal(initialTitle, onClose) {
  const el = ensureThemeRenameModal();
  themeRenameModalCallback = onClose;
  const input = el.querySelector(".theme-rename-modal-input");
  if (input) {
    input.value = String(initialTitle ?? "");
    syncThemeRenameSaveEnabled();
  }
  el.hidden = false;
  document.documentElement.classList.add("theme-rename-modal-open");
  requestAnimationFrame(() => {
    input?.focus();
    input?.select();
  });
}

const IR_CHAT_PANELS = /** @type {const} */ ([
  { mode: "intro", className: "chat--intro", viewId: "chat-intro-view", btnId: "btn-ir-intro" },
  { mode: "rules", className: "chat--rules", viewId: "chat-rules-view", btnId: "btn-ir-rules" },
  { mode: "access", className: "chat--access", viewId: "chat-access-view", btnId: "btn-ir-access" },
]);

function irChatPanelIsOpen(chat) {
  return IR_CHAT_PANELS.some((p) => chat?.classList.contains(p.className));
}

/** @param {{ focusAfterClose?: boolean; focusButtonId?: string | null }} [options] */
function closeIrChatPanel(options = {}) {
  const chat = document.getElementById("main-chat");
  if (!chat || !irChatPanelIsOpen(chat)) return;
  let focusBtnId = null;
  if (options.focusAfterClose) {
    focusBtnId = options.focusButtonId;
    if (focusBtnId == null) {
      for (const p of IR_CHAT_PANELS) {
        if (chat.classList.contains(p.className)) {
          focusBtnId = p.btnId;
          break;
        }
      }
    }
  }
  for (const p of IR_CHAT_PANELS) {
    chat.classList.remove(p.className);
    document.getElementById(p.viewId)?.setAttribute("hidden", "");
    document.getElementById(p.viewId)?.setAttribute("aria-hidden", "true");
    document.getElementById(p.btnId)?.setAttribute("aria-expanded", "false");
  }
  if (focusBtnId) document.getElementById(focusBtnId)?.focus();
  syncIrPanelVaultDom();
}

function openIrChatPanel(mode) {
  const cfg = IR_CHAT_PANELS.find((p) => p.mode === mode);
  if (!cfg) return;
  closeAnalyticsView();
  closeMemoryTree();
  closeMobileThemesDropdown();
  activeThemeId = null;
  activeDialogId = null;
  expandedThemeDialogListThemeId = null;
  chatComposerSending = false;

  const chat = document.getElementById("main-chat");
  const view = document.getElementById(cfg.viewId);
  if (!chat || !view) return;

  chat.classList.remove("main-chat--intro-vault", "main-chat--rules-vault", "main-chat--access-vault");

  for (const p of IR_CHAT_PANELS) {
    chat.classList.remove(p.className);
    document.getElementById(p.viewId)?.setAttribute("hidden", "");
    document.getElementById(p.viewId)?.setAttribute("aria-hidden", "true");
    document.getElementById(p.btnId)?.setAttribute("aria-expanded", "false");
  }

  chat.classList.add(cfg.className);
  view.removeAttribute("hidden");
  view.setAttribute("aria-hidden", "false");
  document.getElementById(cfg.btnId)?.setAttribute("aria-expanded", "true");
  if (cfg.mode === "rules" || cfg.mode === "access") {
    resetComposerAttachUi();
  }
  void renderThemesSidebar();
  refreshThemeHighlightsFromChat();

  if (cfg.mode === "intro") {
    if (!getIrPanelLockedSync("intro")) {
      void loadIntroChatThreadIntoUi();
    }
  }
  if (cfg.mode === "rules") {
    if (!getIrPanelLockedSync("rules")) {
      void loadRulesChatThreadIntoUi();
    }
  }
  if (cfg.mode === "access") {
    if (!getIrPanelLockedSync("access")) {
      void loadAccessChatThreadIntoUi();
    }
  }
  syncIrPanelVaultDom();
}

function toggleIrChatPanel(mode) {
  const cfg = IR_CHAT_PANELS.find((p) => p.mode === mode);
  const chat = document.getElementById("main-chat");
  if (!cfg || !chat) return;
  if (chat.classList.contains(cfg.className)) closeIrChatPanel();
  else openIrChatPanel(mode);
}

function initIntroRulesAccessPanels() {
  document.getElementById("btn-ir-intro")?.addEventListener("click", (e) => handleIrPanelBubbleClick("intro", e));
  document.getElementById("btn-ir-rules")?.addEventListener("click", (e) => handleIrPanelBubbleClick("rules", e));
  document.getElementById("btn-ir-access")?.addEventListener("click", (e) => handleIrPanelBubbleClick("access", e));
}

async function handleThemeRenamed(themeId, oldTitle, newTitle) {
  const tid = String(themeId ?? "").trim();
  if (!tid) return;
  try {
    await renameTheme(tid, newTitle);
  } catch (e) {
    appendActivityLog(`Theme rename failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  appendActivityLog(`Theme renamed: "${String(oldTitle || "—").trim()}" → "${String(newTitle).trim()}"`);
  await renderThemesSidebar();
  refreshThemeHighlightsFromChat();
}

/** Theme row menu (hamburger): Favorites, Rename, Delete. */
function initThemeCardActions() {
  const root = document.getElementById("dialogue-cards");
  if (!root) return;

  function closeAllThemeActionMenus() {
    root.querySelectorAll(".dialog-theme-actions-menu").forEach((m) => {
      m.hidden = true;
    });
    root.querySelectorAll(".dialog-theme-menu-btn").forEach((b) => {
      b.setAttribute("aria-expanded", "false");
    });
  }

  root.addEventListener("click", (e) => {
    const tmb = e.target.closest(".dialog-theme-menu-btn");
    if (tmb && root.contains(tmb)) {
      e.preventDefault();
      e.stopPropagation();
      const wrap = tmb.closest(".dialog-card-theme-menu-wrap");
      const menuEl = wrap?.querySelector(".dialog-theme-actions-menu");
      if (!menuEl) return;
      const open = tmb.getAttribute("aria-expanded") === "true";
      if (open) {
        tmb.setAttribute("aria-expanded", "false");
        menuEl.hidden = true;
      } else {
        closeAllThemeActionMenus();
        tmb.setAttribute("aria-expanded", "true");
        menuEl.hidden = false;
      }
      return;
    }

    const actionBtn = e.target.closest("[data-theme-action]");
    if (actionBtn && root.contains(actionBtn)) {
      e.preventDefault();
      e.stopPropagation();
      const card = actionBtn.closest(".dialog-card");
      const themeTitle = card?.querySelector(".dialog-card-title")?.textContent?.trim() ?? "";
      const kind = actionBtn.getAttribute("data-theme-action");
      closeAllThemeActionMenus();

      if (kind === "favorites") {
        const themeId = String(card?.dataset.themeId ?? "").trim();
        if (!themeId) return;
        const on = toggleFavoriteThemeId(themeId);
        appendActivityLog(on ? "Theme: added to favorites" : "Theme: removed from favorites");
        void renderThemesSidebar();
      } else if (kind === "rename") {
        const themeId = String(card?.dataset.themeId ?? "").trim();
        if (!themeId) return;
        openThemeRenameModal(themeTitle, (newTitle) => {
          if (newTitle == null) return;
          void handleThemeRenamed(themeId, themeTitle, newTitle);
        });
      } else if (kind === "delete") {
        const themeId = String(card?.dataset.themeId ?? "").trim();
        if (!themeId) return;
        openThemeDeleteModal(themeTitle, (confirmed) => {
          if (!confirmed) return;
          void handleThemeDeleted(themeId, themeTitle);
        });
      }
    }
  });

  document.addEventListener(
    "click",
    (e) => {
      if (e.target.closest(".dialog-card-theme-menu-wrap")) return;
      closeAllThemeActionMenus();
    },
    true,
  );

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const renameModal = document.getElementById("theme-rename-modal");
    if (renameModal && !renameModal.hidden) {
      e.preventDefault();
      closeThemeRenameModal(null);
      return;
    }
    const irClearModal = document.getElementById("ir-clear-thread-modal");
    if (irClearModal && !irClearModal.hidden) {
      e.preventDefault();
      closeIrClearThreadModal(false);
      return;
    }
    const irChat = document.getElementById("main-chat");
    if (irChat && irChatPanelIsOpen(irChat)) {
      e.preventDefault();
      let fid = null;
      for (const p of IR_CHAT_PANELS) {
        if (irChat.classList.contains(p.className)) {
          fid = p.btnId;
          break;
        }
      }
      closeIrChatPanel({ focusAfterClose: true, focusButtonId: fid });
      return;
    }
    const delModal = document.getElementById("theme-delete-modal");
    if (delModal && !delModal.hidden) {
      e.preventDefault();
      closeThemeDeleteModal(false);
      return;
    }
    closeAllThemeActionMenus();
  });
}

/** Collapse per-theme dialog lists; `exceptCard` — leave that card alone (opening folder on it). */
function collapseAllThemeDialogLists(exceptCard = null) {
  const root = document.getElementById("dialogue-cards");
  if (!root) return;
  root.querySelectorAll(".dialog-card").forEach((card) => {
    if (exceptCard != null && card === exceptCard) return;
    const btn = card.querySelector(".dialog-folder-btn");
    const menu = card.querySelector(".dialog-folder-menu");
    if (btn && menu) {
      btn.setAttribute("aria-expanded", "false");
      menu.hidden = true;
    }
  });
}

function initThemeFolderMenus() {
  const root = document.getElementById("dialogue-cards");
  if (!root) return;

  /* Dialog pick: use capture — otherwise events do not reach #dialogue-cards (stopPropagation on panel). */
  root.addEventListener(
    "click",
    (e) => {
      const item = e.target.closest(".dialog-folder-menu-item");
      if (!item || !root.contains(item)) return;
      const did = item.getAttribute("data-dialog-id");
      const tid = item.getAttribute("data-theme-id");
      if (did) {
        void openDialogById(did, tid || undefined);
      }
    },
    true,
  );

  root.addEventListener("click", (e) => {
    const item = e.target.closest(".dialog-folder-menu-item");
    if (item) {
      return;
    }

    const folderBtn = e.target.closest(".dialog-folder-btn");
    if (!folderBtn || !root.contains(folderBtn)) return;
    e.stopPropagation();
    const card = folderBtn.closest(".dialog-card");
    const menu = card?.querySelector(".dialog-folder-menu");
    if (!menu) return;
    const thisThemeId = String(card?.dataset?.themeId ?? "").trim();
    const open = folderBtn.getAttribute("aria-expanded") === "true";
    if (open) {
      folderBtn.setAttribute("aria-expanded", "false");
      menu.hidden = true;
      if (String(expandedThemeDialogListThemeId ?? "").trim() === thisThemeId) {
        expandedThemeDialogListThemeId = null;
      }
    } else {
      collapseAllThemeDialogLists(card);
      folderBtn.setAttribute("aria-expanded", "true");
      menu.hidden = false;
      expandedThemeDialogListThemeId = thisThemeId || null;
    }
  });
}

/** On narrow screens, closes the theme dropdown (otherwise it covers the input). Set in initDialoguesMenu. */
let closeMobileThemesDropdown = () => {};

function initDialoguesMenu() {
  const panel = document.getElementById("dialogues-panel");
  const btn = document.getElementById("btn-dialogues-menu");
  const cards = document.getElementById("dialogue-cards");
  if (!panel || !btn || !cards) return;

  const mq = window.matchMedia("(max-width: 767px)");

  function isMobile() {
    return mq.matches;
  }

  function syncCardsAria(open) {
    if (!isMobile()) {
      cards.removeAttribute("aria-hidden");
      return;
    }
    cards.setAttribute("aria-hidden", open ? "false" : "true");
  }

  function applyDesktop() {
    panel.classList.remove("dialogues-dropdown-open");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Open themes list");
    cards.removeAttribute("aria-hidden");
  }

  function setOpen(open) {
    if (!isMobile()) {
      applyDesktop();
      return;
    }
    panel.classList.toggle("dialogues-dropdown-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.setAttribute("aria-label", open ? "Close themes list" : "Open themes list");
    syncCardsAria(open);
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!isMobile()) return;
    const willOpen = !panel.classList.contains("dialogues-dropdown-open");
    setOpen(willOpen);
    appendActivityLog(willOpen ? "Themes (mobile): list opened" : "Themes (mobile): list closed");
  });

  panel.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  document.addEventListener("click", () => {
    if (isMobile() && panel.classList.contains("dialogues-dropdown-open")) {
      setOpen(false);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Escape" &&
      isMobile() &&
      panel.classList.contains("dialogues-dropdown-open")
    ) {
      setOpen(false);
      btn.focus();
    }
  });

  function onMqChange() {
    if (!isMobile()) {
      applyDesktop();
    } else {
      setOpen(false);
    }
  }

  mq.addEventListener("change", onMqChange);
  onMqChange();

  closeMobileThemesDropdown = () => {
    if (!isMobile()) return;
    if (panel.classList.contains("dialogues-dropdown-open")) {
      setOpen(false);
    }
  };
}

const ATTACH_TITLES = {
  "": "Add",
  files: "Add photos & files",
  image: "Create image",
  research: "Deep research",
  web: "Web search",
  accessData: "Access data",
};

const SVG_NS = "http://www.w3.org/2000/svg";

function elSvg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) el.setAttribute(k, String(v));
  }
  return el;
}

function composerAttachmentIconSvg(kind) {
  const svg = elSvg("svg", {
    viewBox: "0 0 24 24",
    width: "22",
    height: "22",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  });
  if (kind === "document") {
    for (const d of [
      "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
      "M14 2v6h6",
      "M16 13H8",
      "M16 17H8",
      "M10 9H8",
    ]) {
      const p = elSvg("path", { d });
      svg.appendChild(p);
    }
  } else if (kind === "code") {
    svg.appendChild(elSvg("circle", { cx: "12", cy: "12", r: "3" }));
    svg.appendChild(
      elSvg("path", {
        d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .26.1.51.29.7A1.65 1.65 0 0 0 21 10.09V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.51-1z",
      }),
    );
  } else {
    for (const d of [
      "M4 6h16v10H4z",
      "M8 21h8",
      "M9 16v5",
      "M15 16v5",
      "M8 10h2",
      "M14 10h2",
    ]) {
      svg.appendChild(elSvg("path", { d }));
    }
  }
  return svg;
}

/** Attachment icon on a sent message (no preview — outline only, like document/gear/server). */
function userMessageAttachmentGlyph(kind) {
  if (kind === "image") {
    const svg = elSvg("svg", {
      viewBox: "0 0 24 24",
      width: "22",
      height: "22",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    });
    svg.appendChild(elSvg("rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", ry: "2" }));
    svg.appendChild(elSvg("circle", { cx: "9", cy: "9", r: "2" }));
    svg.appendChild(elSvg("path", { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" }));
    return svg;
  }
  return composerAttachmentIconSvg(kind);
}

function normalizeStoredUserAttachmentKind(k) {
  const s = String(k ?? "").toLowerCase();
  if (s === "image" || s === "document" || s === "code" || s === "other") return s;
  return "other";
}

function buildUserMessageCopyText(rawText, attachmentStrip, extras = {}) {
  const t = String(rawText ?? "").trim();
  const names = (attachmentStrip ?? [])
    .map((x) => String(x?.name ?? "").trim())
    .filter(Boolean);
  if (!t && extras.accessData) {
    return names.length ? `[Access data]\n\n${names.join("\n")}` : "[Access data]";
  }
  if (!t) return names.join("\n");
  if (!names.length) return t;
  return `${t}\n\n${names.join("\n")}`;
}

function clearComposerAttachmentRows() {
  for (const row of composerAttachmentRows) {
    revokeComposerAttachmentPreview(row);
  }
  composerAttachmentRows = [];
  renderComposerAttachmentsStrip();
  syncComposerSendButtonState();
}

function removeComposerAttachmentById(id) {
  const ix = composerAttachmentRows.findIndex((r) => r.id === id);
  if (ix < 0) return;
  const [row] = composerAttachmentRows.splice(ix, 1);
  revokeComposerAttachmentPreview(row);
  renderComposerAttachmentsStrip();
  syncComposerSendButtonState();
}

function renderComposerAttachmentsStrip() {
  const strip = document.getElementById("chat-attachments-strip");
  if (!strip) return;
  strip.replaceChildren();
  if (composerAttachmentRows.length === 0) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  for (const row of composerAttachmentRows) {
    const tile = document.createElement("div");
    tile.className = "chat-attach-tile";
    tile.dataset.attachmentId = row.id;

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "chat-attach-tile-remove";
    rm.setAttribute("aria-label", "Remove attachment");
    rm.textContent = "×";
    rm.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeComposerAttachmentById(row.id);
    });

    if (row.kind === "image" && row.previewUrl) {
      const img = document.createElement("img");
      img.className = "chat-attach-tile-preview";
      img.alt = row.file.name || "Image preview";
      img.src = row.previewUrl;
      tile.appendChild(rm);
      tile.appendChild(img);
    } else {
      const wrap = document.createElement("div");
      wrap.className = "chat-attach-tile-icon-wrap";
      wrap.appendChild(composerAttachmentIconSvg(row.kind));
      tile.appendChild(rm);
      tile.appendChild(wrap);
    }
    strip.appendChild(tile);
  }
}

function addComposerAttachmentsFromFileList(fileList) {
  const incoming = Array.from(fileList ?? []).filter((f) => f instanceof File);
  if (incoming.length === 0) return;
  const room = MAX_COMPOSER_ATTACHMENTS - composerAttachmentRows.length;
  if (room <= 0) {
    appendActivityLog(`Attachments: limit is ${MAX_COMPOSER_ATTACHMENTS} files.`);
    return;
  }
  const take = incoming.slice(0, room);
  if (take.length < incoming.length) {
    appendActivityLog(
      `Attachments: only ${take.length} file(s) added (max ${MAX_COMPOSER_ATTACHMENTS} total).`,
    );
  }
  for (const file of take) {
    const kind = classifyComposerAttachmentKind(file);
    /** @type {{ id: string, file: File, kind: typeof kind, previewUrl?: string | null }} */
    const row = {
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      file,
      kind,
      previewUrl: null,
    };
    if (kind === "image") {
      try {
        row.previewUrl = URL.createObjectURL(file);
      } catch {
        row.previewUrl = null;
      }
    }
    composerAttachmentRows.push(row);
  }
  renderComposerAttachmentsStrip();
  syncComposerSendButtonState();
}

function syncComposerSendButtonState() {
  const ta = document.getElementById("chat-input");
  const sendBtn = document.getElementById("btn-chat-send");
  if (!(ta instanceof HTMLTextAreaElement) || !sendBtn) return;
  if (chatComposerSending) return;
  const hasText = ta.value.trim().length > 0;
  const hasFiles = composerAttachmentRows.length > 0;
  const accessDataReady = composerAttachMode === "accessData";
  sendBtn.disabled = !hasText && !hasFiles && !accessDataReady;
}

/** Rules / Access: only plain text — reset attach menu and strip (same DOM as theme chat). */
function resetComposerAttachUi() {
  composerAttachMode = "";
  clearComposerAttachmentRows();
  const menu = document.getElementById("attach-menu");
  if (menu) menu.hidden = true;
  const attachBtn = document.getElementById("btn-attach-menu");
  if (attachBtn) {
    attachBtn.setAttribute("aria-expanded", "false");
    attachBtn.title = ATTACH_TITLES[""];
    attachBtn.setAttribute("aria-label", ATTACH_TITLES[""]);
    attachBtn.classList.remove("btn-attach-trigger--mode-active");
  }
  const visual = document.getElementById("btn-attach-visual");
  if (visual) {
    visual.textContent = "+";
    visual.classList.remove("btn-attach-visual--icon");
  }
  const resetBtn = document.getElementById("attach-menu-reset");
  if (resetBtn) resetBtn.hidden = true;
  const resetSep = document.querySelector(".attach-menu-reset-sep");
  if (resetSep instanceof HTMLElement) resetSep.hidden = true;
  refreshModelBadges();
  syncComposerSendButtonState();
}

function initNewDialogueButton() {
  const btn = document.getElementById("btn-new-dialogue");
  if (!btn) return;

  btn.addEventListener("click", () => {
    chatComposerSending = false;
    closeMobileThemesDropdown();
    closeAnalyticsView();
    closeMemoryTree();
    closeIrChatPanel();
    activeThemeId = null;
    activeDialogId = null;
    expandedThemeDialogListThemeId = null;
    const list = document.getElementById("messages-list");
    list?.replaceChildren();
    document.getElementById("dialogue-cards")?.querySelectorAll(".dialog-card").forEach((c) => {
      c.classList.remove("dialog-card--selected");
    });
    refreshThemeHighlightsFromChat();
    const viewport = document.getElementById("messages-viewport");
    if (viewport) viewport.scrollTop = 0;

    resetComposerAttachUi();

    const ta = document.getElementById("chat-input");
    const sendNew = document.getElementById("btn-chat-send");
    if (sendNew) sendNew.disabled = false;
    if (ta instanceof HTMLTextAreaElement) {
      ta.value = "";
      ta.disabled = false;
      syncChatInputHeight(ta);
      ta.focus();
    }
    appendActivityLog("New chat: cleared, new thread started");
  });
}

function initAttachMenu() {
  const btn = document.getElementById("btn-attach-menu");
  const menu = document.getElementById("attach-menu");
  const visual = document.getElementById("btn-attach-visual");
  const fileInput = document.getElementById("attach-file-input");
  const resetBtn = document.getElementById("attach-menu-reset");
  const resetSep = menu?.querySelector(".attach-menu-reset-sep");
  if (!btn || !menu || !visual) return;

  /** Plain text input only when the main button is no longer "+" (mode icon shown). */
  function syncResetRow() {
    const mainIsPlus = !visual.classList.contains("btn-attach-visual--icon");
    const show = !mainIsPlus;
    if (resetBtn) {
      resetBtn.hidden = !show;
    }
    if (resetSep) {
      resetSep.hidden = !show;
    }
  }

  function cloneMenuIconSvg(action) {
    const item = menu.querySelector(`[data-action="${action}"]`);
    const src = item?.querySelector(".attach-menu-icon svg");
    if (!src) return null;
    const svg = src.cloneNode(true);
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.removeAttribute("class");
    return svg;
  }

  function syncAttachButton() {
    if (!composerAttachMode) {
      visual.textContent = "+";
      visual.classList.remove("btn-attach-visual--icon");
    } else {
      const svg = cloneMenuIconSvg(composerAttachMode);
      visual.classList.add("btn-attach-visual--icon");
      if (svg) {
        visual.replaceChildren(svg);
      } else {
        visual.textContent = "+";
        visual.classList.remove("btn-attach-visual--icon");
      }
    }
    btn.title = ATTACH_TITLES[composerAttachMode] ?? ATTACH_TITLES[""];
    btn.setAttribute("aria-label", ATTACH_TITLES[composerAttachMode] ?? ATTACH_TITLES[""]);
    btn.classList.toggle(
      "btn-attach-trigger--mode-active",
      composerAttachMode === "web" ||
        composerAttachMode === "image" ||
        composerAttachMode === "research" ||
        composerAttachMode === "accessData",
    );
    syncResetRow();
  }

  function close() {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  }

  function open() {
    syncResetRow();
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hidden) {
      open();
    } else {
      close();
    }
  });

  menu.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  menu.querySelectorAll("[data-action]").forEach((item) => {
    item.addEventListener("click", () => {
      const action = item.getAttribute("data-action");
      if (action === "reset") {
        composerAttachMode = "";
        syncAttachButton();
        refreshModelBadges();
        appendActivityLog('Attach menu: default input');
        close();
        return;
      }

      if (action === "files") {
        fileInput?.click();
        appendActivityLog("Add photos & files: file picker opened");
        refreshModelBadges();
        close();
        return;
      }

      composerAttachMode = action ?? "";
      syncAttachButton();

      if (action === "image") {
        appendActivityLog('Attach menu: Create image');
        activateProviderForImageCreation();
        appendActivityLog("In this mode only ChatGPT and Gemini are available (other models disabled)");
      } else if (action === "research") {
        appendActivityLog('Attach menu: Deep research');
        activateProviderForDeepResearch();
      } else if (action === "web") {
        appendActivityLog('Attach menu: Web search');
        activateProviderForWebSearch();
      } else if (action === "accessData") {
        clearComposerAttachmentRows();
        appendActivityLog("Attach menu: Access data");
      }
      refreshModelBadges();
      close();
    });
  });

  fileInput?.addEventListener("change", () => {
    const n = fileInput.files?.length ?? 0;
    if (n > 0) {
      addComposerAttachmentsFromFileList(fileInput.files);
      appendActivityLog(`Add photos & files: ${n} file(s) selected`);
    }
    fileInput.value = "";
  });

  document.addEventListener("click", () => {
    if (!menu.hidden) close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      close();
      btn.focus();
    }
  });

  syncAttachButton();
}

const CHAT_MAX_LINES = 20;

function getActiveProviderId() {
  const el = document.querySelector("#model-badges .badge.active[data-provider]");
  if (!el || el.disabled || el.classList.contains("badge--no-key")) return null;
  return el.getAttribute("data-provider");
}

/** API prompt text: in Web search mode, append instructions to search from the user's input. */
function buildChatPromptForApi(userText, mode) {
  const t = String(userText ?? "").trim();
  if (mode === "accessData") {
    return t || "(Access data — follow the locked system JSON for this reply.)";
  }
  if (!t) return t;
  if (mode === "web") {
    return (
      "Search the web for the following user request and answer using up-to-date information. " +
      "Include sources (links) when possible.\n\n" +
      "User request:\n" +
      t
    );
  }
  if (mode === "research") {
    return (
      "Perform a deep research response to the following request. " +
      "Use current, verifiable information where relevant (search and cite sources when you use them). " +
      "Structure the answer clearly (brief overview, then sections as needed). " +
      "Compare alternatives or trade-offs when applicable, note uncertainties, and end with concise takeaways.\n\n" +
      "Research request:\n" +
      t
    );
  }
  return t;
}

function syncChatInputHeight(ta) {
  if (!ta) return;
  const cs = getComputedStyle(ta);
  const fontSize = parseFloat(cs.fontSize) || 14;
  const lh = parseFloat(cs.lineHeight);
  const lineHeight = Number.isFinite(lh) && lh > 0 ? lh : fontSize * 1.25;
  const maxH = lineHeight * CHAT_MAX_LINES;
  ta.style.height = "auto";
  const sh = ta.scrollHeight;
  const minH = parseFloat(cs.minHeight) || 40;
  const next = Math.min(Math.max(sh, minH), maxH);
  ta.style.height = `${next}px`;
  ta.dataset.overflowY = sh > maxH + 0.5 ? "1" : "";
}

/** Double chevron (like AI reply): up = collapse / expanded, 180° rotation = expand */
function createBubbleChevronIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "msg-bubble-chevron-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ["m17 11-5-5-5-5", "m17 18-5-5-5-5"]) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    svg.appendChild(p);
  }
  return svg;
}

/** Circular arrow — try another model reply */
function createBubbleRetryIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "msg-bubble-retry-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute(
    "d",
    "M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16M21 21v-5h-5",
  );
  svg.appendChild(p);
  return svg;
}

function createCopyIcon(iconClass = "msg-bubble-copy-icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", iconClass);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  r.setAttribute("x", "9");
  r.setAttribute("y", "9");
  r.setAttribute("width", "13");
  r.setAttribute("height", "13");
  r.setAttribute("rx", "2");
  r.setAttribute("ry", "2");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1");
  svg.appendChild(r);
  svg.appendChild(p);
  return svg;
}

function createBubbleStarIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "msg-bubble-favorite-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("class", "msg-bubble-favorite-path");
  path.setAttribute("d", "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z");
  svg.appendChild(path);
  return svg;
}

/**
 * @param {HTMLElement} assistantWrap — `.msg.msg-assistant`
 */
function syncAssistantFavoriteStarButton(assistantWrap) {
  const btn = assistantWrap?.querySelector?.(".msg-bubble-favorite");
  if (!btn || !assistantWrap) return;
  const on = assistantWrap.dataset.assistantFavorite === "1";
  btn.classList.toggle("msg-bubble-favorite--on", on);
  btn.setAttribute("aria-label", on ? "Remove from Favorites" : "Add to Favorites");
  btn.title = on ? "Remove from Favorites" : "Add to Favorites";
  btn.disabled = !String(assistantWrap.dataset.turnId ?? "").trim();
}

/**
 * @param {HTMLElement} assistantWrap — `.msg.msg-assistant`
 */
function makeAssistantFavoriteStarButton(assistantWrap) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-bubble-action-btn msg-bubble-favorite";
  btn.appendChild(createBubbleStarIcon());
  syncAssistantFavoriteStarButton(assistantWrap);
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const tid = String(assistantWrap.dataset.turnId ?? "").trim();
    if (!tid) return;
    const currentlyOn = assistantWrap.dataset.assistantFavorite === "1";
    const nextOn = !currentlyOn;
    try {
      btn.disabled = true;
      const markdown = String(assistantWrap.dataset.assistantMarkdown ?? "");
      await setAssistantTurnFavorite(tid, { favorite: nextOn, markdown: nextOn ? markdown : "" });
      assistantWrap.dataset.assistantFavorite = nextOn ? "1" : "0";
      syncAssistantFavoriteStarButton(assistantWrap);
      appendActivityLog(nextOn ? "Reply: added to Favorites" : "Reply: removed from Favorites");
      const fp = document.getElementById("favorites-panel");
      if (fp && !fp.hidden) {
        void renderFavoritesPanel();
      }
    } catch (err) {
      appendActivityLog(`Favorites: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      syncAssistantFavoriteStarButton(assistantWrap);
    }
  });
  return btn;
}

/**
 * @param {HTMLElement | null} assistantWrap
 */
function syncAssistantRetryButton(assistantWrap) {
  const btn = assistantWrap?.querySelector?.(".msg-bubble-retry");
  if (!btn || !assistantWrap) return;
  const saved = Boolean(String(assistantWrap.dataset.turnId ?? "").trim());
  const allow = saved && !chatComposerSending;
  btn.disabled = !allow;
}

function syncAllAssistantRetryButtons() {
  document.querySelectorAll(".msg-assistant .msg-bubble-retry").forEach((b) => {
    const wrap = b.closest(".msg-assistant");
    if (wrap instanceof HTMLElement) syncAssistantRetryButton(wrap);
  });
}

/**
 * @param {HTMLElement} assistantWrap
 */
function findPrecedingUserMessageEl(assistantWrap) {
  let el = assistantWrap?.previousElementSibling ?? null;
  while (el instanceof HTMLElement) {
    if (el.classList.contains("msg-user")) return el;
    el = el.previousElementSibling;
  }
  return null;
}

/**
 * @param {HTMLElement} userEl
 */
function inferComposerAttachModeFromUserEl(userEl) {
  if (!userEl) return "";
  if (userEl.querySelector(".msg-user-access-data-badge")) return "accessData";
  if (userEl.querySelector(".msg-user-image-badge")) return "image";
  if (userEl.querySelector(".msg-user-research-badge")) return "research";
  if (userEl.querySelector(".msg-user-web-badge")) return "web";
  return "";
}

/**
 * Сколько ответов ассистента уже есть под этим сообщением пользователя (до следующего user).
 * @param {HTMLElement} userEl
 */
function countAssistantsInUserExchangeBlock(userEl) {
  let n = 0;
  let el = userEl.nextElementSibling;
  while (el instanceof HTMLElement) {
    if (el.classList.contains("msg-user")) break;
    if (el.classList.contains("msg-assistant")) n += 1;
    el = el.nextElementSibling;
  }
  return n;
}

/**
 * Последний пузырь ассистента в этом обмене (низ блока под user), или null.
 * @param {HTMLElement} userEl
 */
function findLastAssistantInUserExchangeBlock(userEl) {
  /** @type {HTMLElement | null} */
  let last = null;
  let el = userEl.nextElementSibling;
  while (el instanceof HTMLElement) {
    if (el.classList.contains("msg-user")) break;
    if (el.classList.contains("msg-assistant")) last = el;
    el = el.nextElementSibling;
  }
  return last;
}

/**
 * @param {HTMLElement} assistantWrap
 */
function makeAssistantRetryButton(assistantWrap) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-bubble-action-btn msg-bubble-retry";
  btn.setAttribute("aria-label", "Try another reply");
  btn.title = "Try another reply";
  btn.appendChild(createBubbleRetryIcon());
  syncAssistantRetryButton(assistantWrap);
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void retryAssistantReply(assistantWrap);
  });
  return btn;
}

/**
 * Request another assistant reply for the same user message (new bubble below).
 * @param {HTMLElement} clickedAssistantWrap
 */
async function retryAssistantReply(clickedAssistantWrap) {
  if (!(clickedAssistantWrap instanceof HTMLElement) || chatComposerSending) return;
  const rootClone = String(
    clickedAssistantWrap.dataset.exchangeRootTurnId || clickedAssistantWrap.dataset.turnId || "",
  ).trim();
  if (!rootClone) {
    appendActivityLog("Reply: save the message first, then you can try another reply.");
    return;
  }
  const mainChatEl = document.getElementById("main-chat");
  const introChatOpen = Boolean(mainChatEl?.classList.contains("chat--intro"));
  const rulesChatOpen = Boolean(mainChatEl?.classList.contains("chat--rules"));
  const accessChatOpen = Boolean(mainChatEl?.classList.contains("chat--access"));
  let persistDialogId = String(activeDialogId ?? "").trim();
  if (introChatOpen) {
    try {
      persistDialogId = await ensureIntroSessionClient();
    } catch {
      persistDialogId = "";
    }
  } else if (accessChatOpen) {
    try {
      persistDialogId = await ensureAccessSessionClient();
    } catch {
      persistDialogId = "";
    }
  } else if (rulesChatOpen) {
    try {
      persistDialogId = await ensureRulesSessionClient();
    } catch {
      persistDialogId = "";
    }
  }
  if (!persistDialogId) {
    appendActivityLog("Reply: open a saved conversation to try another reply.");
    return;
  }
  const userEl = findPrecedingUserMessageEl(clickedAssistantWrap);
  if (!userEl) {
    appendActivityLog("Reply: could not find the user message for this answer.");
    return;
  }
  const persistUserText = String(userEl.dataset.userMessageRaw ?? "").trim();
  const modeForSend = inferComposerAttachModeFromUserEl(userEl);
  if (modeForSend === "image") {
    appendActivityLog("Reply: generated images cannot be retried from here.");
    return;
  }
  if (introChatOpen && getIrPanelLockedSync("intro")) {
    appendActivityLog("Intro is locked — unlock it to retry.");
    return;
  }
  if (rulesChatOpen && getIrPanelLockedSync("rules")) {
    appendActivityLog("Rules is locked — unlock it to retry.");
    return;
  }
  if (accessChatOpen && getIrPanelLockedSync("access")) {
    appendActivityLog("Access is locked — unlock it to retry.");
    return;
  }
  if (
    mainChatEl &&
    irChatPanelIsOpen(mainChatEl) &&
    !introChatOpen &&
    !accessChatOpen &&
    !rulesChatOpen
  ) {
    closeIrChatPanel();
  }

  const providerId = getActiveProviderId();
  if (!providerId) {
    appendActivityLog("Chat → retry cancelled: no selected model with a key (.env)");
    return;
  }
  const keys = getModelApiKeys();
  const key = keys[providerId];
  if (!String(key ?? "").trim()) {
    appendActivityLog(
      `Chat → retry cancelled: no API key for ${PROVIDER_DISPLAY[providerId] ?? providerId}`,
    );
    return;
  }

  const modelLabel = PROVIDER_DISPLAY[providerId] ?? providerId;
  const accessDataDumpMode =
    modeForSend !== "image" &&
    (userMessageTriggersAccessDataDump(persistUserText) || modeForSend === "accessData");
  const promptForApi = buildChatPromptForApi(persistUserText, modeForSend);
  const newOrdinal = countAssistantsInUserExchangeBlock(userEl) + 1;

  const pending = appendAssistantPending();
  if (!pending) return;
  const anchorAfter = findLastAssistantInUserExchangeBlock(userEl);
  if (anchorAfter) {
    anchorAfter.insertAdjacentElement("afterend", pending);
  } else {
    userEl.insertAdjacentElement("afterend", pending);
  }
  pending.dataset.assistantWebSearch = modeForSend === "web" ? "1" : "";
  pending.dataset.assistantDeepResearch = modeForSend === "research" ? "1" : "";
  pending.dataset.exchangeRootTurnId = rootClone;
  pending.dataset.replyOrdinal = String(newOrdinal);

  const ta = document.getElementById("chat-input");
  const sendBtn = document.getElementById("btn-chat-send");

  chatComposerSending = true;
  syncAllAssistantRetryButtons();
  if (sendBtn) sendBtn.disabled = true;

  let fullText = "";
  try {
    appendActivityLog(`Chat → retry (reply #${newOrdinal}): ${attachModeLogLabel(modeForSend)}, model ${modelLabel}`);
    scrollMessagesToEnd();
    const chatOpts = await buildChatOptsForModelRequest({
      persistDialogId,
      promptForApi,
      providerId,
      key,
      modeForSend,
      accessDataDumpMode,
      chatAttachments: undefined,
      introChatOpen,
      accessChatOpen,
      rulesChatOpen,
    });
    let buf = "";
    try {
      fullText = await completeChatMessageStreaming(
        providerId,
        promptForApi,
        key,
        (piece) => {
          buf += piece;
          pending.dataset.assistantMarkdown = buf;
          const te = pending.querySelector(".msg-assistant-text");
          if (te) setAssistantMessageMarkdown(te, buf);
          if (pending) syncAssistantCopyButtonDuringStream(pending);
          scrollMessagesToEnd();
        },
        chatOpts,
      );
    } catch {
      appendActivityLog(`Chat: streaming unavailable on retry, full response (${modelLabel})`);
      const { text } = await completeChatMessage(providerId, promptForApi, key, chatOpts);
      fullText = text;
      const te = pending.querySelector(".msg-assistant-text");
      if (te) setAssistantMessageMarkdown(te, fullText);
      scrollMessagesToEnd();
    }
    finalizeAssistantBubble(
      pending,
      fullText,
      providerId,
      accessDataDumpMode ? "Access data" : undefined,
      newOrdinal,
    );
    appendActivityLog(
      `Chat ← retry #${newOrdinal}: text, model ${modelLabel}, reply chars: ${String(fullText).length}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fullText = msg;
    renderAssistantError(pending, msg);
    appendActivityLog(
      `Chat ← retry error, model ${modelLabel}: ${msg.length > 280 ? `${msg.slice(0, 280)}…` : msg}`,
    );
  } finally {
    chatComposerSending = false;
    if (sendBtn) sendBtn.disabled = false;
    syncComposerSendButtonState();
    syncAllAssistantRetryButtons();
    scrollMessagesToEnd();
    const assistantMessageAt = new Date().toISOString();
    const hadAssistantError = Boolean(pending?.classList.contains("msg-assistant--error"));
    const assistantOut =
      pending?.classList.contains("msg-assistant--error") && pending?.dataset?.assistantMarkdown
        ? String(pending.dataset.assistantMarkdown)
        : fullText;
    try {
      /** @type {Record<string, unknown>} */
      const turnPayload = {
        clone_user_from_turn_id: rootClone,
        assistant_text: assistantOut || null,
        requested_provider_id: providerId,
        responding_provider_id: providerId,
        assistant_message_at: assistantMessageAt,
        assistant_error: hadAssistantError ? 1 : 0,
      };
      const saveRes = await saveConversationTurn(persistDialogId, turnPayload);
      const tid =
        saveRes && typeof saveRes === "object" && saveRes.id != null ? String(saveRes.id) : "";
      if (pending && tid) {
        pending.dataset.turnId = tid;
        syncAssistantFavoriteStarButton(pending);
        syncAssistantRetryButton(pending);
      }
      await renderThemesSidebar();
    } catch (saveErr) {
      appendActivityLog(
        `Chat DB save (retry): ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
      );
    }
  }
}

async function copyTextToClipboard(text) {
  const t = String(text ?? "");
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {() => string} getText
 * @param {string | { label?: string; title?: string; tryCopyImageFromMarkdown?: boolean }} [labelOrOpts]
 */
function makeCopyButton(getText, labelOrOpts) {
  const opts =
    labelOrOpts != null && typeof labelOrOpts === "object"
      ? labelOrOpts
      : { label: typeof labelOrOpts === "string" ? labelOrOpts : undefined };
  const label = opts.label ?? "Copy to clipboard";
  const tryImg = Boolean(opts.tryCopyImageFromMarkdown);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-bubble-action-btn msg-bubble-copy";
  btn.setAttribute("aria-label", label);
  btn.title = opts.title ?? (tryImg ? "Copy image" : "Copy");
  btn.appendChild(createCopyIcon());
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = typeof getText === "function" ? getText() : getText;
    if (tryImg) {
      const src = extractMarkdownImageSrc(text);
      if (src && (await copyRasterImageToClipboard(src))) {
        return;
      }
      if (src) {
        appendActivityLog(
          "Clipboard: could not copy image (network or browser limits); copied reply text instead",
        );
      }
    }
    await copyTextToClipboard(text);
  });
  return btn;
}

/** Markdown code blocks: round copy button in the top-right corner */
function enhanceAssistantMarkdownCodeBlocks(root) {
  if (!root) return;
  root.querySelectorAll("pre").forEach((pre) => {
    if (pre.closest(".msg-md-code-block")) return;
    const wrap = document.createElement("div");
    wrap.className = "msg-md-code-block";
    pre.parentNode.insertBefore(wrap, pre);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msg-md-code-copy";
    btn.setAttribute("aria-label", "Copy code");
    btn.title = "Copy code";
    const icon = createCopyIcon("msg-md-code-copy-icon");
    icon.setAttribute("width", "14");
    icon.setAttribute("height", "14");
    btn.appendChild(icon);
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const code = pre.querySelector("code");
      const text = code != null ? code.textContent : pre.textContent;
      await copyTextToClipboard(text);
    });
    wrap.appendChild(btn);
    wrap.appendChild(pre);
  });
}

function updateUserExpandVisibility(msgEl, textEl, expandBtn) {
  const expanded = msgEl.classList.contains("msg-user--expanded");
  if (expanded) {
    msgEl.classList.remove("msg-user--no-expand");
    return;
  }
  const needs = textEl.scrollHeight > textEl.clientHeight + 1;
  msgEl.classList.toggle("msg-user--no-expand", !needs);
}

/** Web search icon (globe), same as in the attachment menu */
function createWebSearchBadgeIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  c.setAttribute("cx", "12");
  c.setAttribute("cy", "12");
  c.setAttribute("r", "10");
  const p1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p1.setAttribute("d", "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20");
  const p2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p2.setAttribute("d", "M2 12h20");
  svg.appendChild(c);
  svg.appendChild(p1);
  svg.appendChild(p2);
  return svg;
}

/** Create image icon (same as in the attachment menu) */
function createImageCreationBadgeIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  r.setAttribute("width", "18");
  r.setAttribute("height", "18");
  r.setAttribute("x", "3");
  r.setAttribute("y", "3");
  r.setAttribute("rx", "2");
  r.setAttribute("ry", "2");
  const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  c.setAttribute("cx", "9");
  c.setAttribute("cy", "9");
  c.setAttribute("r", "2");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21");
  svg.appendChild(r);
  svg.appendChild(c);
  svg.appendChild(p);
  return svg;
}

/** Access data (info-in-circle), same motif as attach menu */
function createAccessDataBadgeIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  c.setAttribute("cx", "12");
  c.setAttribute("cy", "12");
  c.setAttribute("r", "10");
  const p1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p1.setAttribute("d", "M12 16v-4");
  const p2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p2.setAttribute("d", "M12 8h.01");
  svg.appendChild(c);
  svg.appendChild(p1);
  svg.appendChild(p2);
  return svg;
}

/** Deep research icon (same as in the attachment menu) */
function createDeepResearchBadgeIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of [
    "M9 2h6v5H9z",
    "M9 7v2a4 4 0 0 0 8 0V7",
    "M6 18h12",
    "M10 18v4",
    "M14 18v4",
    "M8 13h8",
  ]) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

/**
 * @param {string} rawText
 * @param {string} modelLabel
 * @param {{
 *   webSearch?: boolean;
 *   imageCreation?: boolean;
 *   deepResearch?: boolean;
 *   accessData?: boolean;
 *   attachmentStrip?: Array<{ name: string; kind: string }>;
 * }} [options]
 */
function appendUserMessage(rawText, modelLabel, options) {
  const list = document.getElementById("messages-list");
  if (!list) return;

  const webSearch = Boolean(options?.webSearch);
  const imageCreation = Boolean(options?.imageCreation);
  const deepResearch = Boolean(options?.deepResearch);
  const accessData = Boolean(options?.accessData);
  const attachmentStrip = Array.isArray(options?.attachmentStrip) ? options.attachmentStrip : [];

  const msg = document.createElement("div");
  msg.className = "msg msg-user";
  msg.dataset.userMessageRaw = String(rawText ?? "");
  if (attachmentStrip.length) {
    msg.dataset.userAttachmentNames = attachmentStrip.map((x) => x.name).filter(Boolean).join(" ");
  }

  const head = document.createElement("div");
  head.className = "msg-user-head";
  if (webSearch) {
    const webBadge = document.createElement("span");
    webBadge.className = "msg-user-web-badge";
    webBadge.setAttribute("aria-label", "Web search");
    webBadge.title = "Web search";
    webBadge.appendChild(createWebSearchBadgeIcon());
    head.appendChild(webBadge);
  }
  if (imageCreation) {
    const imageBadge = document.createElement("span");
    imageBadge.className = "msg-user-image-badge";
    imageBadge.setAttribute("aria-label", "Create image");
    imageBadge.title = "Create image";
    imageBadge.appendChild(createImageCreationBadgeIcon());
    head.appendChild(imageBadge);
  }
  if (deepResearch) {
    const researchBadge = document.createElement("span");
    researchBadge.className = "msg-user-research-badge";
    researchBadge.setAttribute("aria-label", "Deep research");
    researchBadge.title = "Deep research";
    researchBadge.appendChild(createDeepResearchBadgeIcon());
    head.appendChild(researchBadge);
  }
  if (accessData) {
    const adBadge = document.createElement("span");
    adBadge.className = "msg-user-access-data-badge";
    adBadge.setAttribute("aria-label", "Access data");
    adBadge.title = "Access data";
    adBadge.appendChild(createAccessDataBadgeIcon());
    head.appendChild(adBadge);
  }
  const badge = document.createElement("span");
  badge.className = "msg-model-badge";
  badge.textContent = modelLabel;
  badge.setAttribute("aria-label", `Model: ${modelLabel}`);
  head.appendChild(badge);

  const content = document.createElement("div");
  content.className = "msg-user-content";

  if (attachmentStrip.length > 0) {
    const strip = document.createElement("div");
    strip.className = "msg-user-attachments";
    strip.setAttribute("aria-label", "Attached files");
    for (const item of attachmentStrip) {
      const tile = document.createElement("div");
      tile.className = "msg-user-attach-tile";
      const nm = String(item?.name ?? "file").trim() || "file";
      tile.title = nm;
      const wrap = document.createElement("div");
      wrap.className = "msg-user-attach-tile-icon-wrap";
      wrap.appendChild(userMessageAttachmentGlyph(normalizeStoredUserAttachmentKind(item?.kind)));
      tile.appendChild(wrap);
      strip.appendChild(tile);
    }
    content.appendChild(strip);
  }

  const textEl = document.createElement("div");
  textEl.className = "msg-user-text msg-user-text--clamped";
  const bodyText = String(rawText ?? "").trim();
  if (bodyText) {
    textEl.textContent = rawText;
  } else {
    textEl.classList.add("msg-user-text--placeholder");
    textEl.textContent = "";
  }

  const actions = document.createElement("div");
  actions.className = "msg-bubble-actions";
  const copyPlain = buildUserMessageCopyText(rawText, attachmentStrip, { accessData });
  actions.appendChild(makeCopyButton(() => copyPlain));

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "msg-bubble-action-btn msg-bubble-chevron";
  expandBtn.setAttribute("aria-expanded", "false");
  expandBtn.setAttribute("aria-label", "Expand message");
  expandBtn.title = "Expand / collapse";
  expandBtn.appendChild(createBubbleChevronIcon());

  expandBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const now = msg.classList.toggle("msg-user--expanded");
    expandBtn.setAttribute("aria-expanded", now ? "true" : "false");
    expandBtn.setAttribute("aria-label", now ? "Collapse message" : "Expand message");
    if (!now) {
      requestAnimationFrame(() => updateUserExpandVisibility(msg, textEl, expandBtn));
    } else {
      msg.classList.remove("msg-user--no-expand");
    }
  });

  actions.appendChild(expandBtn);

  content.appendChild(textEl);
  content.appendChild(actions);
  msg.appendChild(head);
  msg.appendChild(content);
  list.appendChild(msg);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => updateUserExpandVisibility(msg, textEl, expandBtn));
  });
}

/** Highlight theme cards in the sidebar when the theme title appears in the user's latest message. */
function refreshThemeHighlightsFromChat() {
  const cardsRoot = document.getElementById("dialogue-cards");
  if (!cardsRoot) return;
  cardsRoot.querySelectorAll(".dialog-card").forEach((card) => {
    card.classList.remove("dialog-card--mentioned");
  });

  const list = document.getElementById("messages-list");
  if (!list) return;
  const userMsgs = list.querySelectorAll(".msg-user");
  const last = userMsgs[userMsgs.length - 1];
  const textBody = last?.querySelector(".msg-user-text")?.textContent?.trim() ?? "";
  const names = String(last?.dataset?.userAttachmentNames ?? "").trim();
  const text = [textBody, names].filter(Boolean).join(" ").trim();
  if (!text) return;

  const norm = text.toLowerCase();
  cardsRoot.querySelectorAll(".dialog-card").forEach((card) => {
    const title = card.querySelector(".dialog-card-title")?.textContent?.trim() ?? "";
    if (title.length < 2) return;
    if (norm.includes(title.toLowerCase())) {
      card.classList.add("dialog-card--mentioned");
    }
  });
}

function scrollMessagesToEnd() {
  const el = document.getElementById("messages-viewport");
  if (el) el.scrollTop = el.scrollHeight;
}

function setAssistantMessageMarkdown(el, markdownSource) {
  if (!el) return;
  el.classList.remove("msg-assistant-text--thinking");
  el.classList.add("msg-assistant-text--md");
  el.innerHTML = renderAssistantMarkdown(markdownSource);
  enhanceAssistantMarkdownCodeBlocks(el);
}

function setAssistantMessagePlain(el, text) {
  if (!el) return;
  el.classList.remove("msg-assistant-text--md", "msg-assistant-text--thinking");
  el.textContent = text;
}

function appendAssistantPending() {
  const list = document.getElementById("messages-list");
  if (!list) return null;
  const wrap = document.createElement("div");
  wrap.className = "msg msg-assistant msg-assistant--pending";
  wrap.dataset.assistantMarkdown = "";
  const body = document.createElement("div");
  body.className = "msg-assistant-body";
  const textEl = document.createElement("div");
  textEl.className = "msg-assistant-text msg-assistant-text--thinking";
  const spin = document.createElement("span");
  spin.className = "msg-assistant-thinking-spinner";
  spin.setAttribute("aria-hidden", "true");
  const lab = document.createElement("span");
  lab.className = "msg-assistant-thinking-label";
  lab.textContent = "Thinking…";
  textEl.appendChild(spin);
  textEl.appendChild(lab);
  body.appendChild(textEl);
  wrap.appendChild(body);
  list.appendChild(wrap);
  return wrap;
}

/** Copy on AI reply only when the streaming buffer has at least one character. */
function syncAssistantCopyButtonDuringStream(wrap) {
  const body = wrap?.querySelector(".msg-assistant-body");
  if (!body) return;
  const md = wrap.dataset.assistantMarkdown ?? "";
  let actions = body.querySelector(".msg-bubble-actions");
  if (md.length === 0) {
    if (actions && !actions.querySelector(".msg-bubble-chevron")) {
      actions.remove();
    }
    return;
  }
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "msg-bubble-actions";
    body.appendChild(actions);
  }
  if (!actions.querySelector(".msg-bubble-favorite")) {
    actions.insertBefore(makeAssistantFavoriteStarButton(wrap), actions.firstChild);
  }
  if (!actions.querySelector(".msg-bubble-copy")) {
    actions.appendChild(makeCopyButton(() => wrap.dataset.assistantMarkdown ?? ""));
  }
  syncAssistantFavoriteStarButton(wrap);
}

function renderAssistantError(el, message) {
  if (!el) return;
  el.classList.remove("msg-assistant--pending");
  el.classList.add("msg-assistant--error");
  el.replaceChildren();
  delete el.dataset.assistantResponseKind;
  delete el.dataset.assistantWebSearch;
  delete el.dataset.assistantDeepResearch;
  el.dataset.assistantMarkdown = message;
  const body = document.createElement("div");
  body.className = "msg-assistant-body";
  const t = document.createElement("div");
  t.className = "msg-assistant-text";
  setAssistantMessagePlain(t, message);
  body.appendChild(t);
  if (String(message ?? "").length > 0) {
    const actions = document.createElement("div");
    actions.className = "msg-bubble-actions";
    actions.appendChild(makeAssistantFavoriteStarButton(el));
    actions.appendChild(makeCopyButton(() => el.dataset.assistantMarkdown ?? ""));
    body.appendChild(actions);
    syncAssistantFavoriteStarButton(el);
  }
  el.appendChild(body);
}

/**
 * After stream or full reply: copy; collapse chevron when more than 4 lines
 * @param {string} [modelHintOverride] — e.g. image generation model id
 * @param {number} [replyOrdinal] — 1 = first reply; 2+ shows "Reply #N" in footer
 */
function finalizeAssistantBubble(el, fullText, providerId, modelHintOverride, replyOrdinal = 1) {
  if (!el) return;
  el.classList.remove("msg-assistant--pending", "msg-assistant--error");
  el.querySelector(".msg-assistant-model")?.remove();

  el.dataset.assistantMarkdown = fullText;

  let body = el.querySelector(".msg-assistant-body");
  if (!body) {
    body = document.createElement("div");
    body.className = "msg-assistant-body";
    el.appendChild(body);
  }
  let textEl = body.querySelector(".msg-assistant-text");
  if (!textEl) {
    textEl = document.createElement("div");
    textEl.className = "msg-assistant-text";
    body.appendChild(textEl);
  }
  setAssistantMessageMarkdown(textEl, fullText);
  body.querySelector(".msg-bubble-actions")?.remove();
  body.classList.remove("msg-assistant-body--with-toggle");
  el.classList.remove("msg-assistant--collapsed");

  const hasChars = String(fullText ?? "").length > 0;
  const copyAsImage = el.dataset.assistantResponseKind === "image";
  const ord = Number(replyOrdinal) >= 2 ? Math.floor(Number(replyOrdinal)) : 0;
  const replySuffix = ord >= 2 ? ` · Reply #${ord}` : "";
  let actions = null;
  if (hasChars) {
    actions = document.createElement("div");
    actions.className = "msg-bubble-actions";
    actions.appendChild(makeAssistantFavoriteStarButton(el));
    if (!copyAsImage && !el.classList.contains("msg-assistant--error")) {
      actions.appendChild(makeAssistantRetryButton(el));
    }
    actions.appendChild(
      makeCopyButton(() => el.dataset.assistantMarkdown ?? "", {
        tryCopyImageFromMarkdown: copyAsImage,
        label: copyAsImage ? "Copy image to clipboard" : "Copy to clipboard",
        title: copyAsImage ? "Copy image" : "Copy",
      }),
    );
    body.appendChild(actions);
    syncAssistantFavoriteStarButton(el);
    syncAssistantRetryButton(el);
  }

  const meta = document.createElement("div");
  meta.className = "msg-assistant-model";
  const label = PROVIDER_DISPLAY[providerId] ?? providerId;
  const hint =
    modelHintOverride != null && String(modelHintOverride).trim()
      ? String(modelHintOverride).trim()
      : apiModelHint(providerId, {
          webSearch: el.dataset.assistantWebSearch === "1",
          deepResearch: el.dataset.assistantDeepResearch === "1",
        });
  meta.textContent = hint
    ? `Replied: ${label} · ${hint}${replySuffix}`
    : `Replied: ${label}${replySuffix}`;
  el.appendChild(meta);

  function assistantAnswerNeedsToggle(te) {
    const cs = getComputedStyle(te);
    const lh = parseFloat(cs.lineHeight);
    const fs = parseFloat(cs.fontSize);
    const lineH = Number.isFinite(lh) && lh > 0 ? lh : fs * 1.4;
    return te.scrollHeight > lineH * 4 + 2;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!assistantAnswerNeedsToggle(textEl)) return;
      body.classList.add("msg-assistant-body--with-toggle");
      if (!actions) {
        actions = document.createElement("div");
        actions.className = "msg-bubble-actions";
        body.appendChild(actions);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "msg-bubble-action-btn msg-bubble-chevron";
      btn.setAttribute("aria-expanded", "true");
      btn.setAttribute("aria-label", "Collapse reply");
      btn.title = "Collapse / expand";
      btn.appendChild(createBubbleChevronIcon());
      const retryBtn = actions.querySelector(".msg-bubble-retry");
      const copyBtn = actions.querySelector(".msg-bubble-copy");
      if (retryBtn) {
        actions.insertBefore(btn, retryBtn);
      } else if (copyBtn) {
        actions.insertBefore(btn, copyBtn);
      } else {
        actions.appendChild(btn);
      }
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const collapsed = el.classList.toggle("msg-assistant--collapsed");
        btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
        btn.setAttribute("aria-label", collapsed ? "Expand reply" : "Collapse reply");
      });
    });
  });
}

async function renderThemesSidebar() {
  const root = document.getElementById("dialogue-cards");
  if (!root) return;
  try {
    const data = await fetchThemesPayload();
    const favSet = getFavoriteThemeIdSet();
    const themes = sortThemesFavoritesFirst(data.themes ?? [], favSet);
    renderThemeCards(
      root,
      themes,
      activeDialogId,
      activeThemeId,
      (tid) => {
        void openThemeForNewDialog(tid);
      },
      expandedThemeDialogListThemeId,
      favSet,
    );
  } catch {
    root.replaceChildren();
  }
}

async function handleThemeDeleted(themeId, themeTitle) {
  const tid = String(themeId ?? "").trim();
  if (!tid) return;
  try {
    await deleteTheme(tid);
  } catch (e) {
    appendActivityLog(`Theme delete failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  appendActivityLog(`Theme deleted: "${String(themeTitle || "—").trim()}"`);
  removeFavoriteThemeId(tid);
  if (String(expandedThemeDialogListThemeId ?? "").trim() === tid) {
    expandedThemeDialogListThemeId = null;
  }
  if (String(activeThemeId ?? "").trim() === tid) {
    activeThemeId = null;
    activeDialogId = null;
    chatComposerSending = false;
    closeAnalyticsView();
    closeMemoryTree();
    closeIrChatPanel();
    document.getElementById("messages-list")?.replaceChildren();
    const viewport = document.getElementById("messages-viewport");
    if (viewport) viewport.scrollTop = 0;
    const ta = document.getElementById("chat-input");
    const sendBtn = document.getElementById("btn-chat-send");
    if (ta) ta.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
  }
  await renderThemesSidebar();
  refreshThemeHighlightsFromChat();
}

function replayTurnInChat(turn) {
  appendUserBubbleFromTurn(turn);
  const root = String(turn?.id ?? "").trim();
  appendAssistantBubbleFromTurn(turn, 1, root);
}

/** Theme selected: empty chat; first message creates a new dialog in that theme. */
async function openThemeForNewDialog(themeId) {
  const tid = String(themeId ?? "").trim();
  if (!tid) return;
  expandedThemeDialogListThemeId = tid;
  chatComposerSending = false;
  closeMobileThemesDropdown();
  activeThemeId = tid;
  activeDialogId = null;
  closeAnalyticsView();
  closeMemoryTree();
  closeIrChatPanel();
  const list = document.getElementById("messages-list");
  list?.replaceChildren();
  const viewport = document.getElementById("messages-viewport");
  if (viewport) viewport.scrollTop = 0;
  const taOpen = document.getElementById("chat-input");
  const sendOpen = document.getElementById("btn-chat-send");
  if (taOpen) taOpen.disabled = false;
  if (sendOpen) sendOpen.disabled = false;
  await renderThemesSidebar();
  scrollMessagesToEnd();
  refreshThemeHighlightsFromChat();
}

/**
 * @param {string} dialogId
 * @param {string} [themeId]
 * @param {string} [scrollToTurnId] — after loading the thread, scroll to the reply with this turn id
 */
async function openDialogById(dialogId, themeId, scrollToTurnId) {
  const did = String(dialogId ?? "").trim();
  if (!did) return;
  chatComposerSending = false;
  closeMobileThemesDropdown();
  activeDialogId = did;
  const t = themeId != null ? String(themeId).trim() : "";
  activeThemeId = t || activeThemeId;
  expandedThemeDialogListThemeId = String(activeThemeId ?? "").trim() || null;
  closeAnalyticsView();
  closeMemoryTree();
  closeIrChatPanel();
  const list = document.getElementById("messages-list");
  list?.replaceChildren();
  const viewport = document.getElementById("messages-viewport");
  if (viewport) viewport.scrollTop = 0;
  const taDlg = document.getElementById("chat-input");
  const sendDlg = document.getElementById("btn-chat-send");
  if (taDlg) taDlg.disabled = false;
  if (sendDlg) sendDlg.disabled = false;
  try {
    const turns = await fetchTurns(did);
    replayDialogTurnsGrouped(turns);
  } catch (e) {
    appendActivityLog(`Chat DB: could not load thread (${e instanceof Error ? e.message : String(e)})`);
  }
  await renderThemesSidebar();
  const scrollId = scrollToTurnId != null ? String(scrollToTurnId).trim() : "";
  if (scrollId) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollChatToAssistantTurn(scrollId));
    });
  } else {
    scrollMessagesToEnd();
  }
  refreshThemeHighlightsFromChat();
}

/**
 * @param {unknown} turn
 */
function userTurnGroupKey(turn) {
  const t = turn && typeof turn === "object" ? turn : {};
  return `${String(t.user_message_at ?? "")}\0${String(t.user_text ?? "")}`;
}

/**
 * @param {unknown} turn
 */
function appendUserBubbleFromTurn(turn) {
  const t = turn && typeof turn === "object" ? turn : {};
  const reqProvider = t.requested_provider_id;
  const modelLabel = PROVIDER_DISPLAY[reqProvider] ?? reqProvider;
  const rt = t.request_type || "default";
  /** @type {Array<{ name: string; kind: string }>} */
  let attachmentStrip = [];
  try {
    const j = JSON.parse(String(t.user_attachments_json ?? "null"));
    if (Array.isArray(j)) {
      attachmentStrip = j
        .filter((x) => x && typeof x === "object")
        .map((x) => ({
          name: String(x.name ?? "file").slice(0, 512),
          kind: normalizeStoredUserAttachmentKind(x.kind),
        }));
    }
  } catch {
    attachmentStrip = [];
  }
  appendUserMessage(t.user_text, modelLabel, {
    webSearch: rt === "web",
    imageCreation: rt === "image",
    deepResearch: rt === "research",
    accessData: rt === "access_data",
    attachmentStrip: attachmentStrip.length > 0 ? attachmentStrip : undefined,
  });
}

/**
 * @param {unknown} turn
 * @param {number} replyOrdinal
 * @param {string} exchangeRootTurnId
 */
function appendAssistantBubbleFromTurn(turn, replyOrdinal, exchangeRootTurnId) {
  const t = turn && typeof turn === "object" ? turn : {};
  const reqProvider = t.requested_provider_id;
  const respProvider = t.responding_provider_id || reqProvider;
  const modelLabel = PROVIDER_DISPLAY[reqProvider] ?? reqProvider;
  const rt = t.request_type || "default";
  const pending = appendAssistantPending();
  if (!pending) return;
  pending.dataset.turnId = String(t.id ?? "");
  pending.dataset.exchangeRootTurnId = String(exchangeRootTurnId || t.id || "").trim();
  pending.dataset.replyOrdinal = String(replyOrdinal);
  pending.dataset.assistantFavorite = Number(t.assistant_favorite) === 1 ? "1" : "0";
  const text = t.assistant_text;
  if (text != null && String(text).length > 0) {
    pending.dataset.assistantWebSearch = rt === "web" ? "1" : "";
    pending.dataset.assistantDeepResearch = rt === "research" ? "1" : "";
    if (rt === "image") pending.dataset.assistantResponseKind = "image";
    const te = pending.querySelector(".msg-assistant-text");
    setAssistantMessageMarkdown(te, text);
    const imgHint =
      rt === "image" ? apiImageGenerationModelHint(respProvider) : undefined;
    finalizeAssistantBubble(
      pending,
      text,
      respProvider,
      imgHint || undefined,
      replyOrdinal,
    );
  } else {
    renderAssistantError(pending, "No reply stored for this turn.");
  }
}

/** @param {unknown[]} turns */
function replayDialogTurnsGrouped(turns) {
  const arr = Array.isArray(turns) ? turns : [];
  let i = 0;
  while (i < arr.length) {
    const first = arr[i];
    if (!first || typeof first !== "object") {
      i += 1;
      continue;
    }
    const key = userTurnGroupKey(first);
    /** @type {unknown[]} */
    const group = [];
    while (i < arr.length && arr[i] && typeof arr[i] === "object" && userTurnGroupKey(arr[i]) === key) {
      group.push(arr[i]);
      i += 1;
    }
    const rootId = String((group[0] && group[0].id) ?? "").trim();
    appendUserBubbleFromTurn(group[0]);
    for (let k = 0; k < group.length; k += 1) {
      appendAssistantBubbleFromTurn(group[k], k + 1, rootId);
    }
  }
}

/**
 * Builds LLM options for a text chat turn (same path as submitChat).
 * @param {{
 *   persistDialogId: string | null,
 *   promptForApi: string,
 *   providerId: string,
 *   key: string,
 *   modeForSend: string,
 *   accessDataDumpMode: boolean,
 *   chatAttachments: { images: Array<{ mimeType: string, base64: string }> } | undefined,
 *   introChatOpen: boolean,
 *   accessChatOpen: boolean,
 *   rulesChatOpen: boolean,
 * }} p
 */
async function buildChatOptsForModelRequest(p) {
  const {
    persistDialogId,
    promptForApi,
    providerId,
    key,
    modeForSend,
    accessDataDumpMode,
    chatAttachments,
    introChatOpen,
    accessChatOpen,
    rulesChatOpen,
  } = p;
  const chatOpts = {
    webSearch: accessDataDumpMode ? false : modeForSend === "web",
    deepResearch: accessDataDumpMode ? false : modeForSend === "research",
  };
  if (chatAttachments && !accessDataDumpMode) {
    chatOpts.chatAttachments = chatAttachments;
  }
  if (persistDialogId && modeForSend !== "image") {
    try {
      if (accessDataDumpMode) {
        if (!(await apiHealth())) {
          chatOpts.systemInstruction = `${ACCESS_DATA_HASH_SYSTEM_HEADER}{"entries":[],"note":"MF0 local API offline — Access external-services store was not loaded."}`;
          chatOpts.llmMessages = [{ role: "user", content: promptForApi }];
          chatOpts.accessDataDumpMode = true;
          appendActivityLog("Chat: #data — API offline; locked prompt with empty-store notice only.");
        } else {
          const enriched = await fetchAccessDataDumpEnrichment().catch(() => ({
            entries: [],
            snapshots: [],
            meta: {
              globalHostSuffixRuleCount: 0,
              rowSelfHostnameFetch: true,
              maxLiveFetches: 48,
              entryRowCount: 0,
            },
          }));
          const entries = Array.isArray(enriched.entries) ? enriched.entries : [];
          const snapshots = Array.isArray(enriched.snapshots) ? enriched.snapshots : [];
          const meta =
            enriched.meta && typeof enriched.meta === "object"
              ? enriched.meta
              : {
                  globalHostSuffixRuleCount: 0,
                  rowSelfHostnameFetch: true,
                  maxLiveFetches: 48,
                  entryRowCount: entries.length,
                };
          const doc = { entries, snapshots, meta };
          let jsonBody = JSON.stringify(doc, null, 2);
          const maxJson = 88000;
          if (jsonBody.length > maxJson) {
            jsonBody = `${jsonBody.slice(0, maxJson)}\n…(truncated for request size)`;
          }
          chatOpts.systemInstruction = `${ACCESS_DATA_HASH_SYSTEM_HEADER}${jsonBody}`;
          chatOpts.llmMessages = [{ role: "user", content: promptForApi }];
          chatOpts.accessDataDumpMode = true;
          appendActivityLog(
            `Chat: #data — store + live JSON GET (max ${meta?.maxLiveFetches ?? "?"} / ${meta?.entryRowCount ?? "?"} rows; ${snapshots.filter((s) => s && s.ok).length}/${snapshots.length} OK); no thread/RAG/web.`,
          );
          if (import.meta.env.DEV) {
            globalThis.__MF0_LAST_CONTEXT_DEBUG__ = {
              accessDataDumpMode: true,
              entries: entries.length,
              snapshots: snapshots.length,
            };
          }
        }
      } else if (await apiHealth()) {
        const catalogPromise =
          accessChatOpen || rulesChatOpen
            ? Promise.resolve({ entries: [] })
            : fetchAccessExternalServicesCatalog().catch(() => ({ entries: [] }));
        const [pack, catalogRes, graphPayload] = await Promise.all([
          fetchContextPack(persistDialogId, promptForApi),
          catalogPromise,
          fetchMemoryGraphFromApi().catch(() => ({ nodes: [], links: [] })),
        ]);
        let memoryTreeSupplement = "";
        const graphNodes = Array.isArray(graphPayload?.nodes) ? graphPayload.nodes : [];
        if (
          graphNodes.length > 0 &&
          String(promptForApi ?? "").trim() &&
          !rulesChatOpen
        ) {
          try {
            memoryTreeSupplement = await fetchMemoryTreeSupplementForPrompt({
              userQuery: promptForApi,
              graph: graphPayload,
              allKeys: getModelApiKeys(),
              activeProviderId: providerId,
              activeApiKey: key,
            });
          } catch (rErr) {
            appendActivityLog(
              `Memory tree router: ${rErr instanceof Error ? rErr.message : String(rErr)}`,
            );
          }
        }
        const built = buildModelContext({
          threadId: persistDialogId,
          userPrompt: promptForApi,
          contextPack: pack,
          modelFlags: { recentMessageCount: 10 },
          accessServicesCatalog: catalogRes.entries ?? [],
          memoryTreeSupplement: memoryTreeSupplement || undefined,
        });
        const fitted = fitContextToBudget(built, MF0_MAX_CONTEXT_INPUT_TOKENS);
        let sysOut = fitted.systemInstruction;
        if (introChatOpen) {
          sysOut = [sysOut, INTRO_COACH_SYSTEM_APPEND].filter(Boolean).join("\n\n");
        } else if (accessChatOpen) {
          sysOut = [sysOut, ACCESS_SECTION_SYSTEM_APPEND].filter(Boolean).join("\n\n");
        } else if (rulesChatOpen) {
          sysOut = [sysOut, RULES_SECTION_SYSTEM_APPEND].filter(Boolean).join("\n\n");
        }
        chatOpts.systemInstruction = sysOut;
        chatOpts.llmMessages = fitted.messagesForApi;
        if (import.meta.env.DEV) {
          globalThis.__MF0_LAST_CONTEXT_DEBUG__ = fitted.debug;
        }
      }
    } catch (ctxErr) {
      appendActivityLog(
        `LLM context: single-turn fallback (${ctxErr instanceof Error ? ctxErr.message : String(ctxErr)})`,
      );
    }
  }
  if (!accessDataDumpMode && introChatOpen && modeForSend !== "image") {
    const cur = String(chatOpts.systemInstruction ?? "").trim();
    if (!cur) {
      chatOpts.systemInstruction = INTRO_COACH_SYSTEM_APPEND;
    } else if (!cur.includes("Intro section")) {
      chatOpts.systemInstruction = `${cur}\n\n${INTRO_COACH_SYSTEM_APPEND}`;
    }
  } else if (!accessDataDumpMode && accessChatOpen && modeForSend !== "image") {
    const curA = String(chatOpts.systemInstruction ?? "").trim();
    if (!curA) {
      chatOpts.systemInstruction = ACCESS_SECTION_SYSTEM_APPEND;
    } else if (!curA.includes("Access section")) {
      chatOpts.systemInstruction = `${curA}\n\n${ACCESS_SECTION_SYSTEM_APPEND}`;
    }
  } else if (!accessDataDumpMode && rulesChatOpen && modeForSend !== "image") {
    const curR = String(chatOpts.systemInstruction ?? "").trim();
    if (!curR) {
      chatOpts.systemInstruction = RULES_SECTION_SYSTEM_APPEND;
    } else if (!curR.includes("**Rules** section")) {
      chatOpts.systemInstruction = `${curR}\n\n${RULES_SECTION_SYSTEM_APPEND}`;
    }
  }
  return chatOpts;
}

function initChatComposer() {
  const ta = document.getElementById("chat-input");
  const sendBtn = document.getElementById("btn-chat-send");
  if (!ta || !sendBtn) return;

  syncChatInputHeight(ta);
  ta.addEventListener("input", () => {
    syncChatInputHeight(ta);
    syncComposerSendButtonState();
  });
  syncComposerSendButtonState();

  async function submitChat() {
    if (chatComposerSending) return;
    const trimmed = ta.value.trim();
    const modeForSend = composerAttachMode;
    const filesSnapshot = composerAttachmentRows.map((r) => r.file);
    if (!trimmed && filesSnapshot.length === 0 && modeForSend !== "accessData") return;

    const mainChatEl = document.getElementById("main-chat");
    const introChatOpen = Boolean(mainChatEl?.classList.contains("chat--intro"));
    /** Intro thread or Intro stashed under open Memory tree (DOM drops `chat--intro` while tree is open). */
    const introContextActive = introChatOpen || memoryTreeCoversIntroChat();
    const rulesChatOpen = Boolean(mainChatEl?.classList.contains("chat--rules"));
    const accessChatOpen = Boolean(mainChatEl?.classList.contains("chat--access"));
    if (introContextActive && getIrPanelLockedSync("intro")) {
      appendActivityLog("Intro is locked — unlock it to send messages.");
      return;
    }
    if (rulesChatOpen && getIrPanelLockedSync("rules")) {
      appendActivityLog("Rules is locked — unlock it to send messages.");
      return;
    }
    if (accessChatOpen && getIrPanelLockedSync("access")) {
      appendActivityLog("Access is locked — unlock it to send messages.");
      return;
    }
    if (
      mainChatEl &&
      irChatPanelIsOpen(mainChatEl) &&
      !introChatOpen &&
      !accessChatOpen &&
      !rulesChatOpen
    ) {
      closeIrChatPanel();
    }

    const providerId = getActiveProviderId();
    if (!providerId) {
      appendActivityLog("Chat → request cancelled: no selected model with a key (.env)");
      return;
    }

    const keys = getModelApiKeys();
    const key = keys[providerId];
    if (!String(key ?? "").trim()) {
      appendActivityLog(
        `Chat → request cancelled: no API key for ${PROVIDER_DISPLAY[providerId] ?? providerId}`,
      );
      return;
    }

    const modelLabel = PROVIDER_DISPLAY[providerId] ?? providerId;

    const persistUserText = trimmed;
    const accessDataDumpMode =
      modeForSend !== "image" &&
      (userMessageTriggersAccessDataDump(trimmed) || modeForSend === "accessData");

    const attachmentStripMeta =
      filesSnapshot.length > 0
        ? filesSnapshot.map((f) => ({
            name: f.name || "file",
            kind: classifyComposerAttachmentKind(f),
          }))
        : [];

    const titleSeed =
      trimmed.trim() ||
      (modeForSend === "accessData" ? "Access data" : "") ||
      (filesSnapshot.length > 0 ? filesSnapshot.map((f) => f.name || "file").join(", ") : "");

    const userMessageAt = new Date().toISOString();
    let persistDialogId = activeDialogId;
    if (introContextActive) {
      try {
        persistDialogId = await ensureIntroSessionClient();
      } catch (e) {
        appendActivityLog(`Intro session: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    if (accessChatOpen) {
      try {
        persistDialogId = await ensureAccessSessionClient();
      } catch (e) {
        appendActivityLog(`Access session: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    if (rulesChatOpen) {
      try {
        persistDialogId = await ensureRulesSessionClient();
      } catch (e) {
        appendActivityLog(`Rules session: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }

    let pending = null;
    let fullText = "";
    let didAppendUserToUi = false;

    chatComposerSending = true;
    syncAllAssistantRetryButtons();
    try {
      if (!persistDialogId) {
        try {
          /** New dialog in the already selected theme: no extra LLM call. New theme: title via LLM with timeout. */
          const themeIdForNewDialog = String(activeThemeId ?? "").trim();
          const bootTitle = themeIdForNewDialog
            ? titleFromUserMessage(titleSeed)
            : await Promise.race([
                generateThemeDialogTitle(providerId, titleSeed, key),
                new Promise((resolve) => {
                  setTimeout(() => resolve(titleFromUserMessage(titleSeed)), 12000);
                }),
              ]);
          if (themeIdForNewDialog) {
            const { dialog } = await createDialogInTheme(themeIdForNewDialog, bootTitle);
            activeThemeId = themeIdForNewDialog;
            activeDialogId = dialog.id;
            persistDialogId = dialog.id;
          } else {
            const { theme, dialog } = await bootstrapThemeAndDialog(bootTitle);
            activeThemeId = theme.id;
            activeDialogId = dialog.id;
            persistDialogId = dialog.id;
          }
          await renderThemesSidebar();
        } catch (bootErr) {
          appendActivityLog(
            `Chat DB: ${bootErr instanceof Error ? bootErr.message : String(bootErr)}`,
          );
          return;
        }
      }

      const attApi =
        filesSnapshot.length > 0
          ? await prepareComposerAttachmentsForApi(filesSnapshot)
          : { images: [], textAppend: "", filenames: [] };
      if (filesSnapshot.length > 0) {
        clearComposerAttachmentRows();
      }

      let promptForApi = buildChatPromptForApi(trimmed, modeForSend);
      if (attApi.textAppend) {
        promptForApi = promptForApi ? `${promptForApi}\n\n${attApi.textAppend}` : attApi.textAppend;
      }
      if (!String(promptForApi).trim() && attApi.images.length > 0) {
        promptForApi = "(See attached images.)";
      }

      /* Create image: API gets text only; attached images become an explicit note in the prompt. */
      if (modeForSend === "image" && attApi.images.length > 0) {
        const imgNames = attachmentStripMeta
          .filter((x) => x.kind === "image")
          .map((x) => x.name)
          .filter(Boolean)
          .join(", ");
        const note = `The user attached ${attApi.images.length} reference image(s): ${imgNames || "attached images"}. Use them as visual reference when generating.`;
        promptForApi = String(promptForApi).trim()
          ? `${String(promptForApi).trim()}\n\n${note}`
          : note;
      }

      /** @type {{ images: Array<{ mimeType: string, base64: string }> } | undefined} */
      const chatAttachments = attApi.images.length > 0 ? { images: attApi.images } : undefined;

      sendBtn.disabled = true;

      appendActivityLog(
        `Chat → request: ${attachModeLogLabel(modeForSend)}, model ${modelLabel}, input chars: ${trimmed.length}, attachments: ${filesSnapshot.length}`,
      );

      appendUserMessage(persistUserText, modelLabel, {
        webSearch: modeForSend === "web",
        imageCreation: modeForSend === "image",
        deepResearch: modeForSend === "research",
        accessData: modeForSend === "accessData",
        attachmentStrip: attachmentStripMeta.length > 0 ? attachmentStripMeta : undefined,
      });
      didAppendUserToUi = true;
      if (introContextActive && modeForSend !== "image") {
        const mt = detectIntroMemoryTreeCommands(persistUserText);
        if (mt.didTouchMemoryTreeTopic) {
          if (mt.close) closeMemoryTree();
          if (mt.open) openMemoryTree();
          if (mt.refresh && (await apiHealth())) {
            try {
              await loadMemoryGraphIntoUi();
            } catch {
              /* loadMemoryGraphIntoUi logs */
            }
          }
          if (mt.close || mt.open || mt.refresh) {
            appendActivityLog("Intro: Memory tree — action from your message applied.");
          }
        }
      }
      refreshThemeHighlightsFromChat();
      ta.value = "";
      syncChatInputHeight(ta);
      ta.focus();
      try {
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
      } catch {
        /* ignore */
      }
      scrollMessagesToEnd();

      pending = appendAssistantPending();
      if (pending) {
        pending.dataset.assistantWebSearch = modeForSend === "web" ? "1" : "";
        pending.dataset.assistantDeepResearch = modeForSend === "research" ? "1" : "";
        const te0 = pending.querySelector(".msg-assistant-text");
        if (te0 && modeForSend === "image") {
          setAssistantMessagePlain(te0, "Generating image…");
        }
      }
      scrollMessagesToEnd();

      try {
        if (pending) {
          delete pending.dataset.assistantResponseKind;
        }
        if (modeForSend === "image") {
          const imageGenOpts =
            attApi.images.length > 0 ? { chatAttachments: { images: attApi.images } } : {};
          const { text } = await completeImageGeneration(providerId, promptForApi, key, imageGenOpts);
          fullText = text;
          const te = pending?.querySelector(".msg-assistant-text");
          if (te) setAssistantMessageMarkdown(te, fullText);
          scrollMessagesToEnd();
          const imgHint = apiImageGenerationModelHint(providerId);
          if (pending) {
            pending.dataset.assistantResponseKind = "image";
          }
          finalizeAssistantBubble(pending, fullText, providerId, imgHint || undefined, 1);
          appendActivityLog(`Chat ← reply: image, model ${modelLabel}, OK`);
        } else {
          const chatOpts = await buildChatOptsForModelRequest({
            persistDialogId,
            promptForApi,
            providerId,
            key,
            modeForSend,
            accessDataDumpMode,
            chatAttachments,
            introChatOpen: introContextActive,
            accessChatOpen,
            rulesChatOpen,
          });
          let buf = "";
          try {
            fullText = await completeChatMessageStreaming(
              providerId,
              promptForApi,
              key,
              (piece) => {
                buf += piece;
                if (pending) pending.dataset.assistantMarkdown = buf;
                const te = pending?.querySelector(".msg-assistant-text");
                if (te) setAssistantMessageMarkdown(te, buf);
                if (pending) syncAssistantCopyButtonDuringStream(pending);
                scrollMessagesToEnd();
              },
              chatOpts,
            );
          } catch {
            appendActivityLog(`Chat: streaming unavailable, full response (${modelLabel})`);
            const { text } = await completeChatMessage(providerId, promptForApi, key, chatOpts);
            fullText = text;
            const te = pending?.querySelector(".msg-assistant-text");
            if (te) setAssistantMessageMarkdown(te, fullText);
            scrollMessagesToEnd();
          }
          finalizeAssistantBubble(
            pending,
            fullText,
            providerId,
            accessDataDumpMode ? "Access data" : undefined,
          );
          appendActivityLog(
            `Chat ← reply: text, model ${modelLabel}, reply chars: ${String(fullText).length}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fullText = msg;
        renderAssistantError(pending, msg);
        appendActivityLog(
          `Chat ← error, model ${modelLabel}: ${msg.length > 280 ? `${msg.slice(0, 280)}…` : msg}`,
        );
      }
    } finally {
      chatComposerSending = false;
      sendBtn.disabled = false;
      ta.disabled = false;
      syncComposerSendButtonState();
      syncAllAssistantRetryButtons();
      scrollMessagesToEnd();
      if (persistDialogId && didAppendUserToUi) {
        const assistantMessageAt = new Date().toISOString();
        const assistantOut =
          pending?.classList.contains("msg-assistant--error") && pending?.dataset?.assistantMarkdown
            ? String(pending.dataset.assistantMarkdown)
            : fullText;
        const hadAssistantError = Boolean(pending?.classList.contains("msg-assistant--error"));
        let tid = "";
        try {
          /** @type {Record<string, unknown>} */
          const turnPayload = {
            user_text: persistUserText,
            assistant_text: assistantOut || null,
            requested_provider_id: providerId,
            responding_provider_id: providerId,
            request_type: accessDataDumpMode ? "access_data" : requestTypeFromAttachMode(modeForSend),
            user_message_at: userMessageAt,
            assistant_message_at: assistantMessageAt,
            assistant_error: hadAssistantError ? 1 : 0,
          };
          if (attachmentStripMeta.length > 0) {
            turnPayload.user_attachments_json = JSON.stringify(attachmentStripMeta);
          }
          const saveRes = await saveConversationTurn(persistDialogId, turnPayload);
          tid =
            saveRes && typeof saveRes === "object" && saveRes.id != null ? String(saveRes.id) : "";
          if (pending && tid) {
            pending.dataset.turnId = tid;
            if (!String(pending.dataset.exchangeRootTurnId ?? "").trim()) {
              pending.dataset.exchangeRootTurnId = tid;
            }
            if (!String(pending.dataset.replyOrdinal ?? "").trim()) {
              pending.dataset.replyOrdinal = "1";
            }
            syncAssistantFavoriteStarButton(pending);
            syncAssistantRetryButton(pending);
          }
          await renderThemesSidebar();
        } catch (saveErr) {
          appendActivityLog(
            `Chat DB save: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
          );
        }
        if (
          !accessDataDumpMode &&
          introContextActive &&
          modeForSend !== "image" &&
          !hadAssistantError
        ) {
          try {
            appendActivityLog("Keeper (Intro): start — extracting from user text…");
            /** @type {{ entities: unknown[], links: unknown[], commands?: unknown[] }} */
            let extracted = { entities: [], links: [], commands: [] };
            try {
              extracted = await extractIntroMemoryGraphForIngest(providerId, key, persistUserText);
            } catch (exErr) {
              appendActivityLog(
                `Keeper (Intro): extract request failed — ${exErr instanceof Error ? exErr.message : String(exErr)}. Continuing with empty extract (normalize + fallback can still run).`,
              );
            }
            appendActivityLog(`Keeper (Intro): extract — ${keeperPayloadSummary(extracted)}`);
            let pack = extracted;
            if (await apiHealth()) {
              try {
                const existing = await fetchMemoryGraphFromApi();
                appendActivityLog(
                  `Keeper (Intro): normalize to DB (${(existing.nodes ?? []).length} nodes in graph)…`,
                );
                pack = await normalizeIntroMemoryGraphForDb(
                  providerId,
                  key,
                  extracted,
                  existing.nodes ?? [],
                  {
                    introMode: true,
                    userText: persistUserText,
                  },
                );
                appendActivityLog(`Keeper (Intro): normalize — ${keeperPayloadSummary(pack)}`);
              } catch (normErr) {
                appendActivityLog(
                  `Keeper (Intro): normalize — error: ${normErr instanceof Error ? normErr.message : String(normErr)}`,
                );
                appendActivityLog(
                  `Keeper (Intro): pack without normalize — ${keeperPayloadSummary(pack)}`,
                );
              }
            } else {
              appendActivityLog(
                "Keeper (Intro): normalize skipped — local API unavailable; pack is extract-only.",
              );
            }
            let entN = Array.isArray(pack.entities) ? pack.entities.length : 0;
            let linkN = Array.isArray(pack.links) ? pack.links.length : 0;
            let cmdLen = Array.isArray(pack.commands) ? pack.commands.length : 0;
            if (entN === 0 && linkN === 0 && cmdLen === 0) {
              const fb = introUserNotesFallbackPack(persistUserText);
              const fbe = Array.isArray(fb.entities) ? fb.entities.length : 0;
              if (fbe > 0) {
                pack = fb;
                entN = fbe;
                linkN = Array.isArray(fb.links) ? fb.links.length : 0;
                cmdLen = Array.isArray(fb.commands) ? fb.commands.length : 0;
                appendActivityLog(
                  "Keeper (Intro): empty extract/normalize — applied People/User notes fallback so the turn still reaches the Memory tree.",
                );
              }
            }
            if (entN > 0 || linkN > 0 || cmdLen > 0) {
              const ing = await ingestMemoryGraphPayload({
                entities: pack.entities ?? [],
                links: pack.links ?? [],
                commands: pack.commands ?? [],
              });
              const u = Number(ing?.upsertedEntities);
              const l = Number(ing?.insertedLinks);
              appendActivityLog(
                `Keeper (Intro): ingest — upserted nodes: ${Number.isFinite(u) ? u : "?"}, inserted edges: ${Number.isFinite(l) ? l : "?"}.${keeperIngestCommandsLine(ing)}`,
              );
            } else {
              appendActivityLog(
                "Keeper (Intro): ingest skipped — empty pack after extract/normalize. The model returned no entities/links/commands for this message (or the API did not respond).",
              );
            }
          } catch (ingErr) {
            appendActivityLog(
              `Keeper (Intro): failure — ${ingErr instanceof Error ? ingErr.message : String(ingErr)}`,
            );
          }
          try {
            await loadMemoryGraphIntoUi();
          } catch {
            /* loadMemoryGraphIntoUi logs */
          }
        } else if (accessChatOpen && modeForSend !== "image" && !hadAssistantError) {
            try {
              appendActivityLog("Keeper 2 (Access): start — scanning conversation…");
              const turnsAcc = await fetchTurns(persistDialogId);
              const accParts = [];
              for (const row of turnsAcc.slice(-40)) {
                const u = String(row.user_text ?? "").trim();
                const a = String(row.assistant_text ?? "").trim();
                if (u) accParts.push(`USER:\n${u}`);
                if (a) accParts.push(`ASSISTANT:\n${a}`);
              }
              /** Long bulk API lists: keep enough transcript for Keeper 2 (chars). */
              const transcript = accParts.join("\n\n").slice(0, 72000);
              const store = await fetchAccessExternalServices();
              const existingAcc = Array.isArray(store.entries) ? store.entries : [];
              const existingSummary = JSON.stringify(
                existingAcc.map((e) => ({
                  name: e.name,
                  description: String(e.description ?? "").slice(0, 160),
                })),
              ).slice(0, 12000);
              const extractedAcc = await extractAccessKeeper2EntriesFromTranscript(
                providerId,
                key,
                transcript,
                existingSummary,
              );
              let patchAcc = Array.isArray(extractedAcc.entries) ? extractedAcc.entries : [];
              if (patchAcc.length === 0) {
                const stubs = extractAccessExternalServiceStubsFromBulkListText(persistUserText);
                if (stubs.length > 0) {
                  patchAcc = stubs;
                  appendActivityLog(
                    `Keeper 2 (Access): model returned no rows — applied list parser (${stubs.length} stub row(s) from your last message).`,
                  );
                }
              }
              if (patchAcc.length === 0) {
                appendActivityLog("Keeper 2 (Access): no new external-service rows for this turn.");
              } else {
                const mergedAcc = mergeAccessExternalServiceEntries(existingAcc, patchAcc);
                await putAccessExternalServices({ entries: mergedAcc });
                appendActivityLog(
                  `Keeper 2 (Access): merged ${patchAcc.length} update(s); ${mergedAcc.length} service row(s) in store.`,
                );
              }
            } catch (k2Err) {
              appendActivityLog(
                `Keeper 2 (Access): failure — ${k2Err instanceof Error ? k2Err.message : String(k2Err)}`,
              );
            }
          } else if (rulesChatOpen && modeForSend !== "image" && !hadAssistantError) {
            try {
              appendActivityLog("Rules: updating saved conduct from the thread…");
              const turnsR = await fetchTurns(persistDialogId);
              const slice = turnsR.slice(-40);
              const rParts = [];
              /** @type {string[]} */
              const userOnlyChronological = [];
              for (const row of slice) {
                const u = String(row.user_text ?? "").trim();
                const a = String(row.assistant_text ?? "").trim();
                if (u) {
                  userOnlyChronological.push(u);
                  rParts.push(`USER:\n${u}`);
                }
                if (a) rParts.push(`ASSISTANT:\n${a}`);
              }
              const nUser = userOnlyChronological.length;
              const sectionA =
                nUser === 0
                  ? "(no user messages in window)\n"
                  : userOnlyChronological
                      .map(
                        (text, i) =>
                          `--- USER message ${i + 1} of ${nUser} ---\n${text}`,
                      )
                      .join("\n\n");
              const sectionB = rParts.join("\n\n");
              const transcriptR = (
                "SECTION A — EVERY USER MESSAGE IN THIS RULES THREAD (oldest first). " +
                "Evaluate **each** block: should it add or change saved project conduct? " +
                "If it is only thanks/ok/emoji with no new rule content, skip that block only.\n\n" +
                `${sectionA}\n\n` +
                "SECTION B — FULL THREAD (USER and ASSISTANT; context for disambiguation only):\n\n" +
                `${sectionB}`
              ).slice(0, 72000);
              const bundle = await fetchRulesKeeperBundle();
              const existingSummaryR = rulesKeeperExistingSummaryForExtract(bundle);
              const stubPatch = extractRulesListStubsFromUserText(persistUserText);
              let patchR = await extractRulesKeeper3FromTranscript(
                providerId,
                key,
                transcriptR,
                existingSummaryR,
              );
              const countPatch = (p) =>
                p.core_rules.length +
                p.private_rules.length +
                p.forbidden_actions.length +
                p.workflow_rules.length;
              let nAdd = countPatch(patchR);
              const nStub = countPatch(stubPatch);
              const userNonEmptyLines = persistUserText
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l.length > 0).length;
              if (nAdd === 0 && nStub > 0) {
                patchR = stubPatch;
                nAdd = nStub;
                appendActivityLog(
                  `Rules: model returned no rows — used message-text fallback (${nStub} candidate line(s) from your last message).`,
                );
              } else if (nAdd > 0 && userNonEmptyLines >= 3 && nStub > nAdd) {
                patchR = mergeRulesKeeperClientPatches(patchR, stubPatch);
                nAdd = countPatch(patchR);
                appendActivityLog(
                  `Rules: merged message-text fallback (${nStub} line(s)) with model output (${nAdd} total candidate line(s)).`,
                );
              }
              if (nAdd === 0) {
                appendActivityLog("Rules: no new rule lines for this turn.");
              } else {
                const { merged_total: mergedTotal } = await mergeRulesKeeperPatch(patchR);
                appendActivityLog(
                  `Rules: merged ${nAdd} candidate line(s); ${mergedTotal} new unique line(s) in the saved rules store.`,
                );
              }
            } catch (k3Err) {
              appendActivityLog(
                `Rules: saved-rules update failed — ${k3Err instanceof Error ? k3Err.message : String(k3Err)}`,
              );
            }
          } else if (
            !accessDataDumpMode &&
            !introContextActive &&
            !accessChatOpen &&
            !rulesChatOpen &&
            modeForSend !== "image" &&
            !hadAssistantError
          ) {
            try {
              appendActivityLog("Keeper (chat): start — interest sketch from user text…");
              const extracted = await extractChatInterestSketchForIngest(providerId, key, persistUserText);
              appendActivityLog(`Keeper (chat): extract — ${keeperPayloadSummary(extracted)}`);
              let pack = extracted;
              if ((extracted.entities.length > 0 || extracted.links.length > 0) && (await apiHealth())) {
                try {
                  const existing = await fetchMemoryGraphFromApi();
                  appendActivityLog(
                    `Keeper (chat): normalize to DB (${(existing.nodes ?? []).length} nodes in graph)…`,
                  );
                  pack = await normalizeIntroMemoryGraphForDb(providerId, key, extracted, existing.nodes ?? []);
                  appendActivityLog(`Keeper (chat): normalize — ${keeperPayloadSummary(pack)}`);
                } catch (normErr) {
                  appendActivityLog(
                    `Keeper (chat): normalize — error: ${normErr instanceof Error ? normErr.message : String(normErr)}`,
                  );
                  appendActivityLog(`Keeper (chat): pack without normalize — ${keeperPayloadSummary(pack)}`);
                }
              } else if (extracted.entities.length > 0 || extracted.links.length > 0) {
                appendActivityLog(
                  "Keeper (chat): normalize skipped — local API unavailable.",
                );
              }
              const chatCmdLen = Array.isArray(pack.commands) ? pack.commands.length : 0;
              if (pack.entities.length > 0 || pack.links.length > 0 || chatCmdLen > 0) {
                const ing = await ingestMemoryGraphPayload({
                  entities: pack.entities ?? [],
                  links: pack.links ?? [],
                  commands: pack.commands ?? [],
                });
                const u = Number(ing?.upsertedEntities);
                const l = Number(ing?.insertedLinks);
                appendActivityLog(
                  `Keeper (chat): ingest — upserted nodes: ${Number.isFinite(u) ? u : "?"}, inserted edges: ${Number.isFinite(l) ? l : "?"}.${keeperIngestCommandsLine(ing)}`,
                );
                try {
                  await loadMemoryGraphIntoUi();
                } catch {
                  /* loadMemoryGraphIntoUi logs */
                }
              } else {
                appendActivityLog(
                  "Keeper (chat): ingest skipped — empty interest sketch for this message.",
                );
              }
            } catch (skErr) {
              appendActivityLog(
                `Keeper (chat): failure — ${skErr instanceof Error ? skErr.message : String(skErr)}`,
              );
            }
          }
      }
    }
  }

  sendBtn.addEventListener("click", () => submitChat());

  ta.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (e.isComposing) return;
    e.preventDefault();
    submitChat();
  });
}

const MAIN_CHAT_FILE_DROP_CLASS = "main-chat--drag-over-files";

function dataTransferHasFileList(dataTransfer) {
  if (!dataTransfer) return false;
  try {
    return [...dataTransfer.types].includes("Files");
  } catch {
    return false;
  }
}

/** Drag files onto the chat area → composer (no “Add photos and files” click). */
function initChatFileDropZone() {
  const mainChat = document.getElementById("main-chat");
  if (!mainChat) return;

  /** After `drop`, some browsers emit another `dragover` with Files — without this, the drop highlight sticks. */
  let suppressDropHighlightUntil = 0;

  function clearDropHighlight() {
    mainChat.classList.remove(MAIN_CHAT_FILE_DROP_CLASS);
  }

  function onWindowDragOver(e) {
    if (performance.now() < suppressDropHighlightUntil) {
      clearDropHighlight();
      return;
    }
    if (mainChat.classList.contains("chat--rules") || mainChat.classList.contains("chat--access")) {
      clearDropHighlight();
      return;
    }
    if (!dataTransferHasFileList(e.dataTransfer)) {
      clearDropHighlight();
      return;
    }
    const top = document.elementFromPoint(e.clientX, e.clientY);
    if (top instanceof Node && mainChat.contains(top)) {
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = "copy";
      } catch {
        /* ignore */
      }
      mainChat.classList.add(MAIN_CHAT_FILE_DROP_CLASS);
    } else {
      clearDropHighlight();
    }
  }

  function onWindowDrop(e) {
    clearDropHighlight();
    if (mainChat.classList.contains("chat--rules") || mainChat.classList.contains("chat--access")) {
      return;
    }
    if (!dataTransferHasFileList(e.dataTransfer)) return;
    const t = e.target;
    if (!(t instanceof Node) || !mainChat.contains(t)) return;
    e.preventDefault();
    e.stopPropagation();
    const fl = e.dataTransfer?.files;
    if (fl?.length) {
      addComposerAttachmentsFromFileList(fl);
      /* Trailing dragover with types: Files after drop — otherwise the frame turns on again. */
      suppressDropHighlightUntil = performance.now() + 600;
    }
    queueMicrotask(() => clearDropHighlight());
  }

  function onWindowDragEnd() {
    clearDropHighlight();
  }

  /** Cursor leaves the document — without a later `dragover`, the frame may not clear. */
  function onDocumentDragLeave(e) {
    if (!dataTransferHasFileList(e.dataTransfer)) return;
    const rel = e.relatedTarget;
    if (rel != null && rel instanceof Node && document.documentElement.contains(rel)) return;
    clearDropHighlight();
  }

  window.addEventListener("dragover", onWindowDragOver, true);
  window.addEventListener("drop", onWindowDrop, true);
  window.addEventListener("dragend", onWindowDragEnd, true);
  document.documentElement.addEventListener("dragleave", onDocumentDragLeave, true);
  window.addEventListener("blur", clearDropHighlight);
}

/** Click an image in chat history → fullscreen; Esc or backdrop click closes. */
function initChatImageLightbox() {
  const root = document.getElementById("chat-image-lightbox");
  const backdrop = root?.querySelector(".chat-image-lightbox-backdrop");
  const frame = root?.querySelector(".chat-image-lightbox-frame");
  const btnClose = root?.querySelector(".chat-image-lightbox-close");
  const imgEl = root?.querySelector(".chat-image-lightbox-img");
  const list = document.getElementById("messages-list");
  if (!root || !(imgEl instanceof HTMLImageElement) || !list) return;

  let prevActive = /** @type {HTMLElement | null} */ (null);

  function isOpen() {
    return !root.hidden;
  }

  function close() {
    if (!isOpen()) return;
    root.hidden = true;
    imgEl.removeAttribute("src");
    imgEl.alt = "";
    document.removeEventListener("keydown", onDocKeydown, true);
    document.body.style.overflow = "";
    if (prevActive && typeof prevActive.focus === "function") {
      try {
        prevActive.focus();
      } catch {
        /* ignore */
      }
    }
    prevActive = null;
  }

  function onDocKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function openFrom(img) {
    if (!(img instanceof HTMLImageElement) || !img.src) return;
    prevActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    imgEl.src = img.currentSrc || img.src;
    imgEl.alt = img.alt || "Image";
    root.hidden = false;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onDocKeydown, true);
    requestAnimationFrame(() => {
      try {
        btnClose?.focus();
      } catch {
        /* ignore */
      }
    });
  }

  list.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLImageElement)) return;
    if (!t.closest(".msg")) return;
    if (t.closest(".msg-bubble-actions")) return;
    if (t.closest(".chat-attach-tile")) return;
    e.preventDefault();
    e.stopPropagation();
    openFrom(t);
  });

  backdrop?.addEventListener("click", () => close());
  btnClose?.addEventListener("click", () => close());
  frame?.addEventListener("click", (e) => {
    if (e.target === frame) close();
  });
}

function bootApp() {
  initThemeToggle();
  initActivityPanel();
  initFavoritesPanel();
  initProviderBadges();
  initThemeCardActions();
  initDialoguesMenu();
  initThemeFolderMenus();
  initMemoryTree(appendActivityLog);
  initIrPanelPinLock({
    appendActivityLog,
    loadIntroThreadIntoUi: loadIntroChatThreadIntoUi,
    loadAccessThreadIntoUi: loadAccessChatThreadIntoUi,
    syncIrPanelVaultDom,
  });
  initAnalyticsDashboard({
    fetchAnalytics,
    appendActivityLog,
    prepareChatSurface: () => {
      closeMemoryTree();
      closeIrChatPanel();
    },
  });
  initNewDialogueButton();
  initAttachMenu();
  initChatComposer();
  initChatFileDropZone();
  initChatImageLightbox();
  initIntroRulesAccessPanels();
  initIrClearArchiveButton();

  appendActivityLog("MF0-1984 ready.");

  void (async () => {
    try {
      if (await apiHealth()) {
        await refreshIrPanelLockFromApi();
        await renderThemesSidebar();
        await loadMemoryGraphIntoUi();
        appendActivityLog("Chat database connected.");
      } else {
        appendActivityLog(
          "Chat database offline — run the API and UI together (npm run dev) or restart the API process (e.g. pm2); default API port 35184.",
        );
      }
    } catch (e) {
      appendActivityLog(`Chat database: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  const keys = getModelApiKeys();
  const configured = Object.entries(keys).filter(([, v]) => v.length > 0);
  if (configured.length) {
    appendActivityLog(`Keys in .env: ${configured.map(([k]) => k).join(", ")}`);
  } else {
    appendActivityLog("Model keys from .env not loaded (check .env for dev).");
  }
}

if (import.meta.env.DEV && !hasAnyModelApiKey()) {
  const blocker = document.getElementById("env-keys-blocker");
  const root = document.querySelector(".app-root");
  if (blocker) blocker.hidden = false;
  if (root) root.inert = true;
} else {
  bootApp();
}
