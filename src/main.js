import "./theme.css";
import "highlight.js/styles/github-dark.min.css";
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
import { highlightAssistantMarkdownCodeBlocks } from "./markdownCodeHighlight.js";
import { getModelApiKeys, hasAnyModelApiKey } from "./modelEnv.js";
import {
  closeAllSettingsModelPickers,
  initSettingsModelSelects,
  refreshSettingsModelSelects,
} from "./settingsModelsUi.js";
import {
  getChatAnalysisPriority,
  initChatAnalysisPrioritySettings,
  refreshChatAnalysisPrioritySettings,
} from "./chatAnalysisPriority.js";
import { setTheme } from "./theme.js";
import {
  closeMemoryTree,
  enrichMemoryGraphFromApi,
  findMemoryGraphHubPairFromProfileEdge,
  initMemoryTree,
  memoryTreeCoversIntroChat,
  openMemoryTree,
  setMemoryGraphData,
} from "./memoryTree.js";
import { detectIntroMemoryTreeCommands } from "./introMemoryTreeCommands.js";
import { downloadMemoryTreeTarGz } from "./memoryTreeExport.js";
import { getProjectProfilePasswordErrors } from "./projectProfileCrypto.js";
import { runProjectProfileExportDownload } from "./projectProfileExport.js";
import { runProjectProfileImportFromFile } from "./projectProfileImportUi.js";
import {
  getIrPanelLockedSync,
  initIrPanelPinLock,
  openSetPinModal,
  openUnlockModal,
  refreshIrPanelLockFromApi,
} from "./irPanelPinLock.js";
import { closeAnalyticsView, initAnalyticsDashboard, refreshAnalyticsViewIfOpen } from "./analyticsDashboard.js";
import {
  apiHealth,
  bootstrapThemeAndDialog,
  createDialogInTheme,
  deleteTheme,
  renameTheme,
  fetchAssistantFavorites,
  fetchContextPack,
  fetchRulesKeeperBundle,
  mergeRulesKeeperPatch,
  clearDialogTurnsArchive,
  fetchAccessExternalServices,
  fetchAccessDataDumpEnrichment,
  fetchAccessExternalServicesCatalog,
  putAccessExternalServices,
  fetchMemoryGraphFromApi,
  importMemoryGraphReplace,
  fetchAnalytics,
  fetchThemesPayload,
  fetchTurns,
  fetchProjectCacheStats,
  clearProjectMultimediaCache,
  fetchVoiceReplyStatus,
  ensureVoiceReplyMp3,
  ingestMemoryGraphPayload,
  requestTypeFromAttachMode,
  recordAuxLlmUsage,
  saveConversationTurn,
  setAssistantTurnFavorite,
  titleFromUserMessage,
  transcribeVoiceMessage,
} from "./chatPersistence.js";
import { buildModelContext } from "./contextEngine/buildModelContext.js";
import { fitContextToBudget } from "./contextEngine/fitContextToBudget.js";
import { fetchMemoryTreeSupplementForPrompt } from "./memoryTreeRouter.js";
import { renderThemeCards, syncSidebarSelectionState } from "./themesSidebar.js";
import {
  getFavoriteThemeIdSet,
  removeFavoriteThemeId,
  sortThemesFavoritesFirst,
  toggleFavoriteThemeId,
} from "./themeFavorites.js";
import {
  classifyComposerAttachmentKind,
  MAX_COMPOSER_ATTACHMENTS,
  MAX_PERSIST_IMAGE_BASE64_CHARS,
  MAX_PERSIST_TEXT_INLINE_CHARS,
  prepareComposerAttachmentsForApi,
  prepareComposerAttachmentsForApiAndPersist,
  revokeComposerAttachmentPreview,
} from "./composerAttachments.js";
import {
  mergeAccessExternalServiceEntries,
  mergeRulesKeeperClientPatches,
  rulesKeeperExistingSummaryForExtract,
} from "./accessRulesKeeperHelpers.js";
import {
  createIrPanelThreadLoaders,
  ensureIntroSessionClient,
  ensureAccessSessionClient,
  ensureRulesSessionClient,
} from "./irPanelSessionThreads.js";
import { buildHelpModeSystemInstruction } from "./helpHandoffText.js";
import { closeHelpChatPanel, openHelpChatPanelDom, isHelpChatOpen } from "./helpChatDom.js";

const MAX_LOG_LINES = 400;
/** Upper bound for estimated input tokens when building thread context (before the model reply). */
const MF0_MAX_CONTEXT_INPUT_TOKENS = 12000;

/** Last N user exchanges (grouped turns) paint first when reopening a long thread; older rows prepend in idle time. */
const DIALOG_REPLAY_TAIL_GROUP_COUNT = 12;
const DIALOG_REPLAY_HEAD_PRELOAD_CHUNK_GROUPS = 4;

/** Bumped whenever a progressive history prepend is superseded by a new thread load. */
let dialogHistoryPrependGeneration = 0;

/** Active conversation for DB persistence (null = new chat until first send). */
let activeThemeId = null;
let activeDialogId = null;

/** Ephemeral Help chat: alternating user / assistant messages for the LLM only (not saved to SQLite). */
let helpChatLlmSession = /** @type {Array<{ role: "user" | "assistant", content: string }>} */ ([]);

/** Revoke blob URLs held by sent user-message attachment tiles (before clearing `#messages-list`). */
function revokeSentUserAttachmentBlobUrls(listEl) {
  if (!(listEl instanceof HTMLElement)) return;
  listEl.querySelectorAll('a.chat-attach-tile--sent-blob[href^="blob:"]').forEach((a) => {
    const href = a.getAttribute("href");
    if (!href) return;
    try {
      URL.revokeObjectURL(href);
    } catch {
      /* ignore */
    }
  });
}

const {
  loadIntroChatThreadIntoUi,
  loadAccessChatThreadIntoUi,
  loadRulesChatThreadIntoUi,
} = createIrPanelThreadLoaders({
  replayDialogTurnsGrouped,
  scrollMessagesToEnd,
  appendActivityLog,
  loadMemoryGraphIntoUi,
  revokeSentUserAttachmentBlobUrls,
});

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
  "   **No false drama:** Do **not** say that API requests were “generated” and then “failed to load” when the truth is **no request was sent** (`skipped`) or only some rows fetched. A skipped row is **not** a global outage — explain only what blocked **that** row; **do not** dump the whole `entries` list as consolation.\n" +
  "   **Scope honesty:** If the user asks for a **time range** (e.g. “last 14 days”) but the stored URL is clearly **latest-only** (e.g. `/v6/latest/…`) or only one dated snapshot exists, say plainly what the snapshot **can** show vs what would require a **different** documented URL (still under the same allowlist) or turning off Access data — **never** sound as if “the system refused” data that the configured endpoint simply does not return.\n" +
  "3) **Inference / image / video / upscale / job-queue requests** (anything that would require **calling** a third-party API from this chat, using credentials in `entries`): This mode **does not** execute POST calls, queues, or paid inference **from this app** — there is no agent step that performs HTTP with their key; you only **read** the injected `entries` plus GET `snapshots`. **Never** explain refusal by saying the service “does not support real-time data extraction”, “cannot extract data”, or that the request “failed” in that sense — that is the wrong frame.\n" +
  "   **Mandatory answer order** when the user asks for generation, editing, upscaling, or rendering: (1) **First** a short, practical block built **only** from `entries` — which row matches their ask, `endpointUrl`, and anything in `description` / `notes` (method, path, headers, JSON keys, queue URL). Do **not** invent hosts or tokens not present in the JSON. (2) **Then** one clear sentence that **you** cannot execute that call or return a new image **in this locked mode** (read-only snapshot). (3) **Optionally** suggest turning off **Access data** / **#data** for free-form help or image flows — but **never** skip step (1); a reply that is **only** refusal with no concrete detail from `entries` is **invalid**.\n" +
  "4) **Answer shape (not an API manual):** Use the **same language as the user’s message**. **Stay on topic:** deliver **only** what they asked (weather → forecast snapshot fields; air → air-quality snapshot fields; sea state → marine snapshot; etc.). Other `entries` / `snapshots` may inform your choice of row but **must not** appear in the visible answer unless the user explicitly asks for **all configured services**, a **full Access overview**, or **copy-paste URLs/keys**.\n" +
  "   • **If** they ask for environmental **measurements** and a matching snapshot has `ok: true` with `body`, reply with a **short** consumer block: bullets or a small table of **only** the requested readings (units and observation time from that `body` / snapshot metadata).\n" +
  "   • **If** there are **no** such snapshots for their question (e.g. image API / upscale), **do not** use a weather-style lead — answer directly from `entries` and snapshot status where relevant.\n" +
  "   • **Forbidden by default:** numbered “configured services” lists with links; sections titled like configured-services / available-APIs catalogs; repeating the same URL in prose **and** in a code block; dumping query strings or every row’s `endpointUrl`; long `[label](https://…)` link lines. **Optional:** at most **one** short line naming the matched row’s `name` (which feed the numbers came from). Raw URLs or keys **only** if the user explicitly asked for technical copy-paste — then **one** short fenced block, no duplicate.\n" +
  "   • **Do not** close with vague filler like “these APIs can be used” — state facts or what is missing, briefly.\n" +
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

/**
 * Persisted on the assistant turn when the model returns usage metadata.
 * @param {{ promptTokens: number, completionTokens: number, totalTokens: number } | null | undefined} u
 */
function llmUsageTurnDbFields(u) {
  if (!u || typeof u !== "object") return {};
  return {
    llm_prompt_tokens: u.promptTokens,
    llm_completion_tokens: u.completionTokens,
    llm_total_tokens: u.totalTokens,
  };
}

/**
 * Best-effort token estimate for analytics continuity when provider usage is missing.
 * @param {string} text
 */
function estimateTokensFromText(text) {
  const s = String(text ?? "").trim();
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}

/**
 * @param {{ promptTokens: number, completionTokens: number, totalTokens: number } | null | undefined} usage
 * @param {string} promptText
 * @param {string} completionText
 */
function ensureUsageTotals(usage, promptText, completionText) {
  if (
    usage &&
    typeof usage === "object" &&
    Number.isFinite(usage.totalTokens) &&
    Number(usage.totalTokens) > 0
  ) {
    return usage;
  }
  const promptTokens = estimateTokensFromText(promptText);
  const completionTokens = estimateTokensFromText(completionText);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
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
  if (m === "aiTalks") return "AI opinion";
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

/** @param {number} nodes @param {number} edges */
function showMemoryTreeImportSuccessModal(nodes, edges) {
  const wrap = document.getElementById("memory-tree-import-success-modal");
  const msgEl = document.getElementById("memory-tree-import-success-msg");
  const okBtn = document.getElementById("memory-tree-import-success-ok");
  if (!(wrap instanceof HTMLElement) || !(msgEl instanceof HTMLElement) || !(okBtn instanceof HTMLButtonElement)) {
    return;
  }
  const n = Number(nodes) || 0;
  const e = Number(edges) || 0;
  msgEl.textContent = `Memory tree import finished successfully. ${n} node(s) and ${e} edge(s) were imported from the file.`;
  wrap.hidden = false;
  okBtn.focus();

  /** @param {KeyboardEvent} ev */
  const swallowEscape = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
    }
  };
  document.addEventListener("keydown", swallowEscape, true);

  const close = () => {
    wrap.hidden = true;
    document.removeEventListener("keydown", swallowEscape, true);
    okBtn.removeEventListener("click", close);
  };
  okBtn.addEventListener("click", close);
}

/** @param {File} file */
function memoryTreeImportFileKind(file) {
  const n = String(file.name ?? "").toLowerCase();
  if (n.endsWith(".json")) return "json";
  if (n.endsWith(".tar.gz") || n.endsWith(".tgz")) return "gzip";
  return null;
}

/** One-shot: profile import may trigger a full page reload (Vite watches `.env`); reopen success on next load. */
const PROFILE_IMPORT_SUCCESS_FLASH_STORAGE_KEY = "mf0.profileImportSuccessFlash";

const PROFILE_IMPORT_SUCCESS_INFORMER_TEXT =
  "All profile data was imported successfully (Memory tree, rules, Access, .env, AI model choices, and the Access #data enrichment snapshot).";

function setProfileImportSuccessFlash() {
  try {
    sessionStorage.setItem(PROFILE_IMPORT_SUCCESS_FLASH_STORAGE_KEY, "1");
  } catch {
    /* private mode / storage disabled */
  }
}

function clearProfileImportSuccessFlash() {
  try {
    sessionStorage.removeItem(PROFILE_IMPORT_SUCCESS_FLASH_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

const MEMORY_OPT_MAX_COMMANDS = 50;
const MEMORY_OPT_MAX_LLM_PAIRS = 24;
/** Merges + hub links in one Interests reconnect run (may exceed merge-only cap). */
const MEMORY_OPT_MAX_INTERESTS_RECONNECT_OPS = 200;

function memoryOptNormText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function memoryOptJaroWinkler(a, b) {
  const s1 = String(a ?? "");
  const s2 = String(b ?? "");
  if (!s1 && !s2) return 1;
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  const l1 = s1.length;
  const l2 = s2.length;
  const maxDist = Math.max(0, Math.floor(Math.max(l1, l2) / 2) - 1);
  const m1 = new Array(l1).fill(false);
  const m2 = new Array(l2).fill(false);
  let matches = 0;
  for (let i = 0; i < l1; i += 1) {
    const st = Math.max(0, i - maxDist);
    const en = Math.min(i + maxDist + 1, l2);
    for (let j = st; j < en; j += 1) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = true;
      m2[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < l1; i += 1) {
    if (!m1[i]) continue;
    while (!m2[k]) k += 1;
    if (s1[i] !== s2[k]) t += 1;
    k += 1;
  }
  const transpositions = t / 2;
  const jaro = (matches / l1 + matches / l2 + (matches - transpositions) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, l1, l2); i += 1) {
    if (s1[i] !== s2[i]) break;
    prefix += 1;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function memoryOptNodeByIdMap(raw) {
  const m = new Map();
  const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
  for (const n of nodes) {
    const id = String(n?.id ?? "").trim();
    if (!id) continue;
    m.set(id, {
      id,
      category: String(n?.category ?? "").trim(),
      label: String(n?.label ?? "").trim(),
    });
  }
  return m;
}

function memoryOptPushDeleteEdge(commands, fromNode, toNode, relation) {
  if (!fromNode || !toNode || commands.length >= MEMORY_OPT_MAX_COMMANDS) return false;
  commands.push({
    op: "deleteEdge",
    from: { category: fromNode.category, label: fromNode.label },
    to: { category: toNode.category, label: toNode.label },
    relation: String(relation ?? "").trim().slice(0, 200),
  });
  return true;
}

function buildRecordLinkageOptimizationPayload(rawGraph) {
  const nodes = Array.isArray(rawGraph?.nodes) ? rawGraph.nodes : [];
  const byGroup = new Map();
  for (const n of nodes) {
    const id = String(n?.id ?? "").trim();
    const category = String(n?.category ?? "").trim();
    const label = String(n?.label ?? "").trim();
    const key = memoryOptNormText(label);
    if (!id || !category || !label || !key) continue;
    const gk = `${category}::${key}`;
    if (!byGroup.has(gk)) byGroup.set(gk, []);
    byGroup.get(gk).push({ id, category, label });
  }
  const commands = [];
  let mergeCount = 0;
  for (const group of byGroup.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.label.localeCompare(b.label));
    const into = sorted[0];
    for (const from of sorted.slice(1)) {
      if (commands.length >= MEMORY_OPT_MAX_COMMANDS) break;
      commands.push({
        op: "mergeNodes",
        from: { category: from.category, label: from.label },
        into: { category: into.category, label: into.label },
      });
      mergeCount += 1;
    }
    if (commands.length >= MEMORY_OPT_MAX_COMMANDS) break;
  }
  return {
    payload: { entities: [], links: [], commands },
    summary: `Record linkage: ${mergeCount} merge command(s) prepared.`,
  };
}

function buildKnowledgeConsistencyOptimizationPayload(rawGraph) {
  const nodesById = memoryOptNodeByIdMap(rawGraph);
  const links = Array.isArray(rawGraph?.links) ? rawGraph.links : [];
  const commands = [];
  let relationFixes = 0;
  const pairBuckets = new Map();
  for (const ln of links) {
    const fromNode = nodesById.get(String(ln?.source ?? "").trim());
    const toNode = nodesById.get(String(ln?.target ?? "").trim());
    const relation = String(ln?.label ?? "").trim().slice(0, 200) || "related";
    if (!fromNode || !toNode) continue;
    const pk = `${fromNode.id}\u0000${toNode.id}`;
    if (!pairBuckets.has(pk)) {
      pairBuckets.set(pk, {
        fromNode,
        toNode,
        counts: new Map(),
      });
    }
    const bucket = pairBuckets.get(pk);
    bucket.counts.set(relation, (bucket.counts.get(relation) ?? 0) + 1);
  }
  const linksToAdd = [];
  for (const bucket of pairBuckets.values()) {
    const entries = [...bucket.counts.entries()].sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) continue;
    const canonicalRelation = String(entries[0][0] ?? "related").trim() || "related";
    if (entries.length > 1) {
      for (const [rel] of entries.slice(1)) {
        if (memoryOptPushDeleteEdge(commands, bucket.fromNode, bucket.toNode, rel)) {
          relationFixes += 1;
        }
      }
    }
    linksToAdd.push({
      from: { category: bucket.fromNode.category, label: bucket.fromNode.label },
      to: { category: bucket.toNode.category, label: bucket.toNode.label },
      relation: canonicalRelation,
    });
    if (commands.length >= MEMORY_OPT_MAX_COMMANDS) break;
  }
  return {
    payload: { entities: [], links: linksToAdd, commands },
    summary: `Knowledge consistency: ${relationFixes} relation conflict fix(es), ${linksToAdd.length} canonical edge(s).`,
  };
}

/**
 * @param {Array<{ source?: string, target?: string }>} rawLinks
 * @param {string} idA
 * @param {string} idB
 */
function memoryGraphUndirectedEdgeExists(rawLinks, idA, idB) {
  const a = String(idA ?? "").trim();
  const b = String(idB ?? "").trim();
  if (!a || !b) return false;
  for (const ln of rawLinks) {
    const s = String(ln?.source ?? "").trim();
    const t = String(ln?.target ?? "").trim();
    if ((s === a && t === b) || (s === b && t === a)) return true;
  }
  return false;
}

/**
 * Re-links Interests-category topic nodes that have **no** incident edges to the topic hub
 * (identified by the People↔Interests `profile and interests` edge). If another node in the
 * same normalized-label group already has edges, merges orphans into that canonical node
 * instead of attaching duplicates to the hub.
 * @param {{ nodes?: unknown[], links?: unknown[] }} rawGraph
 */
function buildInterestsOrphanReconnectPayload(rawGraph) {
  const nodes = Array.isArray(rawGraph?.nodes) ? rawGraph.nodes : [];
  const links = Array.isArray(rawGraph?.links) ? rawGraph.links : [];
  const { interestsHubId } = findMemoryGraphHubPairFromProfileEdge(nodes, links);
  if (!interestsHubId) {
    return {
      payload: { entities: [], links: [], commands: [] },
      summary:
        "Interests reconnect: no topic hub found (add a People↔Interests edge with relation “profile and interests”).",
    };
  }
  const nodesById = memoryOptNodeByIdMap(rawGraph);
  const hubNode = nodesById.get(interestsHubId);
  if (!hubNode || hubNode.category !== "Interests" || !hubNode.label) {
    return {
      payload: { entities: [], links: [], commands: [] },
      summary: "Interests reconnect: hub node missing or invalid.",
    };
  }

  /** @type {Map<string, number>} */
  const degree = new Map();
  for (const ln of links) {
    const s = String(ln?.source ?? "").trim();
    const t = String(ln?.target ?? "").trim();
    if (!s || !t) continue;
    degree.set(s, (degree.get(s) ?? 0) + 1);
    degree.set(t, (degree.get(t) ?? 0) + 1);
  }

  /** @type {Array<{ id: string, category: string, label: string, norm: string }>} */
  const interestTopics = [];
  for (const n of nodes) {
    const id = String(n?.id ?? "").trim();
    const category = String(n?.category ?? "").trim();
    const label = String(n?.label ?? "").trim();
    if (!id || category !== "Interests" || !label) continue;
    if (id === interestsHubId) continue;
    const norm = memoryOptNormText(label);
    interestTopics.push({ id, category, label, norm: norm || label });
  }

  /** @type {Map<string, typeof interestTopics>} */
  const byNorm = new Map();
  for (const row of interestTopics) {
    if (!byNorm.has(row.norm)) byNorm.set(row.norm, []);
    byNorm.get(row.norm).push(row);
  }

  const linksOut = [];
  const commands = [];
  let merges = 0;
  let hubLinks = 0;
  let mergeCapHit = false;
  let totalCapHit = false;

  /** Phase 1: merges (server applies max ${MEMORY_OPT_MAX_COMMANDS} graph commands per ingest). */
  mergePass: for (const [, members] of byNorm) {
    const connected = members.filter((m) => (degree.get(m.id) ?? 0) > 0);
    const orphans = members.filter((m) => (degree.get(m.id) ?? 0) === 0);
    if (orphans.length === 0 || connected.length === 0) continue;
    const canonical = [...connected].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    )[0];
    for (const o of orphans) {
      if (o.id === canonical.id) continue;
      if (commands.length >= MEMORY_OPT_MAX_COMMANDS) {
        mergeCapHit = true;
        break mergePass;
      }
      commands.push({
        op: "mergeNodes",
        from: { category: o.category, label: o.label },
        into: { category: canonical.category, label: canonical.label },
      });
      merges += 1;
    }
  }

  /** Phase 2: link isolated topics to hub (`related`, same direction as existing topic→hub edges). */
  linkPass: for (const [, members] of byNorm) {
    const connected = members.filter((m) => (degree.get(m.id) ?? 0) > 0);
    const orphans = members.filter((m) => (degree.get(m.id) ?? 0) === 0);
    if (orphans.length === 0) continue;
    if (connected.length > 0) continue;
    for (const o of orphans) {
      if (linksOut.length + commands.length >= MEMORY_OPT_MAX_INTERESTS_RECONNECT_OPS) {
        totalCapHit = true;
        break linkPass;
      }
      if (memoryGraphUndirectedEdgeExists(links, o.id, interestsHubId)) continue;
      linksOut.push({
        from: { category: o.category, label: o.label },
        to: { category: hubNode.category, label: hubNode.label },
        relation: "related",
      });
      hubLinks += 1;
    }
  }

  let tail = ".";
  if (mergeCapHit) tail = ` (merge cap ${MEMORY_OPT_MAX_COMMANDS}; re-run to apply more merges).`;
  else if (totalCapHit) tail = ` (link batch cap ${MEMORY_OPT_MAX_INTERESTS_RECONNECT_OPS}; re-run if needed).`;

  return {
    payload: { entities: [], links: linksOut, commands },
    summary: `Interests reconnect: ${merges} merge(s) for normalized-label duplicates, ${hubLinks} hub link(s)${tail}`,
  };
}

function sanitizeLlmOptimizationCommands(raw, candidateKeySet) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    if (String(c.op ?? "").trim() !== "mergeNodes") continue;
    const from = c.from;
    const into = c.into;
    if (!from || !into || typeof from !== "object" || typeof into !== "object") continue;
    const fc = String(from.category ?? "").trim();
    const fl = String(from.label ?? "").trim().slice(0, 200);
    const tc = String(into.category ?? "").trim();
    const tl = String(into.label ?? "").trim().slice(0, 200);
    if (!fc || !fl || !tc || !tl) continue;
    const k1 = `${fc}\u0000${fl}\u0000${tc}\u0000${tl}`;
    const k2 = `${tc}\u0000${tl}\u0000${fc}\u0000${fl}`;
    if (!candidateKeySet.has(k1) && !candidateKeySet.has(k2)) continue;
    out.push({
      op: "mergeNodes",
      from: { category: fc, label: fl },
      into: { category: tc, label: tl },
    });
    if (out.length >= MEMORY_OPT_MAX_COMMANDS) break;
  }
  return out;
}

function parseLlmOptimizationJson(text) {
  let s = String(text ?? "").trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();
  return JSON.parse(s);
}

async function buildLlmCheckOptimizationPayload(rawGraph, providerId, apiKey) {
  const nodes = Array.isArray(rawGraph?.nodes) ? rawGraph.nodes : [];
  const pairs = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    const ac = String(a?.category ?? "").trim();
    const al = String(a?.label ?? "").trim();
    const an = memoryOptNormText(al);
    if (!ac || !al || !an) continue;
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      const bc = String(b?.category ?? "").trim();
      const bl = String(b?.label ?? "").trim();
      const bn = memoryOptNormText(bl);
      if (!bc || !bl || !bn || ac !== bc) continue;
      const sim = memoryOptJaroWinkler(an, bn);
      if (sim < 0.94) continue;
      pairs.push({
        from: { category: ac, label: al },
        into: { category: bc, label: bl },
        score: Number(sim.toFixed(4)),
      });
      if (pairs.length >= MEMORY_OPT_MAX_LLM_PAIRS) break;
    }
    if (pairs.length >= MEMORY_OPT_MAX_LLM_PAIRS) break;
  }
  if (pairs.length === 0) {
    return {
      payload: { entities: [], links: [], commands: [] },
      summary: "LLM check: no high-similarity candidates found.",
      usage: null,
    };
  }
  const candidateKeySet = new Set(
    pairs.map(
      (p) =>
        `${p.from.category}\u0000${p.from.label}\u0000${p.into.category}\u0000${p.into.label}`,
    ),
  );
  const systemInstruction =
    "You are a strict graph quality gate. " +
    "Input contains candidate duplicate node pairs from a memory graph. " +
    "Return JSON only with shape {\"commands\":[{\"op\":\"mergeNodes\",\"from\":{\"category\":\"...\",\"label\":\"...\"},\"into\":{\"category\":\"...\",\"label\":\"...\"}}]}. " +
    "Choose merges only when two labels clearly denote the same real-world entity. " +
    "If unsure, do not merge.";
  const userPayload = JSON.stringify({ candidates: pairs });
  const { text, usage } = await completeChatMessage(providerId, userPayload, apiKey, {
    systemInstruction,
  });
  const parsed = parseLlmOptimizationJson(text);
  const commands = sanitizeLlmOptimizationCommands(parsed?.commands, candidateKeySet);
  const usageSafe = ensureUsageTotals(usage, userPayload, text);
  return {
    payload: { entities: [], links: [], commands },
    summary: `LLM check: ${pairs.length} candidate pair(s), ${commands.length} merge command(s) approved.`,
    usage: usageSafe,
  };
}

/** Centered Settings dialog (UI shell only; no Escape close — unlike Activity / Favorites). */
function initSettingsModal() {
  const modal = document.getElementById("settings-modal");
  const openBtn = document.getElementById("btn-settings");
  const closeBtn = document.getElementById("settings-modal-close");
  if (!modal || !openBtn || !closeBtn) return;

  /** Cancels in-flight Memory tree export when Settings closes. */
  let memoryTreeExportAbort = null;
  /** Cancels in-flight Memory tree import when Settings closes. */
  let memoryTreeImportAbort = null;
  /** Cancels in-flight Project profile export. */
  let projectProfileExportAbort = null;
  /** Cancels in-flight Project profile import. */
  let projectProfileImportAbort = null;
  /** @type {File | null} */
  let pendingProjectProfileImportFile = null;

  initSettingsModelSelects({
    onSave() {
      appendActivityLog("AI models saved");
    },
  });
  initSettingsAiPriorityBadges();
  initChatAnalysisPrioritySettings({
    onSave() {
      appendActivityLog("Chat analysis priority saved");
    },
  });

  const settingsAiLoading = document.getElementById("settings-ai-loading");
  const settingsModalMainPanel = document.getElementById("settings-modal-main-panel");
  const settingsProjectCacheConfirm = document.getElementById("settings-project-cache-confirm");
  const settingsProjectCacheClearBtn = document.getElementById("settings-project-cache-clear-btn");
  const settingsProjectCacheConfirmNo = document.getElementById("settings-project-cache-confirm-no");
  const settingsProjectCacheConfirmYes = document.getElementById("settings-project-cache-confirm-yes");
  const settingsProjectCacheDbOtherMb = document.getElementById("settings-project-cache-db-other-mb");
  const settingsProjectCacheDbMediaMb = document.getElementById("settings-project-cache-db-media-mb");
  const settingsProjectCacheDataDirMb = document.getElementById("settings-project-cache-data-dir-mb");
  const settingsProjectCacheSoundMb = document.getElementById("settings-project-cache-sound-mb");

  /** @param {number} bytes */
  function formatProjectCacheMegabytes(bytes) {
    const n = Number(bytes);
    const mb = Number.isFinite(n) && n > 0 ? n / (1024 * 1024) : 0;
    return `${mb.toFixed(1)} Mb`;
  }

  async function refreshProjectCacheStatsUi() {
    const cacheCells = [
      settingsProjectCacheDbOtherMb,
      settingsProjectCacheDbMediaMb,
      settingsProjectCacheDataDirMb,
      settingsProjectCacheSoundMb,
    ];
    if (!cacheCells.every((c) => c instanceof HTMLElement)) return;
    for (const c of cacheCells) c.textContent = "…";
    try {
      const s = await fetchProjectCacheStats();
      settingsProjectCacheDbOtherMb.textContent = formatProjectCacheMegabytes(s.chatDbOtherApproxBytes);
      settingsProjectCacheDbMediaMb.textContent = formatProjectCacheMegabytes(s.chatEmbeddedMediaBytes);
      settingsProjectCacheDataDirMb.textContent = formatProjectCacheMegabytes(s.dataDirCacheBytes);
      settingsProjectCacheSoundMb.textContent = formatProjectCacheMegabytes(s.soundFilesBytes);
    } catch {
      for (const c of cacheCells) {
        if (c instanceof HTMLElement) c.textContent = "—";
      }
    }
  }

  function hideProjectCacheConfirmView() {
    if (settingsProjectCacheConfirm instanceof HTMLElement) {
      settingsProjectCacheConfirm.hidden = true;
    }
    if (settingsModalMainPanel instanceof HTMLElement) {
      settingsModalMainPanel.hidden = false;
    }
  }

  function showProjectCacheConfirmView() {
    if (settingsModalMainPanel instanceof HTMLElement) {
      settingsModalMainPanel.hidden = true;
    }
    if (settingsProjectCacheConfirm instanceof HTMLElement) {
      settingsProjectCacheConfirm.hidden = false;
    }
  }

  const projectProfileExportModal = document.getElementById("project-profile-export-modal");
  const projectProfilePass1 = document.getElementById("project-profile-export-pass1");
  const projectProfilePass2 = document.getElementById("project-profile-export-pass2");
  const projectProfileHint = document.getElementById("project-profile-export-hint");
  const projectProfileCancel = document.getElementById("project-profile-export-cancel");
  const projectProfileSubmit = document.getElementById("project-profile-export-submit");
  const projectProfileSettingsExportBtn = document.getElementById("settings-project-profile-export");
  const projectProfileImportModal = document.getElementById("project-profile-import-modal");
  const ppiPanelPassword = document.getElementById("ppi-panel-password");
  const ppiPanelWrong = document.getElementById("ppi-panel-wrong");
  const ppiPanelSuccess = document.getElementById("ppi-panel-success");
  const ppiPassword = document.getElementById("ppi-password");
  const ppiFileInfo = document.getElementById("ppi-file-info");
  const ppiCancel = document.getElementById("ppi-cancel");
  const ppiImport = document.getElementById("ppi-import");
  const ppiWrongOk = document.getElementById("ppi-wrong-ok");
  const ppiSuccessOk = document.getElementById("ppi-success-ok");
  const ppiSuccessMsg = document.getElementById("ppi-success-msg");
  const projectProfileSettingsImportBtn = document.getElementById("settings-project-profile-import");
  const projectProfileImportInput = document.getElementById("settings-project-profile-import-input");

  function showPpiPanel(which) {
    if (ppiPanelPassword instanceof HTMLElement) {
      ppiPanelPassword.hidden = which !== "password";
    }
    if (ppiPanelWrong instanceof HTMLElement) {
      ppiPanelWrong.hidden = which !== "wrong";
    }
    if (ppiPanelSuccess instanceof HTMLElement) {
      ppiPanelSuccess.hidden = which !== "success";
    }
    window.requestAnimationFrame(() => {
      if (which === "success" && ppiSuccessOk instanceof HTMLButtonElement) {
        ppiSuccessOk.focus();
      } else if (which === "wrong" && ppiWrongOk instanceof HTMLButtonElement) {
        ppiWrongOk.focus();
      }
    });
  }

  function updatePpiImportButtonState() {
    const pw = ppiPassword instanceof HTMLInputElement ? ppiPassword.value.trim() : "";
    const busy =
      ppiImport instanceof HTMLButtonElement && ppiImport.classList.contains("settings-export-btn--busy");
    if (ppiImport instanceof HTMLButtonElement) {
      ppiImport.disabled = !pendingProjectProfileImportFile || !pw || busy;
    }
  }

  function resetProjectProfileImportFlow() {
    projectProfileImportAbort?.abort();
    projectProfileImportAbort = null;
    pendingProjectProfileImportFile = null;
    if (!(projectProfileImportModal instanceof HTMLElement)) return;
    projectProfileImportModal.hidden = true;
    if (ppiPassword instanceof HTMLInputElement) {
      ppiPassword.value = "";
    }
    if (ppiFileInfo instanceof HTMLElement) {
      ppiFileInfo.textContent = "";
    }
    if (ppiImport instanceof HTMLButtonElement) {
      ppiImport.classList.remove("settings-export-btn--busy");
      ppiImport.removeAttribute("aria-busy");
      ppiImport.disabled = true;
    }
    if (ppiCancel instanceof HTMLButtonElement) {
      ppiCancel.disabled = false;
    }
    showPpiPanel("password");
  }

  function openProjectProfileImportFlow(file) {
    pendingProjectProfileImportFile = file;
    if (ppiFileInfo instanceof HTMLElement) {
      ppiFileInfo.textContent = `Selected file: ${file.name}`;
    }
    showPpiPanel("password");
    if (projectProfileImportModal instanceof HTMLElement) {
      projectProfileImportModal.hidden = false;
    }
    if (ppiPassword instanceof HTMLInputElement) {
      ppiPassword.focus();
    }
    updatePpiImportButtonState();
  }

  function updateProjectProfileExportFormState() {
    if (!(projectProfileSubmit instanceof HTMLButtonElement)) return;
    const p1 = projectProfilePass1 instanceof HTMLInputElement ? projectProfilePass1.value : "";
    const p2 = projectProfilePass2 instanceof HTMLInputElement ? projectProfilePass2.value : "";
    const errs = getProjectProfilePasswordErrors(p1);
    const busy =
      projectProfileSubmit instanceof HTMLButtonElement &&
      projectProfileSubmit.classList.contains("settings-export-btn--busy");
    let hint = "";
    if (busy) {
      hint = "Creating encrypted archive…";
    } else if (errs.length) {
      hint = `Password must include: ${errs.join("; ")}.`;
    } else if (p2.length > 0 && p1 !== p2) {
      hint = "The two passwords do not match.";
    }
    if (projectProfileHint instanceof HTMLElement) {
      projectProfileHint.textContent = hint;
    }
    const ok = errs.length === 0 && p1.length >= 8 && p1 === p2;
    if (projectProfileSubmit instanceof HTMLButtonElement) {
      projectProfileSubmit.disabled = !ok || busy;
    }
    if (projectProfileCancel instanceof HTMLButtonElement) {
      projectProfileCancel.disabled = busy;
    }
  }

  function resetProjectProfileExportModalToIdle() {
    projectProfileExportAbort?.abort();
    projectProfileExportAbort = null;
    if (!(projectProfileExportModal instanceof HTMLElement)) {
      return;
    }
    projectProfileExportModal.hidden = true;
    if (projectProfilePass1 instanceof HTMLInputElement) {
      projectProfilePass1.value = "";
    }
    if (projectProfilePass2 instanceof HTMLInputElement) {
      projectProfilePass2.value = "";
    }
    if (projectProfileSubmit instanceof HTMLButtonElement) {
      projectProfileSubmit.classList.remove("settings-export-btn--busy");
      projectProfileSubmit.removeAttribute("aria-busy");
      projectProfileSubmit.disabled = true;
    }
    if (projectProfileCancel instanceof HTMLButtonElement) {
      projectProfileCancel.disabled = false;
    }
    updateProjectProfileExportFormState();
  }

  function setOpen(open) {
    if (open) {
      hideProjectCacheConfirmView();
      resetProjectProfileExportModalToIdle();
      refreshSettingsAiPriorityBadges();
      /**
       * Opening Settings: cancel an in-progress import (password step only).
       * Do not reset while success / wrong-password screens are shown — those close only with OK.
       */
      if (projectProfileImportModal instanceof HTMLElement && !projectProfileImportModal.hidden) {
        const onOutcomeScreen =
          (ppiPanelWrong instanceof HTMLElement && !ppiPanelWrong.hidden) ||
          (ppiPanelSuccess instanceof HTMLElement && !ppiPanelSuccess.hidden);
        if (!onOutcomeScreen) {
          resetProjectProfileImportFlow();
        }
      }
    }
    if (!open) {
      hideProjectCacheConfirmView();
      closeAllSettingsModelPickers();
      memoryTreeExportAbort?.abort();
      memoryTreeExportAbort = null;
      memoryTreeImportAbort?.abort();
      memoryTreeImportAbort = null;
      for (const btn of memoryOptButtons) {
        btn.classList.remove("settings-memory-opt-btn--ok");
      }
      if (settingsAiLoading instanceof HTMLElement) {
        settingsAiLoading.hidden = true;
      }
    }
    modal.hidden = !open;
    openBtn.setAttribute("aria-expanded", open ? "true" : "false");
    openBtn.setAttribute("aria-label", open ? "Close settings" : "Open settings");
  }

  openBtn.addEventListener("click", () => {
    const opening = modal.hidden;
    setOpen(modal.hidden);
    if (opening) {
      refreshChatAnalysisPrioritySettings();
      void refreshProjectCacheStatsUi();
      if (settingsAiLoading instanceof HTMLElement) {
        settingsAiLoading.hidden = false;
      }
      void refreshSettingsModelSelects().finally(() => {
        if (!modal.hidden && settingsAiLoading instanceof HTMLElement) {
          settingsAiLoading.hidden = true;
        }
      });
    }
  });

  closeBtn.addEventListener("click", () => {
    setOpen(false);
  });

  if (settingsProjectCacheClearBtn instanceof HTMLButtonElement) {
    settingsProjectCacheClearBtn.addEventListener("click", () => {
      showProjectCacheConfirmView();
      if (settingsProjectCacheConfirmNo instanceof HTMLButtonElement) {
        settingsProjectCacheConfirmNo.focus();
      }
    });
  }
  if (settingsProjectCacheConfirmNo instanceof HTMLButtonElement) {
    settingsProjectCacheConfirmNo.addEventListener("click", () => {
      hideProjectCacheConfirmView();
    });
  }
  if (settingsProjectCacheConfirmYes instanceof HTMLButtonElement) {
    settingsProjectCacheConfirmYes.addEventListener("click", async () => {
      const y = settingsProjectCacheConfirmYes;
      const n = settingsProjectCacheConfirmNo;
      if (y instanceof HTMLButtonElement) {
        y.disabled = true;
        y.classList.add("settings-export-btn--busy");
        y.setAttribute("aria-busy", "true");
      }
      if (n instanceof HTMLButtonElement) n.disabled = true;
      try {
        const { filesRemoved, bytesFreed, turnsUpdated, vacuumWarning } = await clearProjectMultimediaCache();
        hideProjectCacheConfirmView();
        await refreshProjectCacheStatsUi();
        appendActivityLog(
          `Project multimedia cache cleared (${filesRemoved} on-disk file(s), ${turnsUpdated} chat turn(s) updated, ${formatProjectCacheMegabytes(bytesFreed)} estimated payload freed).`,
        );
        if (vacuumWarning) {
          appendActivityLog(`Database compact (VACUUM) did not complete: ${vacuumWarning}`);
        }
      } catch (e) {
        appendActivityLog(
          `Clear multimedia cache failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        if (y instanceof HTMLButtonElement) {
          y.disabled = false;
          y.classList.remove("settings-export-btn--busy");
          y.removeAttribute("aria-busy");
        }
        if (n instanceof HTMLButtonElement) n.disabled = false;
      }
    });
  }

  const memoryTreeExportBtn = document.getElementById("settings-memory-tree-export");
  if (memoryTreeExportBtn instanceof HTMLButtonElement) {
    memoryTreeExportBtn.addEventListener("click", async () => {
      memoryTreeExportAbort?.abort();
      memoryTreeExportAbort = new AbortController();
      const { signal } = memoryTreeExportAbort;
      memoryTreeExportBtn.classList.add("settings-export-btn--busy");
      memoryTreeExportBtn.setAttribute("aria-busy", "true");
      memoryTreeExportBtn.disabled = true;
      try {
        const fn = await downloadMemoryTreeTarGz(signal);
        appendActivityLog(`Memory tree: exported as ${fn}.`);
      } catch (e) {
        const aborted = typeof e === "object" && e !== null && /** @type {{ name?: string }} */ (e).name === "AbortError";
        if (aborted) {
          appendActivityLog("Memory tree export: cancelled.");
        } else {
          appendActivityLog(
            `Memory tree export failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      } finally {
        memoryTreeExportBtn.classList.remove("settings-export-btn--busy");
        memoryTreeExportBtn.removeAttribute("aria-busy");
        memoryTreeExportBtn.disabled = false;
        memoryTreeExportAbort = null;
      }
    });
  }

  const memoryTreeImportBtn = document.getElementById("settings-memory-tree-import");
  const memoryTreeImportInput = document.getElementById("settings-memory-tree-import-input");
  if (memoryTreeImportBtn instanceof HTMLButtonElement && memoryTreeImportInput instanceof HTMLInputElement) {
    memoryTreeImportBtn.addEventListener("click", () => {
      memoryTreeImportInput.value = "";
      memoryTreeImportInput.click();
    });
    memoryTreeImportInput.addEventListener("change", () => {
      const file = memoryTreeImportInput.files?.[0];
      memoryTreeImportInput.value = "";
      if (!file) return;
      const kind = memoryTreeImportFileKind(file);
      if (!kind) {
        appendActivityLog("Memory tree import: choose a .json file or a .tar.gz archive from Export.");
        return;
      }
      void (async () => {
        memoryTreeImportAbort?.abort();
        memoryTreeImportAbort = new AbortController();
        const { signal } = memoryTreeImportAbort;
        memoryTreeImportBtn.classList.add("settings-export-btn--busy");
        memoryTreeImportBtn.setAttribute("aria-busy", "true");
        memoryTreeImportBtn.disabled = true;
        try {
          /** @type {{ nodesImported: number, edgesImported: number }} */
          let counts;
          if (kind === "json") {
            const text = await file.text();
            counts = await importMemoryGraphReplace(text, "application/json", { signal });
          } else {
            const buf = await file.arrayBuffer();
            counts = await importMemoryGraphReplace(buf, "application/gzip", { signal });
          }
          const raw = await fetchMemoryGraphFromApi({ signal });
          setMemoryGraphData(enrichMemoryGraphFromApi(raw));
          setOpen(false);
          showMemoryTreeImportSuccessModal(counts.nodesImported, counts.edgesImported);
        } catch (e) {
          const aborted =
            typeof e === "object" &&
            e !== null &&
            /** @type {{ name?: string }} */ (e).name === "AbortError";
          if (aborted) {
            appendActivityLog("Memory tree import: cancelled.");
          } else {
            appendActivityLog(
              `Memory tree import failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        } finally {
          memoryTreeImportBtn.classList.remove("settings-export-btn--busy");
          memoryTreeImportBtn.removeAttribute("aria-busy");
          memoryTreeImportBtn.disabled = false;
          memoryTreeImportAbort = null;
        }
      })();
    });
  }

  const memoryOptRecordLinkageBtn = document.getElementById("settings-memory-opt-record-linkage");
  const memoryOptKnowledgeBtn = document.getElementById("settings-memory-opt-knowledge-consistency");
  const memoryOptLlmCheckBtn = document.getElementById("settings-memory-opt-llm-check");
  const memoryOptInterestsReconnectBtn = document.getElementById("settings-memory-opt-interests-reconnect");
  const memoryOptButtons = [
    memoryOptRecordLinkageBtn,
    memoryOptKnowledgeBtn,
    memoryOptLlmCheckBtn,
    memoryOptInterestsReconnectBtn,
  ].filter((x) => x instanceof HTMLButtonElement);
  let memoryOptimizationRunning = false;
  /** @type {string} */
  let memoryOptimizationActiveId = "";

  function syncMemoryOptimizationButtons() {
    for (const btn of memoryOptButtons) {
      const isActive = memoryOptimizationRunning && btn.id === memoryOptimizationActiveId;
      if (isActive) {
        btn.classList.add("settings-export-btn--busy");
        btn.setAttribute("aria-busy", "true");
      } else {
        btn.classList.remove("settings-export-btn--busy");
        btn.removeAttribute("aria-busy");
      }
      btn.disabled = memoryOptimizationRunning;
    }
  }

  function showMemoryOptimizationSuccess(buttonId) {
    for (const btn of memoryOptButtons) {
      if (btn.id === buttonId) btn.classList.add("settings-memory-opt-btn--ok");
    }
  }

  async function runMemoryOptimization(kind, buttonId) {
    if (memoryOptimizationRunning) return;
    const activeBtn = memoryOptButtons.find((b) => b.id === buttonId);
    activeBtn?.classList.remove("settings-memory-opt-btn--ok");
    memoryOptimizationRunning = true;
    memoryOptimizationActiveId = buttonId;
    syncMemoryOptimizationButtons();
    appendActivityLog(`Memory tree optimization: ${kind} started.`);
    try {
      const rawGraph = await fetchMemoryGraphFromApi();
      /** @type {{ payload: {entities: unknown[], links: unknown[], commands: unknown[]}, summary: string, usage?: { promptTokens: number, completionTokens: number, totalTokens: number } | null }} */
      let out;
      if (kind === "record linkage") {
        out = buildRecordLinkageOptimizationPayload(rawGraph);
      } else if (kind === "knowledge consistency") {
        out = buildKnowledgeConsistencyOptimizationPayload(rawGraph);
      } else if (kind === "interests reconnect") {
        out = buildInterestsOrphanReconnectPayload(rawGraph);
      } else {
        const keeperPick = pickKeeperProviderWithKey();
        const pid = String(keeperPick.providerId ?? "").trim();
        const key = String(keeperPick.apiKey ?? "").trim();
        if (!pid || !key) {
          throw new Error("LLM check requires at least one model API key in .env");
        }
        out = await buildLlmCheckOptimizationPayload(rawGraph, pid, key);
        const usageForAnalytics = ensureUsageTotals(
          out.usage ?? null,
          JSON.stringify({ kind: "optimizer_llm_check", payload: out.payload ?? {} }),
          String(out.summary ?? "LLM check"),
        );
        await recordAuxLlmUsage({
          provider_id: pid,
          request_kind: "optimizer_llm_check",
          llm_prompt_tokens: usageForAnalytics.promptTokens,
          llm_completion_tokens: usageForAnalytics.completionTokens,
          llm_total_tokens: usageForAnalytics.totalTokens,
        }).catch((e) => {
          appendActivityLog(
            `Memory tree optimization (llm check): analytics record failed — ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      }
      const commandsCount = Array.isArray(out.payload?.commands) ? out.payload.commands.length : 0;
      const linksCount = Array.isArray(out.payload?.links) ? out.payload.links.length : 0;
      if (commandsCount === 0 && linksCount === 0) {
        appendActivityLog(`${out.summary} No graph changes to apply.`);
        showMemoryOptimizationSuccess(buttonId);
        return;
      }
      const ingest = await ingestMemoryGraphPayload(out.payload);
      const refreshed = await fetchMemoryGraphFromApi();
      setMemoryGraphData(enrichMemoryGraphFromApi(refreshed));
      const cmdApplied = ingest?.commandsApplied
        ? Object.entries(ingest.commandsApplied)
            .filter(([, v]) => Number(v) > 0)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ")
        : "";
      appendActivityLog(
        `${out.summary} Applied (upserted: ${Number(ingest?.upsertedEntities) || 0}, inserted links: ${Number(ingest?.insertedLinks) || 0}${cmdApplied ? `; commands ${cmdApplied}` : ""}).`,
      );
      await refreshAnalyticsViewIfOpen().catch(() => {});
      showMemoryOptimizationSuccess(buttonId);
    } catch (e) {
      appendActivityLog(
        `Memory tree optimization (${kind}) failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      memoryOptimizationRunning = false;
      memoryOptimizationActiveId = "";
      syncMemoryOptimizationButtons();
    }
  }

  if (memoryOptRecordLinkageBtn instanceof HTMLButtonElement) {
    memoryOptRecordLinkageBtn.addEventListener("click", () => {
      void runMemoryOptimization("record linkage", memoryOptRecordLinkageBtn.id);
    });
  }
  if (memoryOptKnowledgeBtn instanceof HTMLButtonElement) {
    memoryOptKnowledgeBtn.addEventListener("click", () => {
      void runMemoryOptimization("knowledge consistency", memoryOptKnowledgeBtn.id);
    });
  }
  if (memoryOptLlmCheckBtn instanceof HTMLButtonElement) {
    memoryOptLlmCheckBtn.addEventListener("click", () => {
      void runMemoryOptimization("llm check", memoryOptLlmCheckBtn.id);
    });
  }
  if (memoryOptInterestsReconnectBtn instanceof HTMLButtonElement) {
    memoryOptInterestsReconnectBtn.addEventListener("click", () => {
      void runMemoryOptimization("interests reconnect", memoryOptInterestsReconnectBtn.id);
    });
  }
  syncMemoryOptimizationButtons();

  if (
    projectProfileExportModal instanceof HTMLElement &&
    projectProfilePass1 instanceof HTMLInputElement &&
    projectProfilePass2 instanceof HTMLInputElement &&
    projectProfileCancel instanceof HTMLButtonElement &&
    projectProfileSubmit instanceof HTMLButtonElement &&
    projectProfileSettingsExportBtn instanceof HTMLButtonElement
  ) {
    function openProjectProfileExportModal() {
      projectProfilePass1.value = "";
      projectProfilePass2.value = "";
      projectProfileExportModal.hidden = false;
      updateProjectProfileExportFormState();
      projectProfilePass1.focus();
    }

    projectProfileSettingsExportBtn.addEventListener("click", () => {
      setOpen(false);
      openProjectProfileExportModal();
    });

    projectProfilePass1.addEventListener("input", () => {
      updateProjectProfileExportFormState();
    });
    projectProfilePass2.addEventListener("input", () => {
      updateProjectProfileExportFormState();
    });

    projectProfileCancel.addEventListener("click", () => {
      resetProjectProfileExportModalToIdle();
    });

    projectProfileSubmit.addEventListener("click", () => {
      const p1 = projectProfilePass1.value;
      const p2 = projectProfilePass2.value;
      if (getProjectProfilePasswordErrors(p1).length || p1 !== p2) return;
      projectProfileExportAbort?.abort();
      projectProfileExportAbort = new AbortController();
      const { signal } = projectProfileExportAbort;
      projectProfileSubmit.classList.add("settings-export-btn--busy");
      projectProfileSubmit.setAttribute("aria-busy", "true");
      updateProjectProfileExportFormState();
      void (async () => {
        try {
          const fn = await runProjectProfileExportDownload(p1, signal);
          appendActivityLog(`Project profile: exported as ${fn}.`);
          resetProjectProfileExportModalToIdle();
        } catch (e) {
          const aborted =
            typeof e === "object" && e !== null && /** @type {{ name?: string }} */ (e).name === "AbortError";
          if (aborted) {
            appendActivityLog("Project profile export: cancelled.");
          } else {
            appendActivityLog(
              `Project profile export failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        } finally {
          projectProfileSubmit.classList.remove("settings-export-btn--busy");
          projectProfileSubmit.removeAttribute("aria-busy");
          projectProfileExportAbort = null;
          updateProjectProfileExportFormState();
        }
      })();
    });

    document.addEventListener(
      "keydown",
      (e) => {
        if (!(projectProfileExportModal instanceof HTMLElement) || projectProfileExportModal.hidden) return;
        if (e.key !== "Escape") return;
        const busy = projectProfileSubmit.classList.contains("settings-export-btn--busy");
        if (busy) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        resetProjectProfileExportModalToIdle();
      },
      true,
    );
  }

  if (
    projectProfileImportModal instanceof HTMLElement &&
    ppiPanelPassword instanceof HTMLElement &&
    ppiPanelWrong instanceof HTMLElement &&
    ppiPanelSuccess instanceof HTMLElement &&
    ppiPassword instanceof HTMLInputElement &&
    ppiFileInfo instanceof HTMLElement &&
    ppiCancel instanceof HTMLButtonElement &&
    ppiImport instanceof HTMLButtonElement &&
    ppiWrongOk instanceof HTMLButtonElement &&
    ppiSuccessOk instanceof HTMLButtonElement &&
    ppiSuccessMsg instanceof HTMLElement &&
    projectProfileSettingsImportBtn instanceof HTMLButtonElement &&
    projectProfileImportInput instanceof HTMLInputElement
  ) {
    projectProfileSettingsImportBtn.addEventListener("click", () => {
      projectProfileImportInput.value = "";
      projectProfileImportInput.click();
    });
    projectProfileImportInput.addEventListener("change", () => {
      const file = projectProfileImportInput.files?.[0];
      projectProfileImportInput.value = "";
      if (!file) return;
      const n = file.name.toLowerCase();
      if (!n.endsWith(".mf")) {
        appendActivityLog("Project profile import: choose a .mf backup file.");
        return;
      }
      setOpen(false);
      openProjectProfileImportFlow(file);
    });
    ppiPassword.addEventListener("input", () => {
      updatePpiImportButtonState();
    });
    ppiCancel.addEventListener("click", () => {
      resetProjectProfileImportFlow();
    });
    ppiWrongOk.addEventListener("click", () => {
      resetProjectProfileImportFlow();
    });
    ppiSuccessOk.addEventListener("click", () => {
      clearProfileImportSuccessFlash();
      resetProjectProfileImportFlow();
    });
    ppiImport.addEventListener("click", () => {
      if (!pendingProjectProfileImportFile || !(ppiPassword instanceof HTMLInputElement)) return;
      const plain = ppiPassword.value.trim();
      if (!plain) return;
      projectProfileImportAbort?.abort();
      projectProfileImportAbort = new AbortController();
      const { signal } = projectProfileImportAbort;
      ppiImport.classList.add("settings-export-btn--busy");
      ppiImport.setAttribute("aria-busy", "true");
      updatePpiImportButtonState();
      if (ppiCancel instanceof HTMLButtonElement) {
        ppiCancel.disabled = true;
      }
      const file = pendingProjectProfileImportFile;
      void (async () => {
        try {
          const { summary } = await runProjectProfileImportFromFile(file, plain, signal);
          setProfileImportSuccessFlash();
          const s = summary || {};
          ppiSuccessMsg.textContent = PROFILE_IMPORT_SUCCESS_INFORMER_TEXT;
          showPpiPanel("success");
          appendActivityLog(
            `Project profile import: ${s.memoryNodes ?? "?"} nodes, ${s.memoryEdges ?? "?"} edges, ${s.accessRows ?? "?"} Access rows, ${s.rulesRows ?? "?"} rules rows.`,
          );
          try {
            const raw = await fetchMemoryGraphFromApi({ signal });
            setMemoryGraphData(enrichMemoryGraphFromApi(raw));
            await refreshSettingsModelSelects();
            refreshChatAnalysisPrioritySettings();
          } catch (refreshErr) {
            const refreshAborted =
              typeof refreshErr === "object" &&
              refreshErr !== null &&
              /** @type {{ name?: string }} */ (refreshErr).name === "AbortError";
            if (!refreshAborted) {
              appendActivityLog(
                `Project profile: UI refresh after import failed: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`,
              );
            }
          }
        } catch (e) {
          const wrong = e instanceof Error && e.message === "WRONG_ARCHIVE_PASSWORD";
          if (wrong) {
            showPpiPanel("wrong");
          } else {
            const aborted =
              typeof e === "object" && e !== null && /** @type {{ name?: string }} */ (e).name === "AbortError";
            if (aborted) {
              appendActivityLog("Project profile import: cancelled.");
            } else {
              appendActivityLog(
                `Project profile import failed: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
            resetProjectProfileImportFlow();
          }
        } finally {
          ppiImport.classList.remove("settings-export-btn--busy");
          ppiImport.removeAttribute("aria-busy");
          if (ppiCancel instanceof HTMLButtonElement) {
            ppiCancel.disabled = false;
          }
          projectProfileImportAbort = null;
          updatePpiImportButtonState();
        }
      })();
    });
    document.addEventListener(
      "keydown",
      (e) => {
        if (!(projectProfileImportModal instanceof HTMLElement) || projectProfileImportModal.hidden) return;
        if (e.key !== "Escape") return;
        const busy = ppiImport.classList.contains("settings-export-btn--busy");
        if (busy) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (
          (ppiPanelWrong instanceof HTMLElement && !ppiPanelWrong.hidden) ||
          (ppiPanelSuccess instanceof HTMLElement && !ppiPanelSuccess.hidden)
        ) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        resetProjectProfileImportFlow();
      },
      true,
    );

    try {
      if (sessionStorage.getItem(PROFILE_IMPORT_SUCCESS_FLASH_STORAGE_KEY) === "1") {
        ppiSuccessMsg.textContent = PROFILE_IMPORT_SUCCESS_INFORMER_TEXT;
        projectProfileImportModal.hidden = false;
        if (ppiPassword instanceof HTMLInputElement) {
          ppiPassword.value = "";
        }
        if (ppiFileInfo instanceof HTMLElement) {
          ppiFileInfo.textContent = "";
        }
        showPpiPanel("success");
        updatePpiImportButtonState();
      }
    } catch {
      /* ignore */
    }
  }
}

const versionEl = document.getElementById("app-version");
if (versionEl) {
  versionEl.textContent = `v${pkg.version ?? "0.0.1"}`;
}

/** Default order for picking the active provider */
const PROVIDER_ORDER = ["openai", "perplexity", "gemini-flash", "anthropic"];
const DEFAULT_CHAT_PROVIDER_STORAGE_KEY = "mf0.settings.defaultChatProvider";

function providerHasKey(keys, id) {
  return Boolean(String(keys[id] ?? "").trim());
}

function getDefaultChatProvider() {
  try {
    const raw = String(localStorage.getItem(DEFAULT_CHAT_PROVIDER_STORAGE_KEY) ?? "").trim();
    return PROVIDER_ORDER.includes(raw) ? raw : "";
  } catch {
    return "";
  }
}

function setDefaultChatProvider(providerId) {
  const pid = String(providerId ?? "").trim();
  if (!PROVIDER_ORDER.includes(pid)) return;
  try {
    localStorage.setItem(DEFAULT_CHAT_PROVIDER_STORAGE_KEY, pid);
  } catch {
    /* ignore */
  }
}

/**
 * Picks a provider/key for Keeper analysis only (Memory tree ingest helpers).
 * This must not affect the provider the user picked for the visible chat reply.
 */
function pickKeeperProviderWithKey() {
  const keys = getModelApiKeys();
  for (const id of getChatAnalysisPriority()) {
    const key = String(keys[id] ?? "").trim();
    if (key) return { providerId: id, apiKey: key };
  }
  return { providerId: "", apiKey: "" };
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
/** AI talks runtime control for loop stop/cancel. */
const aiTalksRuntime = {
  running: false,
  stopRequested: false,
  abortController: null,
};

/**
 * Persisted across pauses: same dialog until user continues, Stop, or reset.
 * @type {null | {
 *   dialogId: string,
 *   topic: string,
 *   ordered: string[],
 *   transcript: Array<{ providerId: string, text: string }>,
 *   speakerId: string,
 *   cloneRootTurnId: string | null,
 *   awaitingUser: boolean,
 *   anchorUserMessageAt: string,
 * }}
 */
let aiTalksSession = null;

/** Set from `initAttachMenu` so AI talks can refresh Stop visibility after pausing. */
let syncAttachButtonExternal = null;

function clearAiTalksSession() {
  aiTalksSession = null;
}

function isAbortErrorLike(err) {
  if (!err) return false;
  const n = String(err?.name ?? "").toLowerCase();
  const m = String(err?.message ?? "").toLowerCase();
  return n === "aborterror" || m.includes("aborted") || m.includes("abort");
}

/** Provider ids with API keys, user’s active model first (for AI talks handoff list). */
function aiTalksProvidersWithKeysOrdered(primaryProviderId) {
  const keys = getModelApiKeys();
  const ordered = [primaryProviderId, ...PROVIDER_ORDER.filter((id) => id && id !== primaryProviderId)];
  /** @type {string[]} */
  const out = [];
  for (const id of ordered) {
    if (!id || out.includes(id)) continue;
    if (String(keys[id] ?? "").trim()) out.push(id);
  }
  return out;
}

function hasAtLeastTwoModelKeys() {
  const keys = getModelApiKeys();
  let n = 0;
  for (const id of PROVIDER_ORDER) {
    if (String(keys[id] ?? "").trim()) n += 1;
    if (n >= 2) return true;
  }
  return false;
}

const AI_TALKS_HANDOFF_RE =
  /HANDOFF:\s*(openai|anthropic|gemini-flash|perplexity)\s*$/im;
const AI_TALKS_MAX_TURNS = 20;
const AI_TALKS_ROUTING_GUIDE = [
  "- If the task needs creative ideation or non-obvious options -> HANDOFF: openai (ChatGPT).",
  "- If someone must check current web facts/sources -> HANDOFF: gemini-flash (Gemini).",
  "- If the team needs dry trade-off weighing / objective structure -> HANDOFF: perplexity (Perplexity).",
  "- If you need critical evaluation, risk review, or quality judgment -> HANDOFF: anthropic (Claude).",
  "- Do not rotate models mechanically. Choose based on what is needed next to solve the user's task.",
].join("\n");

/**
 * @param {string} raw
 * @returns {{ clean: string, handoffId: string }}
 */
function parseAiTalksHandoff(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(AI_TALKS_HANDOFF_RE);
  if (!m) return { clean: s, handoffId: "" };
  const handoffId = String(m[1] ?? "").trim();
  const clean = s.replace(AI_TALKS_HANDOFF_RE, "").trim();
  return { clean, handoffId };
}

/**
 * Rounds 3, 4, 5, 8, 9, 10, … — ask the human as arbiter (every block of five, last three rounds).
 * @param {number} roundNo 1-based index of the reply being generated
 */
function aiTalksWantsUserArbiter(roundNo) {
  if (roundNo < 3) return false;
  const r = roundNo % 5;
  return r === 3 || r === 4 || r === 0;
}

/** @param {HTMLElement | null} wrap */
function setAssistantPendingThinkingLabel(wrap, label) {
  const lab = wrap?.querySelector(".msg-assistant-thinking-label");
  if (lab) lab.textContent = String(label ?? "").trim().slice(0, 120) || "Thinking…";
}

function aiTalksAiMessageCount(transcript) {
  return transcript.filter((t) => t && t.providerId && t.providerId !== "user").length;
}

/**
 * @param {string} speakerId
 * @param {{ promptTokens: number, completionTokens: number, totalTokens: number } | null | undefined} usage
 * @param {string} promptBasis
 * @param {string} body
 */
function recordAiTalksAuxUsage(speakerId, usage, promptBasis, body) {
  const u = ensureUsageTotals(usage, promptBasis, body);
  if (!u || !(Number(u.totalTokens) > 0)) return;
  void recordAuxLlmUsage({
    provider_id: speakerId,
    request_kind: "ai_talks_round",
    llm_prompt_tokens: u.promptTokens,
    llm_completion_tokens: u.completionTokens,
    llm_total_tokens: u.totalTokens,
  }).catch(() => {});
}

/**
 * @param {number} roundIndex 1-based assistant reply index in this AI talks run
 * @param {string} body
 */
function formatAiTalksAssistantBubbleBody(roundIndex, body) {
  return `**Round ${roundIndex}**\n\n${String(body ?? "").trim()}`;
}

/**
 * @param {Array<{ providerId: string, label: string, body: string }>} sections
 */
function buildAiOpinionMarkdown(sections) {
  return sections
    .map((s, i) => {
      const body = String(s?.body ?? "").trim() || "_(no content)_";
      const sep = i < sections.length - 1 ? "\n\n---\n\n" : "";
      return `### ${String(s?.label ?? s?.providerId ?? "Model")}\n${body}${sep}`;
    })
    .join("\n\n")
    .trim();
}

/**
 * @param {string} dialogId
 * @param {string} topicUserText
 * @param {string | null} cloneRootTurnId
 * @param {string} speakerId
 * @param {string} assistantMd
 * @param {string} userMessageAt
 * @param {{ promptTokens: number, completionTokens: number, totalTokens: number } | null | undefined} usage
 */
async function persistAiTalksAssistantTurn(
  dialogId,
  topicUserText,
  cloneRootTurnId,
  speakerId,
  assistantMd,
  userMessageAt,
  usage,
) {
  const u = ensureUsageTotals(usage, JSON.stringify({ aiTalks: true }), assistantMd);
  /** @type {Record<string, unknown>} */
  const payload = {
    assistant_text: assistantMd,
    requested_provider_id: speakerId,
    responding_provider_id: speakerId,
    request_type: "ai_talks",
    user_message_at: userMessageAt,
    assistant_message_at: new Date().toISOString(),
    assistant_error: 0,
    ...llmUsageTurnDbFields(u),
  };
  if (cloneRootTurnId) {
    payload.clone_user_from_turn_id = cloneRootTurnId;
  } else {
    payload.user_text = topicUserText;
  }
  return saveConversationTurn(dialogId, payload);
}

/**
 * @param {string} userTopic
 * @param {string[]} othersIds provider ids (not first speaker) that have keys
 * @param {number} roundNo 1-based current model turn
 */
function buildAiTalksFirstUserPrompt(userTopic, othersIds, roundNo) {
  const list = othersIds
    .map((id) => `- ${id} (${PROVIDER_DISPLAY[id] ?? id})`)
    .join("\n");
  return [
    `User topic:\n${String(userTopic ?? "").trim()}`,
    "",
    `Turn ${Math.max(1, roundNo)} of ${AI_TALKS_MAX_TURNS}.`,
    "You are the first speaker in a collaborative problem-solving team.",
    "Give a concrete first solution attempt (max ~180 words).",
    "Focus on moving toward a real solution, not generic discussion.",
    "",
    "Routing policy for choosing who should speak next:",
    AI_TALKS_ROUTING_GUIDE,
    "",
    "Then choose exactly ONE other model to continue the chain.",
    "Only choose from this list (each has an API key in the user setup):",
    list || "(no other models — still answer the topic, no handoff line)",
    "",
    othersIds.length
      ? "End your reply with its own final line exactly (no characters after it):\nHANDOFF: <provider_id>\nUse one of: " +
          othersIds.join(", ") +
          "."
      : "Do not add a HANDOFF line.",
  ].join("\n");
}

/**
 * @param {string} userTopic
 * @param {Array<{ providerId: string, text: string }>} transcript
 * @param {string} speakerLabel
 * @param {string[]} handoffCandidates ids excluding current speaker
 * @param {number} roundNo 1-based current model turn
 */
function buildAiTalksCritiqueUserPrompt(
  userTopic,
  transcript,
  speakerLabel,
  handoffCandidates,
  roundNo,
) {
  const thread = transcript
    .map((x, i) => {
      const who =
        x.providerId === "user"
          ? "User (arbiter)"
          : PROVIDER_DISPLAY[x.providerId] ?? x.providerId;
      return `### ${i + 1}. ${who}\n${String(x.text ?? "").trim()}`;
    })
    .join("\n\n");
  const list = handoffCandidates
    .map((id) => `- ${id} (${PROVIDER_DISPLAY[id] ?? id})`)
    .join("\n");
  return [
    `Original user topic:\n${String(userTopic ?? "").trim()}`,
    "",
    `Turn ${Math.max(1, roundNo)} of ${AI_TALKS_MAX_TURNS}.`,
    "### Thread so far",
    thread || "(empty)",
    "",
    `You are **${speakerLabel}** (next in the AI talks chain).`,
    "Critique the **last** message in the thread: weaknesses, gaps, or risks.",
    "Propose concrete improvements or a tighter solution step (max ~180 words).",
    "Prioritize actionable progress toward solving the user's problem.",
    "",
    "Routing policy for choosing who should speak next:",
    AI_TALKS_ROUTING_GUIDE,
    "",
    "Choose the next model to continue (not yourself). Only from:",
    list || "(none — end without HANDOFF)",
    "",
    handoffCandidates.length
      ? "End with its own final line exactly (no characters after it):\nHANDOFF: <provider_id>\nUse one of: " +
          handoffCandidates.join(", ") +
          "."
      : "If no other model is listed, do not add a HANDOFF line.",
  ].join("\n");
}

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
    if (composerAttachMode === "aiTalks") {
      btn.classList.add("badge--mode-locked");
      btn.disabled = false;
      btn.setAttribute("aria-disabled", "true");
      btn.title = "In AI opinion mode model selection is locked";
    } else if (composerAttachMode === "image" && IMAGE_MODE_DISABLED_PROVIDERS.has(id)) {
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
    const order = composerAttachMode === "image" ? IMAGE_CREATION_PROVIDER_PRIORITY : PROVIDER_ORDER;
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
  const preferred = getDefaultChatProvider();
  const firstOk = [preferred, ...PROVIDER_ORDER].find((id) => {
    if (!id) return false;
    const b = wrap.querySelector(`[data-provider="${id}"]`);
    return b && !b.disabled;
  });
  if (firstOk) {
    wrap.querySelector(`[data-provider="${firstOk}"]`)?.classList.add("active");
    setDefaultChatProvider(firstOk);
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
    if (pid) setDefaultChatProvider(pid);
    appendActivityLog(`Model: ${PROVIDER_DISPLAY[pid] ?? pid ?? "—"}`);
  });
}

function refreshSettingsAiPriorityBadges() {
  const wrap = document.getElementById("settings-ai-priority-badges");
  if (!(wrap instanceof HTMLElement)) return;
  const keys = getModelApiKeys();
  const defaultProvider = getDefaultChatProvider();
  /** @type {HTMLButtonElement[]} */
  const buttons = [...wrap.querySelectorAll("[data-provider]")].filter((el) => el instanceof HTMLButtonElement);

  for (const btn of buttons) {
    const id = String(btn.getAttribute("data-provider") ?? "").trim();
    if (!id) continue;
    const enabled = providerHasKey(keys, id);
    btn.classList.toggle("badge--no-key", !enabled);
    btn.disabled = !enabled;
    if (enabled) btn.removeAttribute("aria-disabled");
    else btn.setAttribute("aria-disabled", "true");
    btn.classList.remove("active");
  }

  const activeId =
    [defaultProvider, ...PROVIDER_ORDER].find((id) => {
      if (!id || !providerHasKey(keys, id)) return false;
      return buttons.some((btn) => btn.getAttribute("data-provider") === id);
    }) ?? "";

  if (activeId) {
    setDefaultChatProvider(activeId);
    const activeBtn = buttons.find((btn) => btn.getAttribute("data-provider") === activeId);
    activeBtn?.classList.add("active");
  }
}

function initSettingsAiPriorityBadges() {
  const wrap = document.getElementById("settings-ai-priority-badges");
  if (!(wrap instanceof HTMLElement) || wrap.dataset.bound === "1") return;
  wrap.dataset.bound = "1";
  wrap.addEventListener("click", (e) => {
    const t = e.target?.closest?.("[data-provider]");
    if (!(t instanceof HTMLButtonElement) || t.disabled || t.classList.contains("badge--no-key")) return;
    const pid = String(t.getAttribute("data-provider") ?? "").trim();
    if (!pid) return;
    setDefaultChatProvider(pid);
    setActiveProviderBadge(pid);
    refreshModelBadges();
    refreshSettingsAiPriorityBadges();
    appendActivityLog(`Default chat model: ${PROVIDER_DISPLAY[pid] ?? pid}`);
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
    /** @type {"intro"|"rules"|"access"|"help"|null} */
    let panel = null;
    if (chat?.classList.contains("chat--intro")) panel = "intro";
    else if (chat?.classList.contains("chat--rules")) panel = "rules";
    else if (chat?.classList.contains("chat--access")) panel = "access";
    else if (chat?.classList.contains("chat--help")) panel = "help";
    if (!panel) return;

    openIrClearThreadModal(async (confirmed) => {
      if (!confirmed) return;
      try {
        if (panel === "help") {
          helpChatLlmSession = [];
          clearHelpMessagesUiOnly();
          const vp = document.getElementById("messages-viewport");
          if (vp) vp.scrollTop = 0;
          appendActivityLog("Help: thread cleared.");
          return;
        }
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
  closeHelpChatFullyForNavigation();
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

function clearHelpMessagesUiOnly() {
  const list = document.getElementById("messages-list");
  if (list) revokeSentUserAttachmentBlobUrls(list);
  list?.replaceChildren();
}

function closeHelpChatFullyForNavigation() {
  if (!isHelpChatOpen()) return;
  closeHelpChatPanel();
  clearHelpMessagesUiOnly();
  const viewport = document.getElementById("messages-viewport");
  if (viewport) viewport.scrollTop = 0;
}

function rerenderHelpTranscriptFromSession() {
  clearHelpMessagesUiOnly();
  const pid = getActiveProviderId();
  const modelLabel = PROVIDER_DISPLAY[pid] ?? pid ?? "?";
  for (const m of helpChatLlmSession) {
    if (m.role === "user" && String(m.content ?? "").trim()) {
      appendUserMessage(String(m.content), modelLabel, {});
    } else if (m.role === "assistant" && String(m.content ?? "").trim()) {
      const pending = appendAssistantPending();
      if (pending) {
        const te = pending.querySelector(".msg-assistant-text");
        if (te) setAssistantMessageMarkdown(te, String(m.content));
        finalizeAssistantBubble(pending, String(m.content), pid, undefined, 1);
      }
    }
  }
}

function openHelpChatPanel() {
  const chat = document.getElementById("main-chat");
  if (!chat) return;
  if (isHelpChatOpen()) {
    closeHelpChatFullyForNavigation();
    document.getElementById("btn-help")?.focus();
    appendActivityLog("Help: closed");
    return;
  }
  closeAnalyticsView();
  closeMemoryTree();
  closeIrChatPanel();
  closeMobileThemesDropdown();
  activeThemeId = null;
  activeDialogId = null;
  expandedThemeDialogListThemeId = null;
  chatComposerSending = false;
  void renderThemesSidebar();
  refreshThemeHighlightsFromChat();
  resetComposerAttachUi();
  clearHelpMessagesUiOnly();
  rerenderHelpTranscriptFromSession();
  openHelpChatPanelDom();
  scrollMessagesToEnd();
  const ta = document.getElementById("chat-input");
  if (ta instanceof HTMLTextAreaElement) {
    ta.disabled = false;
    syncChatInputHeight(ta);
    ta.focus();
  }
  appendActivityLog("Help: opened");
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
  document.getElementById("btn-help")?.addEventListener("click", () => {
    openHelpChatPanel();
  });
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
    if (irChat && isHelpChatOpen()) {
      e.preventDefault();
      closeHelpChatFullyForNavigation();
      document.getElementById("btn-help")?.focus();
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
  aiTalks: "AI opinion",
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

/** Safe `download` attribute value for `<a download>`. */
function safeAttachmentDownloadBasename(name) {
  const s = String(name ?? "file")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return s || "file";
}

function buildUserMessageCopyText(rawText, _attachmentStrip, extras = {}) {
  const t = String(rawText ?? "").trim();
  if (!t && extras.accessData) return "[Access data]";
  return t;
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

/**
 * Files offered by the system clipboard (screenshots, copied files from Finder/Explorer, etc.).
 * @param {DataTransfer | null | undefined} clipboardData
 * @returns {File[]}
 */
function collectClipboardFiles(clipboardData) {
  if (!clipboardData) return [];
  /** @type {File[]} */
  const out = [];
  const seen = new Set();
  /** @param {File | null | undefined} f */
  function addFile(f) {
    if (!(f instanceof File) || f.size <= 0) return;
    const key = `${f.name}\0${f.size}\0${f.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  }
  try {
    const items = clipboardData.items ? Array.from(clipboardData.items) : [];
    for (const item of items) {
      if (item.kind !== "file") continue;
      addFile(item.getAsFile());
    }
  } catch {
    /* ignore */
  }
  try {
    const fl = clipboardData.files;
    if (fl?.length) {
      for (const f of Array.from(fl)) {
        addFile(f);
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * @param {HTMLTextAreaElement} ta
 * @param {string} insertion
 */
function insertTextAtCaret(ta, insertion) {
  const t = String(insertion ?? "");
  if (!t) return;
  const start = ta.selectionStart ?? 0;
  const end = ta.selectionEnd ?? 0;
  if (typeof ta.setRangeText === "function") {
    ta.setRangeText(t, start, end, "end");
  } else {
    ta.value = ta.value.slice(0, start) + t + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + t.length;
  }
  syncChatInputHeight(ta);
  syncComposerSendButtonState();
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
  clearAiTalksSession();
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
    closeHelpChatFullyForNavigation();
    activeThemeId = null;
    activeDialogId = null;
    expandedThemeDialogListThemeId = null;
    const list = document.getElementById("messages-list");
    if (list) revokeSentUserAttachmentBlobUrls(list);
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
  const aiTalksStopBtn = document.getElementById("btn-ai-talks-stop");
  const inputField = document.querySelector(".input-bar-field");
  const resetBtn = document.getElementById("attach-menu-reset");
  const resetSep = menu?.querySelector(".attach-menu-reset-sep");
  const aiOpinionItem = menu?.querySelector('[data-action="aiTalks"]');
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
      composerAttachMode === "aiTalks" ||
      composerAttachMode === "web" ||
        composerAttachMode === "image" ||
        composerAttachMode === "research" ||
        composerAttachMode === "accessData",
    );
    const aiTalksActive = false;
    if (aiTalksStopBtn instanceof HTMLButtonElement) {
      aiTalksStopBtn.hidden = !aiTalksActive;
    }
    if (inputField instanceof HTMLElement) {
      inputField.classList.toggle("input-bar-field--ai-talks-stop", aiTalksActive);
    }
    syncResetRow();
  }

  function syncAiOpinionItemAvailability() {
    if (!(aiOpinionItem instanceof HTMLButtonElement)) return;
    const ok = hasAtLeastTwoModelKeys();
    aiOpinionItem.disabled = !ok;
    aiOpinionItem.setAttribute("aria-disabled", ok ? "false" : "true");
    aiOpinionItem.title = ok ? "AI opinion" : "AI opinion requires at least 2 model keys in .env";
  }

  function close() {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  }

  function open() {
    syncAiOpinionItemAvailability();
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
      } else if (action === "aiTalks") {
        if (!hasAtLeastTwoModelKeys()) {
          composerAttachMode = "";
          syncAttachButton();
          refreshModelBadges();
          appendActivityLog("AI opinion requires at least 2 model keys in .env.");
          close();
          return;
        }
        appendActivityLog("Attach menu: AI opinion");
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

  aiTalksStopBtn?.addEventListener("click", () => {
    if (aiTalksSession?.awaitingUser) {
      clearAiTalksSession();
      syncAttachButtonExternal?.();
      appendActivityLog("AI talks: ожидание отменено.");
      return;
    }
    if (!aiTalksRuntime.running) {
      appendActivityLog("AI talks: nothing to stop.");
      return;
    }
    aiTalksRuntime.stopRequested = true;
    appendActivityLog("AI talks: остановим после текущего ответа модели.");
  });

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (menu.hidden) return;
      if (!(e.target instanceof Node)) return;
      if (menu.contains(e.target)) return;
      if (btn.contains(e.target)) return;
      close();
    },
    true,
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      close();
      btn.focus();
    }
  });

  syncAttachButtonExternal = syncAttachButton;
  syncAiOpinionItemAvailability();
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

function createSpeakerIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "msg-bubble-speaker-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const p1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p1.setAttribute("d", "M11 5 6 9H2v6h4l5 4z");
  const p2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p2.setAttribute("d", "M15.5 8.5a5 5 0 0 1 0 7");
  const p3 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p3.setAttribute("d", "M18.5 5.5a9 9 0 0 1 0 13");
  svg.append(p1, p2, p3);
  return svg;
}

function createPlayIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "msg-bubble-speaker-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("stroke", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M8 5v14l11-7z");
  svg.appendChild(path);
  return svg;
}

function createPauseIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "msg-bubble-speaker-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("stroke", "none");
  svg.setAttribute("aria-hidden", "true");
  const left = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  left.setAttribute("x", "6");
  left.setAttribute("y", "5");
  left.setAttribute("width", "4");
  left.setAttribute("height", "14");
  left.setAttribute("rx", "1");
  const right = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  right.setAttribute("x", "14");
  right.setAttribute("y", "5");
  right.setAttribute("width", "4");
  right.setAttribute("height", "14");
  right.setAttribute("rx", "1");
  svg.append(left, right);
  return svg;
}

/** @type {{ audio: HTMLAudioElement | null, button: HTMLButtonElement | null, turnId: string }} */
const assistantVoicePlayback = { audio: null, button: null, turnId: "" };

/**
 * @param {HTMLButtonElement} btn
 * @param {"idle" | "loading" | "ready" | "playing"} state
 */
function setAssistantSpeakerButtonState(btn, state) {
  btn.classList.toggle("msg-bubble-speaker--loading", state === "loading");
  btn.classList.toggle("msg-bubble-speaker--ready", state === "ready");
  btn.classList.toggle("msg-bubble-speaker--playing", state === "playing");
  btn.replaceChildren();
  if (state === "loading") {
    const spin = document.createElement("span");
    spin.className = "msg-bubble-inline-spinner";
    spin.setAttribute("aria-hidden", "true");
    btn.appendChild(spin);
    btn.setAttribute("aria-label", "Preparing voice reply");
    btn.title = "Preparing voice reply";
    return;
  }
  if (state === "playing") {
    btn.appendChild(createPauseIcon());
    btn.setAttribute("aria-label", "Pause voice reply");
    btn.title = "Pause voice reply";
  } else if (state === "ready") {
    btn.appendChild(createPlayIcon());
    btn.setAttribute("aria-label", "Play voice reply");
    btn.title = "Play voice reply";
  } else {
    btn.appendChild(createSpeakerIcon());
    btn.setAttribute("aria-label", "Voice reply");
    btn.title = "Voice reply";
  }
}

/**
 * @param {HTMLElement | null} assistantWrap
 */
function syncAssistantSpeakerButton(assistantWrap) {
  const btn = assistantWrap?.querySelector?.(".msg-bubble-speaker");
  if (!(btn instanceof HTMLButtonElement) || !(assistantWrap instanceof HTMLElement)) return;
  const hasTurnId = Boolean(String(assistantWrap.dataset.turnId ?? "").trim());
  const busy = btn.classList.contains("msg-bubble-speaker--loading");
  btn.disabled = !hasTurnId || busy;
}

/**
 * @param {HTMLElement} assistantWrap
 */
function makeAssistantSpeakerButton(assistantWrap) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-bubble-action-btn msg-bubble-speaker";
  setAssistantSpeakerButtonState(btn, "idle");
  syncAssistantSpeakerButton(assistantWrap);

  async function runVoiceFlow() {
    const turnId = String(assistantWrap.dataset.turnId ?? "").trim();
    if (!turnId) {
      return;
    }
    if (assistantVoicePlayback.audio && assistantVoicePlayback.button === btn) {
      try {
        if (assistantVoicePlayback.audio.paused) {
          await assistantVoicePlayback.audio.play();
          setAssistantSpeakerButtonState(btn, "playing");
        } else {
          assistantVoicePlayback.audio.pause();
          setAssistantSpeakerButtonState(btn, "ready");
        }
      } catch {
        /* ignore */
      }
      return;
    }
    if (assistantVoicePlayback.audio && assistantVoicePlayback.button) {
      try {
        assistantVoicePlayback.audio.pause();
      } catch {
        /* ignore */
      }
      setAssistantSpeakerButtonState(assistantVoicePlayback.button, "ready");
      assistantVoicePlayback.audio = null;
      assistantVoicePlayback.button = null;
      assistantVoicePlayback.turnId = "";
    }
    setAssistantSpeakerButtonState(btn, "loading");
    btn.disabled = true;
    const keys = getModelApiKeys();
    try {
      const cachedUrl = String(assistantWrap.dataset.voiceReplyUrl ?? "").trim();
      const out =
        cachedUrl
          ? { url: cachedUrl, providerId: String(assistantWrap.dataset.voiceReplyProviderId ?? "").trim() }
          : await ensureVoiceReplyMp3(turnId, {
              geminiApiKey: String(keys["gemini-flash"] ?? "").trim(),
              openAiApiKey: String(keys.openai ?? "").trim(),
            });
      assistantWrap.dataset.voiceReplyUrl = String(out.url ?? "").trim();
      assistantWrap.dataset.voiceReplyProviderId = String(out.providerId ?? "").trim();
      assistantWrap.dataset.voiceReplyReady = "1";
      const audio = new Audio(String(out.url ?? "").trim());
      audio.addEventListener("ended", () => {
        if (assistantVoicePlayback.audio === audio) {
          setAssistantSpeakerButtonState(btn, "ready");
          assistantVoicePlayback.audio = null;
          assistantVoicePlayback.button = null;
          assistantVoicePlayback.turnId = "";
        }
      });
      audio.addEventListener("error", () => {
        if (assistantVoicePlayback.audio === audio) {
          setAssistantSpeakerButtonState(btn, "ready");
          assistantVoicePlayback.audio = null;
          assistantVoicePlayback.button = null;
          assistantVoicePlayback.turnId = "";
        }
      });
      assistantVoicePlayback.audio = audio;
      assistantVoicePlayback.button = btn;
      assistantVoicePlayback.turnId = turnId;
      await audio.play();
      setAssistantSpeakerButtonState(btn, "playing");
      appendActivityLog(`Voice reply: ${PROVIDER_DISPLAY[out.providerId] ?? out.providerId ?? "model"}.`);
    } catch (err) {
      setAssistantSpeakerButtonState(btn, assistantWrap.dataset.voiceReplyReady === "1" ? "ready" : "idle");
      appendActivityLog(`Voice reply failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      syncAssistantSpeakerButton(assistantWrap);
    }
  }

  async function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const turnId = String(assistantWrap.dataset.turnId ?? "").trim();
    if (!turnId) {
      appendActivityLog("Voice reply: save this reply first.");
      return;
    }
    await runVoiceFlow();
  }

  // Use a property for auto-start after assistant turn gets persisted.
  btn.__mfStartVoiceReply = () => {
    void runVoiceFlow();
  };

  btn.addEventListener("click", (e) => {
    void onClick(e);
  });

  // Existing MP3 should immediately show Play icon.
  const existingTurnId = String(assistantWrap.dataset.turnId ?? "").trim();
  if (existingTurnId) {
    void (async () => {
      try {
        const st = await fetchVoiceReplyStatus(existingTurnId);
        if (st.exists) {
          assistantWrap.dataset.voiceReplyReady = "1";
          assistantWrap.dataset.voiceReplyUrl = String(st.url ?? "").trim();
          setAssistantSpeakerButtonState(btn, "ready");
          syncAssistantSpeakerButton(assistantWrap);
        }
      } catch {
        /* keep idle */
      }
    })();
  }

  // Voice-origin replies show spinner immediately and auto-start once turn is saved.
  if (assistantWrap.dataset.autoVoiceReply === "1" && assistantWrap.dataset.autoVoiceReplyStarted !== "1") {
    setAssistantSpeakerButtonState(btn, "loading");
    btn.disabled = true;
  }
  return btn;
}

/**
 * @param {HTMLElement | null} assistantWrap
 */
function tryAutoStartAssistantVoiceReply(assistantWrap) {
  if (!(assistantWrap instanceof HTMLElement)) return;
  if (assistantWrap.dataset.autoVoiceReply !== "1") return;
  if (assistantWrap.dataset.autoVoiceReplyStarted === "1") return;
  const turnId = String(assistantWrap.dataset.turnId ?? "").trim();
  if (!turnId) return;
  const btn = assistantWrap.querySelector(".msg-bubble-speaker");
  if (!(btn instanceof HTMLButtonElement)) return;
  assistantWrap.dataset.autoVoiceReplyStarted = "1";
  const fn = btn.__mfStartVoiceReply;
  if (typeof fn === "function") {
    fn();
  }
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

function syncAllAssistantSpeakerButtons() {
  document.querySelectorAll(".msg-assistant .msg-bubble-speaker").forEach((b) => {
    const wrap = b.closest(".msg-assistant");
    if (wrap instanceof HTMLElement) syncAssistantSpeakerButton(wrap);
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
  if (userEl.querySelector(".msg-user-ai-opinion-badge")) return "aiTalks";
  if (userEl.querySelector(".msg-user-access-data-badge")) return "accessData";
  if (userEl.querySelector(".msg-user-image-badge")) return "image";
  if (userEl.querySelector(".msg-user-research-badge")) return "research";
  if (userEl.querySelector(".msg-user-web-badge")) return "web";
  return "";
}

/**
 * @param {unknown} options
 * @param {Array<Record<string, unknown>>} attachmentStrip
 * @returns {Array<{ name: string; kind: string; mimeType?: string; imageBase64?: string; textInline?: string }>}
 */
function buildPersistRecoveryForAppend(options, attachmentStrip) {
  const fromOpt = options?.persistRecovery;
  const src = Array.isArray(fromOpt) && fromOpt.length > 0 ? fromOpt : attachmentStrip;
  if (!Array.isArray(src) || src.length === 0) return [];
  /** @type {Array<{ name: string; kind: string; mimeType?: string; imageBase64?: string; textInline?: string }>} */
  const out = [];
  for (const x of src) {
    if (!x || typeof x !== "object") continue;
    const name = String(x.name ?? "file").slice(0, 512) || "file";
    const kind = normalizeStoredUserAttachmentKind(x.kind);
    /** @type {{ name: string; kind: string; mimeType?: string; imageBase64?: string; textInline?: string }} */
    const rec = { name, kind };
    const mt = typeof x.mimeType === "string" ? x.mimeType.trim().slice(0, 128) : "";
    if (mt && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+\/-]*$/i.test(mt)) {
      rec.mimeType = mt;
    }
    if (typeof x.imageBase64 === "string") {
      const b = x.imageBase64.replace(/\s/g, "");
      if (b.length > 0 && b.length <= MAX_PERSIST_IMAGE_BASE64_CHARS && /^[A-Za-z0-9+/]+=*$/.test(b)) {
        rec.imageBase64 = b;
      }
    }
    if (typeof x.textInline === "string" && x.textInline.length > 0) {
      rec.textInline =
        x.textInline.length > MAX_PERSIST_TEXT_INLINE_CHARS
          ? x.textInline.slice(0, MAX_PERSIST_TEXT_INLINE_CHARS)
          : x.textInline;
    }
    if (rec.imageBase64 || rec.textInline) out.push(rec);
  }
  return out.slice(0, MAX_COMPOSER_ATTACHMENTS);
}

/**
 * @param {HTMLElement} userEl
 * @returns {Array<Record<string, unknown>>}
 */
function readPersistedRecoveryRowsFromUserBubble(userEl) {
  if (!(userEl instanceof HTMLElement)) return [];
  const holder = userEl.querySelector(".mf-user-attachments-recover");
  if (!holder) return [];
  const raw = String(holder.textContent ?? "").trim();
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (!Array.isArray(j)) return [];
    return j.filter((x) => x && typeof x === "object").slice(0, MAX_COMPOSER_ATTACHMENTS);
  } catch {
    return [];
  }
}

/**
 * Build a `File` from raw base64 (no `fetch(data:…)` — long data URLs are unreliable in some engines).
 * @param {string} name
 * @param {string} mimeType
 * @param {string} b64
 */
function fileFromImageBase64Parts(name, mimeType, b64) {
  const mime =
    String(mimeType ?? "")
      .trim()
      .split(";")[0]
      .trim() || "application/octet-stream";
  const clean = String(b64 ?? "").replace(/\s/g, "");
  if (!clean.length) throw new Error("empty base64");
  const binary = atob(clean);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}

/**
 * @param {string} dataUrl
 * @param {string} fallbackName
 * @returns {File | null}
 */
function tryFileFromDataImageUrl(dataUrl, fallbackName) {
  const u = String(dataUrl ?? "");
  if (!u.startsWith("data:image/")) return null;
  const sep = u.indexOf(";base64,");
  if (sep < 0) return null;
  const mime = u.slice(5, sep).trim();
  const payload = u.slice(sep + ";base64,".length);
  if (!mime.toLowerCase().startsWith("image/")) return null;
  const nm = String(fallbackName ?? "file").trim() || "file";
  try {
    return fileFromImageBase64Parts(nm, mime, payload);
  } catch {
    return null;
  }
}

/**
 * Rebuilds user attachments for "Try another reply": hidden persisted payload (base64 / text),
 * else `blob:` / `data:` URLs from the bubble.
 * @param {HTMLElement} userEl
 * @returns {Promise<{ files: File[], filenames: string[], hadAny: boolean }>}
 */
async function rebuildUserBubbleAttachmentsForRetry(userEl) {
  const out = { files: [], filenames: [], hadAny: false };
  if (!(userEl instanceof HTMLElement)) return out;

  const recovery = readPersistedRecoveryRowsFromUserBubble(userEl);
  if (recovery.length > 0) {
    out.hadAny = true;
    for (const row of recovery) {
      const name = String(row.name ?? "file").trim() || "file";
      let mime = String(row.mimeType ?? "")
        .trim()
        .split(";")[0]
        .trim();
      const kind = String(row.kind ?? "").trim();
      try {
        if (
          typeof row.imageBase64 === "string" &&
          String(row.imageBase64).replace(/\s/g, "").length > 0 &&
          (mime.toLowerCase().startsWith("image/") || kind === "image")
        ) {
          if (!mime.toLowerCase().startsWith("image/")) mime = "image/png";
          const f = fileFromImageBase64Parts(name, mime, String(row.imageBase64));
          out.files.push(f);
          out.filenames.push(name);
        } else if (typeof row.textInline === "string" && row.textInline.length > 0) {
          const mt = mime && !mime.includes(" ") ? mime : "text/plain";
          out.files.push(new File([row.textInline], name, { type: mt }));
          out.filenames.push(name);
        }
      } catch {
        /* skip one attachment */
      }
    }
    if (out.files.length > 0) return out;
    out.hadAny = false;
  }

  /** @type {Array<{ name: string, objectUrl: string }>} */
  let items = [];
  try {
    const raw = String(userEl.dataset.userAttachmentsJson ?? "").trim();
    if (raw) {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) {
        items = j
          .filter((x) => x && typeof x === "object")
          .map((x) => ({
            name: String(x.name ?? "file").slice(0, 512) || "file",
            objectUrl: typeof x.objectUrl === "string" ? String(x.objectUrl) : "",
          }))
          .filter((x) => x.objectUrl.startsWith("blob:") || x.objectUrl.startsWith("data:"));
      }
    }
  } catch {
    items = [];
  }

  if (items.length === 0) {
    const tiles = userEl.querySelectorAll(".msg-user-attachments a.chat-attach-tile--sent-blob");
    tiles.forEach((a) => {
      if (!(a instanceof HTMLAnchorElement)) return;
      const href = String(a.getAttribute("href") ?? "");
      if (!href.startsWith("blob:") && !href.startsWith("data:")) return;
      const nm = String(a.getAttribute("download") ?? a.getAttribute("title") ?? "file").trim() || "file";
      items.push({ name: nm, objectUrl: href });
    });
  }

  if (items.length === 0) return out;
  out.hadAny = true;

  for (const it of items) {
    const url = String(it.objectUrl ?? "");
    if (!url.startsWith("blob:") && !url.startsWith("data:")) continue;
    const nm = String(it.name ?? "file").trim() || "file";
    try {
      if (url.startsWith("data:image/")) {
        const fromData = tryFileFromDataImageUrl(url, nm);
        if (fromData) {
          out.files.push(fromData);
          out.filenames.push(nm);
          continue;
        }
      }
      const res = await fetch(url);
      const blob = await res.blob();
      const file = new File([blob], nm, { type: String(blob.type || "") });
      out.files.push(file);
      out.filenames.push(nm);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * How many assistant replies exist after this user bubble until the next user message.
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
 * Last assistant bubble in this user exchange block (below the user), or null.
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
  syncAssistantSpeakerButton(assistantWrap);
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
  if (document.getElementById("main-chat")?.classList.contains("chat--help")) {
    appendActivityLog("Help: use Send for another reply (retry is for saved threads).");
    return;
  }
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
  const rebuiltAtt = await rebuildUserBubbleAttachmentsForRetry(userEl);
  if (rebuiltAtt.hadAny && rebuiltAtt.files.length === 0) {
    appendActivityLog(
      "Reply: attachments from this message are no longer available in this session — retrying without files.",
    );
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

  const providerId =
    String(clickedAssistantWrap.dataset.assistantProviderId ?? "").trim() || getActiveProviderId();
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
  const attApi =
    rebuiltAtt.files.length > 0
      ? await prepareComposerAttachmentsForApi(rebuiltAtt.files)
      : { images: [], textAppend: "", filenames: [] };
  let promptForApi = buildChatPromptForApi(persistUserText, modeForSend);
  if (attApi.textAppend) {
    promptForApi = promptForApi ? `${promptForApi}\n\n${attApi.textAppend}` : attApi.textAppend;
  }
  if (!String(promptForApi).trim() && attApi.images.length > 0) {
    promptForApi = "(See attached images.)";
  }
  if (modeForSend === "image" && attApi.images.length > 0) {
    const imgNames = rebuiltAtt.filenames.join(", ");
    const note = `The user attached ${attApi.images.length} reference image(s): ${imgNames || "attached images"}. Use them as visual reference when generating.`;
    promptForApi = String(promptForApi).trim()
      ? `${String(promptForApi).trim()}\n\n${note}`
      : note;
  }
  const newOrdinal = countAssistantsInUserExchangeBlock(userEl) + 1;

  const pending = appendAssistantPending();
  if (!pending) return;
  // Retry replies should always appear at the bottom of the chat (not mid-thread),
  // matching the normal "send" UX and keeping the newest result in view.
  const list = document.getElementById("messages-list");
  if (list) {
    list.appendChild(pending);
  } else {
    userEl.insertAdjacentElement("afterend", pending);
  }
  pending.dataset.assistantWebSearch = modeForSend === "web" ? "1" : "";
  pending.dataset.assistantDeepResearch = modeForSend === "research" ? "1" : "";
  pending.dataset.exchangeRootTurnId = rootClone;
  pending.dataset.replyOrdinal = String(newOrdinal);
  if (modeForSend === "image") {
    pending.dataset.assistantResponseKind = "image";
    const te0 = pending.querySelector(".msg-assistant-text");
    if (te0) setAssistantMessagePlain(te0, "Generating image…");
  }

  const ta = document.getElementById("chat-input");
  const sendBtn = document.getElementById("btn-chat-send");

  chatComposerSending = true;
  syncAllAssistantRetryButtons();
  syncAllAssistantSpeakerButtons();
  if (sendBtn) sendBtn.disabled = true;
  scrollMessagesToEnd();

  let fullText = "";
  /** @type {{ promptTokens: number, completionTokens: number, totalTokens: number } | null} */
  let turnLlmUsage = null;
  try {
    appendActivityLog(`Chat → retry (reply #${newOrdinal}): ${attachModeLogLabel(modeForSend)}, model ${modelLabel}`);
    scrollMessagesToEnd();
    if (modeForSend === "image") {
      const imageGenOpts = attApi.images.length > 0 ? { chatAttachments: { images: attApi.images } } : {};
      const { text, usage } = await completeImageGeneration(providerId, promptForApi, key, imageGenOpts);
      fullText = text;
      turnLlmUsage = ensureUsageTotals(usage, promptForApi, fullText);
      const te = pending.querySelector(".msg-assistant-text");
      if (te) setAssistantMessageMarkdown(te, fullText);
      scrollMessagesToEnd();
      const imgHint = apiImageGenerationModelHint(providerId);
      pending.dataset.assistantResponseKind = "image";
      finalizeAssistantBubble(pending, fullText, providerId, imgHint || undefined, newOrdinal);
      appendActivityLog(`Chat ← retry #${newOrdinal}: image, model ${modelLabel}, OK`);
    } else {
      /** @type {{ images: Array<{ mimeType: string, base64: string }> } | undefined} */
      const chatAttachments = attApi.images.length > 0 ? { images: attApi.images } : undefined;
      const chatOpts = await buildChatOptsForModelRequest({
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
        helpChatOpen: false,
      });
      let buf = "";
      try {
        const streamRes = await completeChatMessageStreaming(
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
        fullText = streamRes.text;
        turnLlmUsage = ensureUsageTotals(streamRes.usage, JSON.stringify(chatOpts), fullText);
      } catch {
        appendActivityLog(`Chat: streaming unavailable on retry, full response (${modelLabel})`);
        const { text, usage } = await completeChatMessage(providerId, promptForApi, key, chatOpts);
        fullText = text;
        turnLlmUsage = ensureUsageTotals(usage, JSON.stringify(chatOpts), fullText);
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
    }
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
    syncAllAssistantSpeakerButtons();
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
        ...llmUsageTurnDbFields(turnLlmUsage),
      };
      const saveRes = await saveConversationTurn(persistDialogId, turnPayload);
      const tid =
        saveRes && typeof saveRes === "object"
          ? String(saveRes.id ?? saveRes.turnId ?? "").trim()
          : "";
      if (pending && tid) {
        pending.dataset.turnId = tid;
        syncAssistantFavoriteStarButton(pending);
        syncAssistantRetryButton(pending);
        syncAssistantSpeakerButton(pending);
        syncAllAssistantRetryButtons();
        syncAllAssistantSpeakerButtons();
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

/** Markdown code blocks: syntax highlight, then round copy button in the top-right corner */
function enhanceAssistantMarkdownCodeBlocks(root) {
  if (!root) return;
  highlightAssistantMarkdownCodeBlocks(root);
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

/** AI opinion icon (same star as in the attachment menu) */
function createAiOpinionBadgeIcon() {
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
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M12 3 13.8 10.2 21 12 13.8 13.8 12 21 10.2 13.8 3 12 10.2 10.2 12 3z");
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
 *   aiOpinion?: boolean;
 *   webSearch?: boolean;
 *   imageCreation?: boolean;
 *   deepResearch?: boolean;
 *   accessData?: boolean;
 *   attachmentStrip?: Array<{
 *     name: string;
 *     kind: string;
 *     objectUrl?: string;
 *     displayAsImage?: boolean;
 *     mimeType?: string;
 *     imageBase64?: string;
 *     textInline?: string;
 *   }>;
 *   persistRecovery?: Array<{
 *     name: string;
 *     kind: string;
 *     mimeType?: string;
 *     imageBase64?: string;
 *     textInline?: string;
 *   }>;
 *   listInsertBefore?: ChildNode | null;
 * }} [options]
 * @returns {HTMLElement | null}
 */
function appendUserMessage(rawText, modelLabel, options) {
  const list = document.getElementById("messages-list");
  if (!list) return null;

  const webSearch = Boolean(options?.webSearch);
  const aiOpinion = Boolean(options?.aiOpinion);
  const imageCreation = Boolean(options?.imageCreation);
  const deepResearch = Boolean(options?.deepResearch);
  const accessData = Boolean(options?.accessData);
  const attachmentStrip = Array.isArray(options?.attachmentStrip) ? options.attachmentStrip : [];

  const msg = document.createElement("div");
  msg.className = "msg msg-user";
  msg.dataset.userMessageRaw = String(rawText ?? "");
  if (attachmentStrip.length) {
    msg.dataset.userAttachmentNames = attachmentStrip.map((x) => x.name).filter(Boolean).join(" ");
    const withUrls = attachmentStrip.some((x) => {
      const u = typeof x?.objectUrl === "string" ? String(x.objectUrl) : "";
      return u.startsWith("blob:") || u.startsWith("data:");
    });
    if (withUrls) {
      try {
        msg.dataset.userAttachmentsJson = JSON.stringify(
          attachmentStrip.map((x) => ({
            name: String(x?.name ?? "file").slice(0, 512),
            kind: normalizeStoredUserAttachmentKind(x?.kind),
            objectUrl:
              typeof x?.objectUrl === "string" &&
              (String(x.objectUrl).startsWith("blob:") || String(x.objectUrl).startsWith("data:"))
                ? String(x.objectUrl)
                : "",
            displayAsImage: Boolean(x?.displayAsImage),
          })),
        );
      } catch {
        /* ignore */
      }
    }
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
  if (aiOpinion) {
    const opinionBadge = document.createElement("span");
    opinionBadge.className = "msg-user-ai-opinion-badge";
    opinionBadge.setAttribute("aria-label", "AI opinion");
    opinionBadge.title = "AI opinion";
    opinionBadge.appendChild(createAiOpinionBadgeIcon());
    head.appendChild(opinionBadge);
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
      const nm = String(item?.name ?? "file").trim() || "file";
      const kind = normalizeStoredUserAttachmentKind(item?.kind);
      let objectUrl =
        typeof item?.objectUrl === "string" &&
        (item.objectUrl.startsWith("blob:") || item.objectUrl.startsWith("data:"))
          ? item.objectUrl
          : "";
      const mtForData = String(item?.mimeType ?? "")
        .trim()
        .split(";")[0]
        .trim();
      if (
        !objectUrl &&
        typeof item?.imageBase64 === "string" &&
        mtForData.toLowerCase().startsWith("image/")
      ) {
        const compact = String(item.imageBase64).replace(/\s/g, "");
        if (compact.length > 0) {
          objectUrl = `data:${mtForData};base64,${compact}`;
        }
      }
      if (!objectUrl && typeof item?.textInline === "string" && item.textInline.length > 0) {
        try {
          const mt = mtForData || "text/plain";
          objectUrl = URL.createObjectURL(new Blob([item.textInline], { type: mt }));
        } catch {
          objectUrl = "";
        }
      }
      const displayAsImage =
        Boolean(objectUrl) &&
        (Boolean(item?.displayAsImage) || objectUrl.startsWith("data:image/"));

      if (objectUrl) {
        const a = document.createElement("a");
        a.className = "chat-attach-tile chat-attach-tile--sent-blob";
        a.href = objectUrl;
        a.setAttribute("download", safeAttachmentDownloadBasename(nm));
        a.title = nm;
        a.setAttribute("aria-label", `Download ${nm}`);
        if (displayAsImage) {
          const img = document.createElement("img");
          img.className = "chat-attach-tile-preview";
          img.alt = nm;
          img.decoding = "async";
          img.src = objectUrl;
          img.addEventListener("error", () => {
            // Do not revoke blob: here — the same URL is needed for "Try another reply"
            // (re-fetch blob → File). Replacing the <a> removes recovery metadata from the DOM.
            img.remove();
            while (a.firstChild) a.removeChild(a.firstChild);
            const wrap = document.createElement("div");
            wrap.className = "chat-attach-tile-icon-wrap";
            wrap.appendChild(userMessageAttachmentGlyph("image"));
            a.appendChild(wrap);
            a.classList.add("chat-attach-tile--sent-stale");
          });
          a.appendChild(img);
        } else {
          const wrap = document.createElement("div");
          wrap.className = "chat-attach-tile-icon-wrap";
          wrap.appendChild(composerAttachmentIconSvg(kind));
          a.appendChild(wrap);
        }
        strip.appendChild(a);
      } else {
        const tile = document.createElement("div");
        tile.className = "chat-attach-tile chat-attach-tile--sent-stale";
        tile.title = nm;
        const wrap = document.createElement("div");
        wrap.className = "chat-attach-tile-icon-wrap";
        wrap.appendChild(userMessageAttachmentGlyph(kind));
        tile.appendChild(wrap);
        strip.appendChild(tile);
      }
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

  const recoveryPayload = buildPersistRecoveryForAppend(options, attachmentStrip);
  if (recoveryPayload.length > 0) {
    const holder = document.createElement("div");
    holder.className = "mf-user-attachments-recover";
    holder.hidden = true;
    holder.setAttribute("aria-hidden", "true");
    try {
      holder.textContent = JSON.stringify(recoveryPayload);
    } catch {
      /* ignore */
    }
    msg.appendChild(holder);
  }

  const insertRef = options?.listInsertBefore;
  if (insertRef != null && insertRef.parentNode === list) {
    list.insertBefore(msg, insertRef);
  } else {
    list.appendChild(msg);
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => updateUserExpandVisibility(msg, textEl, expandBtn));
  });
  return msg;
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

/** Centered overlay in `#messages-viewport` while a thread is being fetched/replayed. */
function setMessagesViewportLoading(on) {
  const el = document.getElementById("messages-viewport-loading");
  if (!el) return;
  if (on) {
    el.hidden = false;
    el.setAttribute("aria-hidden", "false");
  } else {
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
  }
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

/** @param {ChildNode | null} [listInsertBefore] */
function appendAssistantPending(listInsertBefore = null) {
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
  if (listInsertBefore != null && listInsertBefore.parentNode === list) {
    list.insertBefore(wrap, listInsertBefore);
  } else {
    list.appendChild(wrap);
  }
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

  // Remember the exact provider used for this reply so "Try another reply" can repeat it.
  el.dataset.assistantProviderId = String(providerId ?? "").trim();

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
    actions.appendChild(makeAssistantSpeakerButton(el));
    if (!el.classList.contains("msg-assistant--error")) {
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
    syncAssistantSpeakerButton(el);
    tryAutoStartAssistantVoiceReply(el);
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
    closeHelpChatFullyForNavigation();
    {
      const ml = document.getElementById("messages-list");
      if (ml) revokeSentUserAttachmentBlobUrls(ml);
      ml?.replaceChildren();
    }
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
  closeHelpChatFullyForNavigation();
  const list = document.getElementById("messages-list");
  if (list) revokeSentUserAttachmentBlobUrls(list);
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
  closeHelpChatFullyForNavigation();
  const list = document.getElementById("messages-list");
  if (list) revokeSentUserAttachmentBlobUrls(list);
  list?.replaceChildren();
  const viewport = document.getElementById("messages-viewport");
  if (viewport) viewport.scrollTop = 0;
  const taDlg = document.getElementById("chat-input");
  const sendDlg = document.getElementById("btn-chat-send");
  if (taDlg) taDlg.disabled = false;
  if (sendDlg) sendDlg.disabled = false;
  syncSidebarSelectionState(document.getElementById("dialogue-cards"), activeDialogId, activeThemeId);
  setMessagesViewportLoading(true);
  try {
    const turns = await fetchTurns(did);
    const scrollIdEarly = scrollToTurnId != null ? String(scrollToTurnId).trim() : "";
    replayDialogTurnsGrouped(turns, {
      anchorScrollToTurnId: scrollIdEarly || undefined,
      expectedActiveDialogId: did,
    });
  } catch (e) {
    appendActivityLog(`Chat DB: could not load thread (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    setMessagesViewportLoading(false);
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
 * Reads persisted AI talks heading `**Round N**` from assistant markdown.
 * @param {unknown} turn
 * @returns {number}
 */
function aiTalksRoundNumberFromTurn(turn) {
  const t = turn && typeof turn === "object" ? turn : {};
  const md = String(t.assistant_text ?? "");
  const m = md.match(/^\s*\*\*Round\s+(\d+)\*\*/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * @param {unknown} turn
 * @param {{ listInsertBefore?: ChildNode | null }} [bubbleOpts]
 */
function appendUserBubbleFromTurn(turn, bubbleOpts) {
  const t = turn && typeof turn === "object" ? turn : {};
  const reqProvider = t.requested_provider_id;
  const rt = t.request_type || "default";
  const modelLabel = rt === "ai_talks" ? "AI opinion" : PROVIDER_DISPLAY[reqProvider] ?? reqProvider;
  /** @type {Array<Record<string, unknown>>} */
  let attachmentStrip = [];
  try {
    const j = JSON.parse(String(t.user_attachments_json ?? "null"));
    if (Array.isArray(j)) {
      attachmentStrip = j
        .filter((x) => x && typeof x === "object")
        .map((x) => {
          const name = String(x.name ?? "file").slice(0, 512);
          const kind = normalizeStoredUserAttachmentKind(x.kind);
          const mimeType = typeof x.mimeType === "string" ? x.mimeType.trim().slice(0, 128) : "";
          const imageBase64 =
            typeof x.imageBase64 === "string"
              ? String(x.imageBase64)
              : typeof x.base64 === "string"
                ? String(x.base64)
                : "";
          const textInline = typeof x.textInline === "string" ? String(x.textInline) : "";

          /** @type {Record<string, unknown>} */
          const out = { name, kind };
          if (mimeType) out.mimeType = mimeType;
          if (imageBase64) out.imageBase64 = imageBase64;
          if (textInline) out.textInline = textInline;

          const mtBase = mimeType.split(";")[0].trim();
          let objectUrl = "";
          let displayAsImage = false;
          const compactB64 = imageBase64.replace(/\s/g, "");
          if (compactB64.length > 0 && mtBase.toLowerCase().startsWith("image/")) {
            objectUrl = `data:${mtBase};base64,${compactB64}`;
            displayAsImage = true;
          } else if (textInline.length > 0) {
            try {
              const mt = mtBase || "text/plain";
              objectUrl = URL.createObjectURL(new Blob([textInline], { type: mt }));
            } catch {
              objectUrl = "";
            }
            displayAsImage = false;
          }
          if (objectUrl) {
            out.objectUrl = objectUrl;
            out.displayAsImage = displayAsImage;
          }
          return out;
        });
    }
  } catch {
    attachmentStrip = [];
  }
  appendUserMessage(t.user_text, modelLabel, {
    aiOpinion: rt === "ai_talks",
    webSearch: rt === "web",
    imageCreation: rt === "image",
    deepResearch: rt === "research",
    accessData: rt === "access_data",
    attachmentStrip: attachmentStrip.length > 0 ? attachmentStrip : undefined,
    ...(bubbleOpts?.listInsertBefore != null ? { listInsertBefore: bubbleOpts.listInsertBefore } : {}),
  });
}

/**
 * @param {unknown} turn
 * @param {number} replyOrdinal
 * @param {string} exchangeRootTurnId
 * @param {{ listInsertBefore?: ChildNode | null }} [bubbleOpts]
 */
function appendAssistantBubbleFromTurn(turn, replyOrdinal, exchangeRootTurnId, bubbleOpts) {
  const t = turn && typeof turn === "object" ? turn : {};
  const reqProvider = t.requested_provider_id;
  const respProvider = t.responding_provider_id || reqProvider;
  const modelLabel = PROVIDER_DISPLAY[reqProvider] ?? reqProvider;
  const rt = t.request_type || "default";
  const ins = bubbleOpts?.listInsertBefore ?? null;
  const pending = appendAssistantPending(ins);
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
    if (rt === "ai_talks") {
      pending.remove();
      return;
    }
    renderAssistantError(pending, "No reply stored for this turn.");
  }
}

/**
 * Chronological exchange groups (one user prompt + assistant row(s)).
 * @param {unknown[]} turns
 * @returns {Array<{ group: unknown[], rootId: string, replies: unknown[] }>}
 */
function buildDialogTurnGroups(turns) {
  const arr = Array.isArray(turns) ? turns : [];
  /** @type {Array<{ group: unknown[], rootId: string, replies: unknown[] }>} */
  const out = [];
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
    const firstRt = String((group[0] && group[0].request_type) ?? "default");
    const replies =
      firstRt === "ai_talks"
        ? [...group].sort((a, b) => {
            const ra = aiTalksRoundNumberFromTurn(a);
            const rb = aiTalksRoundNumberFromTurn(b);
            if (ra > 0 && rb > 0 && ra !== rb) return ra - rb;
            const ta = String((a && typeof a === "object" ? a.assistant_message_at : "") ?? "");
            const tb = String((b && typeof b === "object" ? b.assistant_message_at : "") ?? "");
            if (ta && tb && ta !== tb) return ta.localeCompare(tb);
            const ia = String((a && typeof a === "object" ? a.id : "") ?? "");
            const ib = String((b && typeof b === "object" ? b.id : "") ?? "");
            return ia.localeCompare(ib);
          })
        : group;
    const rootId = String((group[0] && group[0].id) ?? "").trim();
    out.push({ group, rootId, replies });
  }
  return out;
}

/**
 * @param {{ group: unknown[], rootId: string, replies: unknown[] }} meta
 * @param {ChildNode | null | undefined} listInsertBefore
 */
function replayOneDialogTurnGroup(meta, listInsertBefore) {
  const { group, rootId, replies } = meta;
  const ins = listInsertBefore ?? undefined;
  const bubbleOpts = ins != null ? { listInsertBefore: ins } : undefined;
  appendUserBubbleFromTurn(group[0], bubbleOpts);
  for (let k = 0; k < replies.length; k += 1) {
    appendAssistantBubbleFromTurn(replies[k], k + 1, rootId, bubbleOpts);
  }
}

/**
 * @param {Array<{ group: unknown[], rootId: string, replies: unknown[] }>} headGroups oldest first
 * @param {number} replayGen
 * @param {string} [expectedActiveDialogId]
 */
function scheduleDialogHistoryHeadPrepend(headGroups, replayGen, expectedActiveDialogId) {
  if (headGroups.length === 0) return;
  const exp = String(expectedActiveDialogId ?? "").trim();
  let idx = 0;

  const stillValid = () => {
    if (dialogHistoryPrependGeneration !== replayGen) return false;
    if (exp && String(activeDialogId ?? "").trim() !== exp) return false;
    return true;
  };

  const runChunk = () => {
    if (!stillValid()) return;
    const list = document.getElementById("messages-list");
    const viewport = document.getElementById("messages-viewport");
    if (!list) return;
    const before = list.scrollHeight;
    const end = Math.min(idx + DIALOG_REPLAY_HEAD_PRELOAD_CHUNK_GROUPS, headGroups.length);
    for (; idx < end; idx += 1) {
      if (!stillValid()) return;
      const anchor = list.firstChild;
      replayOneDialogTurnGroup(headGroups[idx], anchor instanceof Node ? anchor : null);
    }
    const after = list.scrollHeight;
    if (viewport) viewport.scrollTop += after - before;
    if (idx < headGroups.length && stillValid()) {
      const ric = globalThis.requestIdleCallback;
      if (typeof ric === "function") {
        ric(() => runChunk(), { timeout: 1200 });
      } else {
        globalThis.setTimeout(runChunk, 0);
      }
    }
  };

  const ric0 = globalThis.requestIdleCallback;
  if (typeof ric0 === "function") {
    ric0(() => runChunk(), { timeout: 1200 });
  } else {
    globalThis.setTimeout(runChunk, 0);
  }
}

/**
 * @param {unknown[]} turns
 * @param {{
 *   anchorScrollToTurnId?: string;
 *   expectedActiveDialogId?: string;
 * }} [replayOpts]
 */
function replayDialogTurnsGrouped(turns, replayOpts) {
  dialogHistoryPrependGeneration += 1;
  const replayGen = dialogHistoryPrependGeneration;
  const anchorId = String(replayOpts?.anchorScrollToTurnId ?? "").trim();
  const groups = buildDialogTurnGroups(turns);
  if (anchorId) {
    for (const g of groups) replayOneDialogTurnGroup(g, undefined);
    return;
  }
  if (groups.length <= DIALOG_REPLAY_TAIL_GROUP_COUNT) {
    for (const g of groups) replayOneDialogTurnGroup(g, undefined);
    return;
  }
  const head = groups.slice(0, -DIALOG_REPLAY_TAIL_GROUP_COUNT);
  const tail = groups.slice(-DIALOG_REPLAY_TAIL_GROUP_COUNT);
  for (const g of tail) replayOneDialogTurnGroup(g, undefined);
  scheduleDialogHistoryHeadPrepend(head, replayGen, replayOpts?.expectedActiveDialogId);
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
 *   helpChatOpen?: boolean,
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
    helpChatOpen = false,
  } = p;
  if (helpChatOpen) {
    return {
      webSearch: false,
      deepResearch: false,
      systemInstruction: buildHelpModeSystemInstruction(),
      llmMessages: [
        ...helpChatLlmSession.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: promptForApi },
      ],
    };
  }
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
              analysisPriority: getChatAnalysisPriority(),
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
  const voiceBtn = document.getElementById("btn-composer-voice");
  if (!ta || !sendBtn) return;

  const canRecordVoice =
    typeof navigator !== "undefined" &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined";
  const voiceProvidersReady = (() => {
    const keys = getModelApiKeys();
    return Boolean(String(keys.openai ?? "").trim() || String(keys["gemini-flash"] ?? "").trim());
  })();
  if (voiceBtn instanceof HTMLButtonElement) {
    voiceBtn.disabled = !canRecordVoice || !voiceProvidersReady;
  }

  syncChatInputHeight(ta);
  ta.addEventListener("input", () => {
    syncChatInputHeight(ta);
    syncComposerSendButtonState();
  });
  syncComposerSendButtonState();

  ta.addEventListener("paste", (e) => {
    if (!(e instanceof ClipboardEvent)) return;
    if (ta.disabled) return;
    const files = collectClipboardFiles(e.clipboardData);
    if (files.length === 0) return;

    const mainChatEl = document.getElementById("main-chat");
    const helpChatOpen = Boolean(mainChatEl?.classList.contains("chat--help"));
    if (helpChatOpen) {
      e.preventDefault();
      appendActivityLog("Help does not support attachments — clipboard file not added.");
      return;
    }

    e.preventDefault();
    addComposerAttachmentsFromFileList(files);
    appendActivityLog(`Add photos & files: ${files.length} file(s) from clipboard`);

    const plain = e.clipboardData?.getData("text/plain") ?? "";
    if (plain) {
      insertTextAtCaret(ta, plain);
    }
  });

  /** @type {{ stream: MediaStream, recorder: MediaRecorder, chunks: BlobPart[], stoppedByUser: boolean, silenceTimer: number | null, ampRaf: number | null, audioCtx: AudioContext | null } | null} */
  let voiceRec = null;
  let nextSubmitFromVoiceInput = false;

  function setVoiceListeningUi(on) {
    if (!(voiceBtn instanceof HTMLButtonElement)) return;
    voiceBtn.classList.toggle("composer-voice-btn--listening", on);
    voiceBtn.setAttribute("aria-pressed", on ? "true" : "false");
    voiceBtn.setAttribute("aria-label", on ? "Stop recording" : "Voice message");
    voiceBtn.title = on ? "Stop recording" : "Voice message";
  }

  function stopVoiceTracks(stream) {
    try {
      for (const tr of stream.getTracks()) tr.stop();
    } catch {
      /* ignore */
    }
  }

  function clearVoiceRecState() {
    if (!voiceRec) return;
    if (voiceRec.silenceTimer != null) window.clearTimeout(voiceRec.silenceTimer);
    if (voiceRec.ampRaf != null) cancelAnimationFrame(voiceRec.ampRaf);
    if (voiceRec.audioCtx) {
      try {
        void voiceRec.audioCtx.close();
      } catch {
        /* ignore */
      }
    }
    stopVoiceTracks(voiceRec.stream);
    voiceRec = null;
    setVoiceListeningUi(false);
  }

  async function blobToBase64(blob) {
    const buf = await blob.arrayBuffer();
    let bin = "";
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  async function startVoiceCapture() {
    if (!canRecordVoice || voiceRec) return;
    if (!voiceProvidersReady) {
      appendActivityLog("Voice input unavailable: add ChatGPT or Gemini API key in .env.");
      return;
    }
    const mainChatEl = document.getElementById("main-chat");
    const helpChatOpen = Boolean(mainChatEl?.classList.contains("chat--help"));
    if (helpChatOpen) {
      appendActivityLog("Help accepts plain messages only — voice input is disabled.");
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const rec = new MediaRecorder(stream);
    voiceRec = {
      stream,
      recorder: rec,
      chunks: [],
      stoppedByUser: false,
      silenceTimer: null,
      ampRaf: null,
      audioCtx: null,
    };
    setVoiceListeningUi(true);
    appendActivityLog("Voice input: recording…");

    rec.addEventListener("dataavailable", (e) => {
      if (e.data && e.data.size > 0 && voiceRec) voiceRec.chunks.push(e.data);
    });

    rec.addEventListener("stop", async () => {
      const stoppedByUser = Boolean(voiceRec?.stoppedByUser);
      const mimeType = rec.mimeType || "audio/webm";
      const parts = voiceRec?.chunks ?? [];
      clearVoiceRecState();
      const blob = new Blob(parts, { type: mimeType });
      if (blob.size <= 0) {
        appendActivityLog("Voice input: empty recording.");
        return;
      }
      try {
        appendActivityLog("Voice input: transcribing…");
        const keys = getModelApiKeys();
        const out = await transcribeVoiceMessage({
          audioBase64: await blobToBase64(blob),
          mimeType,
          geminiApiKey: String(keys["gemini-flash"] ?? "").trim(),
          openAiApiKey: String(keys.openai ?? "").trim(),
        });
        const text = String(out.text ?? "").trim();
        if (!text) throw new Error("Voice transcription returned empty text.");
        ta.value = ta.value.trim() ? `${ta.value.trim()}\n${text}` : text;
        syncChatInputHeight(ta);
        syncComposerSendButtonState();
        appendActivityLog(`Voice input: transcribed (${PROVIDER_DISPLAY[out.providerId] ?? out.providerId ?? "model"}).`);
        if (stoppedByUser || text.length > 0) {
          nextSubmitFromVoiceInput = true;
          await submitChat();
        }
      } catch (e) {
        appendActivityLog(`Voice input failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    // Auto-stop on ~2s silence.
    const audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const SILENCE_MS = 2000;
    const THRESHOLD = 7;
    voiceRec.audioCtx = audioCtx;
    const tick = () => {
      if (!voiceRec || voiceRec.recorder !== rec || rec.state !== "recording") return;
      analyser.getByteTimeDomainData(samples);
      let amp = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const v = Math.abs(samples[i] - 128);
        if (v > amp) amp = v;
      }
      if (amp < THRESHOLD) {
        if (voiceRec.silenceTimer == null) {
          voiceRec.silenceTimer = window.setTimeout(() => {
            if (voiceRec && voiceRec.recorder === rec && rec.state === "recording") {
              appendActivityLog("Voice input: silence detected.");
              rec.stop();
            }
          }, SILENCE_MS);
        }
      } else if (voiceRec.silenceTimer != null) {
        window.clearTimeout(voiceRec.silenceTimer);
        voiceRec.silenceTimer = null;
      }
      voiceRec.ampRaf = requestAnimationFrame(tick);
    };

    rec.start(250);
    voiceRec.ampRaf = requestAnimationFrame(tick);
  }

  function stopVoiceCaptureByUser() {
    if (!voiceRec) return;
    voiceRec.stoppedByUser = true;
    if (voiceRec.recorder.state === "recording") {
      voiceRec.recorder.stop();
    }
  }

  async function submitChat() {
    if (chatComposerSending) return;
    const submitFromVoiceInput = nextSubmitFromVoiceInput;
    nextSubmitFromVoiceInput = false;
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
    const helpChatOpen = Boolean(mainChatEl?.classList.contains("chat--help"));
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
    if (helpChatOpen) {
      if (filesSnapshot.length > 0) {
        appendActivityLog("Help does not support attachments — remove files to send.");
        return;
      }
      if (
        modeForSend === "aiTalks" ||
        modeForSend === "image" ||
        modeForSend === "web" ||
        modeForSend === "research" ||
        modeForSend === "accessData"
      ) {
        appendActivityLog("Help accepts plain messages only — reset the composer to default mode.");
        return;
      }
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
    if (modeForSend === "aiTalks" && !hasAtLeastTwoModelKeys()) {
      appendActivityLog("AI opinion requires at least 2 model keys in .env.");
      return;
    }

    const modelLabel = PROVIDER_DISPLAY[providerId] ?? providerId;

    const persistUserText = trimmed;
    const accessDataDumpMode =
      !helpChatOpen &&
      modeForSend !== "image" &&
      (userMessageTriggersAccessDataDump(trimmed) || modeForSend === "accessData");

    /** Live object URLs for the user bubble (same look as composer). Revoked when `#messages-list` is cleared. */
    const attachmentStripForUi =
      composerAttachmentRows.length > 0
        ? composerAttachmentRows.map((r) => {
            const name = r.file.name || "file";
            const kind = r.kind;
            if (kind === "image") {
              let objectUrl = r.previewUrl;
              if (objectUrl) {
                r.previewUrl = null;
              } else {
                try {
                  objectUrl = URL.createObjectURL(r.file);
                } catch {
                  objectUrl = null;
                }
              }
              return {
                name,
                kind,
                objectUrl: objectUrl || undefined,
                displayAsImage: true,
              };
            }
            let objectUrl;
            try {
              objectUrl = URL.createObjectURL(r.file);
            } catch {
              objectUrl = undefined;
            }
            return { name, kind, objectUrl, displayAsImage: false };
          })
        : [];

    const titleSeed =
      trimmed.trim() ||
      (modeForSend === "accessData" ? "Access data" : "") ||
      (filesSnapshot.length > 0 ? filesSnapshot.map((f) => f.name || "file").join(", ") : "");

    const userMessageAt = new Date().toISOString();
    let persistDialogId = activeDialogId;
    if (helpChatOpen) {
      persistDialogId = null;
    } else if (introContextActive) {
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
    /** @type {{ promptTokens: number, completionTokens: number, totalTokens: number } | null} */
    let turnLlmUsage = null;
    let didAppendUserToUi = false;
    /** Caption or synthesized brief for DB / bubble (set after `promptForApi` is built). */
    let turnUserTextForUiAndDb = persistUserText;
    /** Snapshot for `user_attachments_json` (visible to `finally` / DB save). */
    let attachmentPersistRowsForSave = [];

    chatComposerSending = true;
    syncAllAssistantRetryButtons();
    syncAllAssistantSpeakerButtons();
    try {
      if (!persistDialogId && !helpChatOpen) {
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
          ? await prepareComposerAttachmentsForApiAndPersist(filesSnapshot)
          : { images: [], textAppend: "", filenames: [], persistRows: [] };
      attachmentPersistRowsForSave = attApi.persistRows ?? [];
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
        const imgNames = attachmentPersistRowsForSave
          .filter((x) => x.kind === "image")
          .map((x) => x.name)
          .filter(Boolean)
          .join(", ");
        const note = `The user attached ${attApi.images.length} reference image(s): ${imgNames || "attached images"}. Use them as visual reference when generating.`;
        promptForApi = String(promptForApi).trim()
          ? `${String(promptForApi).trim()}\n\n${note}`
          : note;
      }

      turnUserTextForUiAndDb =
        persistUserText.trim() ||
        (modeForSend === "image" && attApi.images.length > 0 && String(promptForApi ?? "").trim()
          ? String(promptForApi).trim()
          : persistUserText);

      /** @type {{ images: Array<{ mimeType: string, base64: string }> } | undefined} */
      const chatAttachments = attApi.images.length > 0 ? { images: attApi.images } : undefined;

      sendBtn.disabled = true;

      appendActivityLog(
        `Chat → request: ${attachModeLogLabel(modeForSend)}, model ${modelLabel}, input chars: ${trimmed.length}, attachments: ${filesSnapshot.length}`,
      );

      appendUserMessage(turnUserTextForUiAndDb, modeForSend === "aiTalks" ? "AI opinion" : modelLabel, {
        aiOpinion: modeForSend === "aiTalks",
        webSearch: modeForSend === "web",
        imageCreation: modeForSend === "image",
        deepResearch: modeForSend === "research",
        accessData: modeForSend === "accessData",
        attachmentStrip: attachmentStripForUi.length > 0 ? attachmentStripForUi : undefined,
        persistRecovery: attachmentPersistRowsForSave.length > 0 ? attachmentPersistRowsForSave : undefined,
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
      if (pending && submitFromVoiceInput) {
        pending.dataset.autoVoiceReply = "1";
      }
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
          const { text, usage } = await completeImageGeneration(
            providerId,
            promptForApi,
            key,
            imageGenOpts,
          );
          fullText = text;
          turnLlmUsage = ensureUsageTotals(usage, promptForApi, fullText);
          const te = pending?.querySelector(".msg-assistant-text");
          if (te) setAssistantMessageMarkdown(te, fullText);
          scrollMessagesToEnd();
          const imgHint = apiImageGenerationModelHint(providerId);
          if (pending) {
            pending.dataset.assistantResponseKind = "image";
          }
          finalizeAssistantBubble(pending, fullText, providerId, imgHint || undefined, 1);
          appendActivityLog(`Chat ← reply: image, model ${modelLabel}, OK`);
        } else if (modeForSend === "aiTalks") {
          const ordered = aiTalksProvidersWithKeysOrdered(providerId);
          if (ordered.length < 2) {
            throw new Error("AI opinion requires at least 2 model keys in .env.");
          }
          const te = pending?.querySelector(".msg-assistant-text");
          /** @type {string[]} */
          const answeredProviders = [];
          /** @type {Array<{ providerId: string, label: string, body: string }>} */
          const sections = [];
          /** @type {{ promptTokens: number, completionTokens: number, totalTokens: number }} */
          const usageAgg = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
          for (let idx = 0; idx < ordered.length; idx += 1) {
            const pid = ordered[idx];
            const keysNow = getModelApiKeys();
            const speakerKey = String(keysNow[pid] ?? "").trim();
            if (!speakerKey) continue;
            const speakerLabel = PROVIDER_DISPLAY[pid] ?? pid;
            setAssistantPendingThinkingLabel(pending, `Думает: ${speakerLabel}…`);
            const hasPrior = sections.length > 0;
            const panelPrompt = [
              `User question:\n${String(promptForApi ?? "").trim()}`,
              "",
              "You are one expert in an AI-opinion panel.",
              `Current speaker: ${speakerLabel}.`,
              "Provide your own concise answer (max ~170 words). Add practical specifics; do not repeat prior answers verbatim.",
              "",
              "Previous panel answers:",
              hasPrior ? buildAiOpinionMarkdown(sections) : "(none yet)",
            ].join("\n");
            const chatOptsForSpeaker = await buildChatOptsForModelRequest({
              persistDialogId,
              promptForApi: panelPrompt,
              providerId: pid,
              key: speakerKey,
              modeForSend,
              accessDataDumpMode,
              chatAttachments: undefined,
              introChatOpen: introContextActive,
              accessChatOpen,
              rulesChatOpen,
              helpChatOpen,
            });
            const baseSystem = String(chatOptsForSpeaker.systemInstruction ?? "").trim();
            chatOptsForSpeaker.systemInstruction = baseSystem
              ? `${baseSystem}\n\nAI opinion mode: provide one concise, useful opinion for the user's question. Plain text.`
              : "AI opinion mode: provide one concise, useful opinion for the user's question. Plain text.";
            const nCtxMessages = Array.isArray(chatOptsForSpeaker.llmMessages)
              ? chatOptsForSpeaker.llmMessages.length
              : 0;
            appendActivityLog(
              `AI opinion context: ${speakerLabel} — context messages ${nCtxMessages}, memory layer ${nCtxMessages > 0 ? "on" : "fallback"}.`,
            );
            appendActivityLog(`AI opinion: ${speakerLabel}`);
            let body = "";
            let usage = null;
            try {
              const streamRes = await completeChatMessageStreaming(
                pid,
                panelPrompt,
                speakerKey,
                (piece) => {
                  body += piece;
                  const draftSections = [...sections, { providerId: pid, label: speakerLabel, body }];
                  const draft = buildAiOpinionMarkdown(draftSections);
                  if (pending && te) {
                    pending.dataset.assistantMarkdown = draft;
                    setAssistantMessageMarkdown(te, draft);
                    syncAssistantCopyButtonDuringStream(pending);
                    scrollMessagesToEnd();
                  }
                },
                chatOptsForSpeaker,
              );
              body = String(streamRes.text ?? body ?? "");
              usage = streamRes.usage ?? null;
            } catch {
              const fallback = await completeChatMessage(pid, panelPrompt, speakerKey, chatOptsForSpeaker);
              body = String(fallback.text ?? "");
              usage = fallback.usage ?? null;
            }
            body = String(body ?? "").trim();
            if (!body) continue;
            answeredProviders.push(pid);
            sections.push({ providerId: pid, label: speakerLabel, body });
            usageAgg.promptTokens += Number(usage?.promptTokens) || 0;
            usageAgg.completionTokens += Number(usage?.completionTokens) || 0;
            usageAgg.totalTokens += Number(usage?.totalTokens) || 0;
            recordAiTalksAuxUsage(pid, usage, panelPrompt, body);
            if (pending && te) {
              const draft = buildAiOpinionMarkdown(sections);
              pending.dataset.assistantMarkdown = draft;
              setAssistantMessageMarkdown(te, draft);
              syncAssistantCopyButtonDuringStream(pending);
              scrollMessagesToEnd();
            }
          }
          if (sections.length === 0) {
            throw new Error("AI opinion: no model returned a non-empty answer.");
          }
          fullText = buildAiOpinionMarkdown(sections);
          turnLlmUsage = usageAgg.totalTokens > 0 ? usageAgg : ensureUsageTotals(null, promptForApi, fullText);
          finalizeAssistantBubble(pending, fullText, providerId, undefined, 1);
          const repliedLine = answeredProviders
            .map((id) => PROVIDER_DISPLAY[id] ?? id)
            .join(", ");
          const meta = pending?.querySelector(".msg-assistant-model");
          if (meta && repliedLine) {
            meta.textContent = `Replied: ${repliedLine}`;
          }
          appendActivityLog(`Chat ← reply: AI opinion, models: ${answeredProviders.length}`);
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
            helpChatOpen,
          });
          let buf = "";
          try {
            const streamRes = await completeChatMessageStreaming(
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
            fullText = streamRes.text;
            turnLlmUsage = ensureUsageTotals(streamRes.usage, JSON.stringify(chatOpts), fullText);
          } catch {
            appendActivityLog(`Chat: streaming unavailable, full response (${modelLabel})`);
            const { text, usage } = await completeChatMessage(providerId, promptForApi, key, chatOpts);
            fullText = text;
            turnLlmUsage = ensureUsageTotals(usage, JSON.stringify(chatOpts), fullText);
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
          tryAutoStartAssistantVoiceReply(pending);
          appendActivityLog(
            `Chat ← reply: text, model ${modelLabel}, reply chars: ${String(fullText).length}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fullText = msg;
        if (pending) {
          renderAssistantError(pending, msg);
        } else if (modeForSend === "aiTalks") {
          const list = document.getElementById("messages-list");
          const pendLast = list?.querySelector(".msg-assistant.msg-assistant--pending:last-of-type");
          if (pendLast) {
            renderAssistantError(pendLast, msg);
          }
          clearAiTalksSession();
          syncAttachButtonExternal?.();
        }
        appendActivityLog(
          `Chat ← error, model ${modelLabel}: ${msg.length > 280 ? `${msg.slice(0, 280)}…` : msg}`,
        );
      }
    } finally {
      aiTalksRuntime.stopRequested = false;
      aiTalksRuntime.running = false;
      aiTalksRuntime.abortController = null;
      chatComposerSending = false;
      sendBtn.disabled = false;
      ta.disabled = false;
      syncComposerSendButtonState();
      syncAllAssistantRetryButtons();
      syncAllAssistantSpeakerButtons();
      scrollMessagesToEnd();
      if (helpChatOpen && didAppendUserToUi) {
        const hadAssistantErr = Boolean(pending?.classList.contains("msg-assistant--error"));
        const assistantOutHelp =
          pending?.classList.contains("msg-assistant--error") && pending?.dataset?.assistantMarkdown
            ? String(pending.dataset.assistantMarkdown)
            : fullText;
        if (!hadAssistantErr) {
          helpChatLlmSession.push(
            { role: "user", content: turnUserTextForUiAndDb },
            { role: "assistant", content: String(assistantOutHelp ?? "") },
          );
          const uHelp = ensureUsageTotals(turnLlmUsage, turnUserTextForUiAndDb, String(assistantOutHelp ?? ""));
          void recordAuxLlmUsage({
            provider_id: providerId,
            request_kind: "help_chat_turn",
            llm_prompt_tokens: uHelp.promptTokens,
            llm_completion_tokens: uHelp.completionTokens,
            llm_total_tokens: uHelp.totalTokens,
          }).catch(() => {});
        }
      }
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
            user_text: turnUserTextForUiAndDb,
            assistant_text: assistantOut || null,
            requested_provider_id: providerId,
            responding_provider_id: providerId,
            request_type: accessDataDumpMode ? "access_data" : requestTypeFromAttachMode(modeForSend),
            user_message_at: userMessageAt,
            assistant_message_at: assistantMessageAt,
            assistant_error: hadAssistantError ? 1 : 0,
            ...llmUsageTurnDbFields(turnLlmUsage),
          };
          if (attachmentPersistRowsForSave.length > 0) {
            turnPayload.user_attachments_json = JSON.stringify(attachmentPersistRowsForSave);
          }
          const saveRes = await saveConversationTurn(persistDialogId, turnPayload);
          tid =
            saveRes && typeof saveRes === "object"
              ? String(saveRes.id ?? saveRes.turnId ?? "").trim()
              : "";
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
            syncAssistantSpeakerButton(pending);
            tryAutoStartAssistantVoiceReply(pending);
            syncAllAssistantRetryButtons();
            syncAllAssistantSpeakerButtons();
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
            const keeperPick = pickKeeperProviderWithKey();
            const keeperProviderId = String(keeperPick.providerId ?? "").trim();
            const keeperApiKey = String(keeperPick.apiKey ?? "").trim();
            if (!keeperProviderId || !keeperApiKey) {
              appendActivityLog(
                "Keeper (Intro): skipped — no API key for analysis provider (OpenAI/Anthropic/Gemini/Perplexity).",
              );
            } else {
            /** @type {{ entities: unknown[], links: unknown[], commands?: unknown[] }} */
            let extracted = { entities: [], links: [], commands: [] };
            try {
              extracted = await extractIntroMemoryGraphForIngest(
                keeperProviderId,
                keeperApiKey,
                persistUserText,
              );
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
                  keeperProviderId,
                  keeperApiKey,
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
              const keeperPick = pickKeeperProviderWithKey();
              const keeperProviderId = String(keeperPick.providerId ?? "").trim();
              const keeperApiKey = String(keeperPick.apiKey ?? "").trim();
              if (!keeperProviderId || !keeperApiKey) {
                appendActivityLog(
                  "Keeper (chat): skipped — no API key for analysis provider (OpenAI/Anthropic/Gemini/Perplexity).",
                );
              } else {
                const extracted = await extractChatInterestSketchForIngest(
                  keeperProviderId,
                  keeperApiKey,
                  persistUserText,
                );
                appendActivityLog(`Keeper (chat): extract — ${keeperPayloadSummary(extracted)}`);
                let pack = extracted;
                if ((extracted.entities.length > 0 || extracted.links.length > 0) && (await apiHealth())) {
                  try {
                    const existing = await fetchMemoryGraphFromApi();
                    appendActivityLog(
                      `Keeper (chat): normalize to DB (${(existing.nodes ?? []).length} nodes in graph)…`,
                    );
                    pack = await normalizeIntroMemoryGraphForDb(
                      keeperProviderId,
                      keeperApiKey,
                      extracted,
                      existing.nodes ?? [],
                    );
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

  if (voiceBtn instanceof HTMLButtonElement) {
    voiceBtn.addEventListener("click", async () => {
      if (chatComposerSending || ta.disabled) return;
      if (voiceRec) {
        stopVoiceCaptureByUser();
        return;
      }
      try {
        await startVoiceCapture();
      } catch (e) {
        clearVoiceRecState();
        appendActivityLog(`Voice input unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

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
    if (
      mainChat.classList.contains("chat--rules") ||
      mainChat.classList.contains("chat--access") ||
      mainChat.classList.contains("chat--help")
    ) {
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
    if (
      mainChat.classList.contains("chat--rules") ||
      mainChat.classList.contains("chat--access") ||
      mainChat.classList.contains("chat--help")
    ) {
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

/**
 * @param {HTMLImageElement} img
 * @returns {string}
 */
function downloadFilenameForChatImage(img) {
  const src = img.currentSrc || img.src || "";
  const dm = /^data:image\/(\w+);/i.exec(src);
  const extFromData = dm ? (dm[1].toLowerCase() === "jpeg" ? "jpg" : dm[1].toLowerCase()) : "";
  const ext = extFromData || "png";
  const raw = String(img.getAttribute("alt") ?? "image")
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 72);
  const base = raw || "image";
  return /\.[a-z0-9]{2,4}$/i.test(base) ? base : `${base}.${ext}`;
}

/**
 * @param {HTMLImageElement} img
 */
async function downloadChatMessageImage(img) {
  const src = img.currentSrc || img.src;
  if (!src) return;
  const name = downloadFilenameForChatImage(img);
  try {
    if (src.startsWith("data:")) {
      const a = document.createElement("a");
      a.href = src;
      a.download = name;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    const res = await fetch(src, { mode: "cors", referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error("fetch failed");
    const blob = await res.blob();
    const obj = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = obj;
      a.download = name;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(obj);
    }
  } catch {
    try {
      window.open(src, "_blank", "noopener,noreferrer");
    } catch {
      /* ignore */
    }
  }
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
    const dl = e.target instanceof Element ? e.target.closest(".msg-md-image-download") : null;
    if (dl instanceof HTMLButtonElement) {
      const wrap = dl.closest(".msg-md-inline-image-wrap");
      const img = wrap?.querySelector("img");
      if (img instanceof HTMLImageElement) {
        e.preventDefault();
        e.stopPropagation();
        void downloadChatMessageImage(img);
      }
      return;
    }
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
  initSettingsModal();
  initProviderBadges();
  refreshSettingsAiPriorityBadges();
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
      closeHelpChatFullyForNavigation();
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
