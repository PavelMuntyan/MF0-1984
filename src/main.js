import "./theme.css";
import pkg from "../package.json";
import {
  apiImageGenerationModelHint,
  apiModelHint,
  completeChatMessage,
  completeChatMessageStreaming,
  completeImageGeneration,
  generateThemeDialogTitle,
  PROVIDER_DISPLAY,
} from "./chatApi.js";
import { renderAssistantMarkdown } from "./markdown.js";
import { getModelApiKeys, hasAnyModelApiKey } from "./modelEnv.js";
import { setTheme } from "./theme.js";
import { closeMemoryTree, initMemoryTree } from "./memoryTree.js";
import {
  apiHealth,
  bootstrapThemeAndDialog,
  createDialogInTheme,
  deleteTheme,
  renameTheme,
  fetchAssistantFavorites,
  fetchContextPack,
  fetchThemesPayload,
  fetchTurns,
  requestTypeFromAttachMode,
  saveConversationTurn,
  setAssistantTurnFavorite,
  titleFromUserMessage,
} from "./chatPersistence.js";
import { buildModelContext } from "./contextEngine/buildModelContext.js";
import { fitContextToBudget } from "./contextEngine/fitContextToBudget.js";
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
/** Верхняя граница оценки входных токенов для сборки контекста треда (до ответа модели). */
const MF0_MAX_CONTEXT_INPUT_TOKENS = 12000;

/** Active conversation for DB persistence (null = new chat until first send). */
let activeThemeId = null;
let activeDialogId = null;

/** У какой темы открыт список диалогов (папка); закрывается только кнопкой папки или открытием папки у другой темы. */
let expandedThemeDialogListThemeId = null;

/** Анти-дребезг отправки; при true второй клик игнорируется. Сбрасывается в finally отправки и при смене темы/диалога. */
let chatComposerSending = false;

/**
 * Вложения к текущему сообщению (до отправки).
 * @type {Array<{ id: string, file: File, kind: ReturnType<typeof classifyComposerAttachmentKind>, previewUrl?: string | null }>}
 */
let composerAttachmentRows = [];

/** Календарная дата везде в формате YYYY-MM-DD */
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

/** Подпись режима меню «+» для журнала активности */
function attachModeLogLabel(mode) {
  const m = String(mode ?? "");
  if (m === "web") return "web search";
  if (m === "image") return "image";
  if (m === "research") return "deep research";
  return "default text";
}

/** Первый URL или data: из markdown-картинки `![](...)` */
function extractMarkdownImageSrc(markdown) {
  const m = String(markdown ?? "").match(/!\[[^\]]*\]\(\s*([^)]+?)\s*\)/);
  if (!m) return null;
  return m[1].trim().replace(/^<|>$/g, "");
}

/**
 * Поместить растровое изображение в буфер обмена (data: или http(s)).
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
    /* пробуем через canvas, если хост отдаёт CORS для <img> */
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

/** @param {{ log?: boolean }} [options] — log=false: только закрыть (уже есть запись в журнале, напр. Clear). */
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

/** @param {{ log?: boolean }} [options] — log=false: не писать в журнал (напр. при переходе из записи). */
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
 * Прокрутка области чата к ответу ассистента с данным id хода (`data-turn-id` на `.msg-assistant`).
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

/** Порядок выбора активного провайдера по умолчанию */
const PROVIDER_ORDER = ["openai", "perplexity", "gemini-flash", "anthropic"];

function providerHasKey(keys, id) {
  return Boolean(String(keys[id] ?? "").trim());
}

/** Для режима «Поиск в сети»: Gemini → Perplexity → Claude → ChatGPT */
const WEB_SEARCH_PROVIDER_PRIORITY = [
  "gemini-flash",
  "perplexity",
  "anthropic",
  "openai",
];

/**
 * Режим кнопки «+» (меню вложений). Для «web» в API уходит расширенный запрос с инструкцией искать в сети.
 * @type {string}
 */
let composerAttachMode = "";

/** Для режима «Глубокое исследование»: Perplexity → ChatGPT → Gemini → Claude */
const DEEP_RESEARCH_PROVIDER_PRIORITY = [
  "perplexity",
  "openai",
  "gemini-flash",
  "anthropic",
];

/** Для режима «Создать изображение»: только провайдеры с API генерации картинок */
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

/** Активирует первого провайдера из приоритета, у кого есть ключ в .env */
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

/** В режиме «Создать изображение» недоступны провайдеры без API картинок */
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
    nameEl.textContent = t ? `Theme: «${t}»` : "Theme: (untitled)";
  }
  el.hidden = false;
  document.documentElement.classList.add("theme-delete-modal-open");
  requestAnimationFrame(() => {
    el.querySelector(".theme-delete-modal-btn-delete")?.focus();
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
}

function openIrChatPanel(mode) {
  const cfg = IR_CHAT_PANELS.find((p) => p.mode === mode);
  if (!cfg) return;
  closeMemoryTree();
  closeMobileThemesDropdown();
  activeThemeId = null;
  activeDialogId = null;
  expandedThemeDialogListThemeId = null;
  chatComposerSending = false;

  const chat = document.getElementById("main-chat");
  const view = document.getElementById(cfg.viewId);
  if (!chat || !view) return;

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
  void renderThemesSidebar();
  refreshThemeHighlightsFromChat();
}

function toggleIrChatPanel(mode) {
  const cfg = IR_CHAT_PANELS.find((p) => p.mode === mode);
  const chat = document.getElementById("main-chat");
  if (!cfg || !chat) return;
  if (chat.classList.contains(cfg.className)) closeIrChatPanel();
  else openIrChatPanel(mode);
}

function initIntroRulesAccessPanels() {
  document.getElementById("btn-ir-intro")?.addEventListener("click", () => toggleIrChatPanel("intro"));
  document.getElementById("btn-ir-rules")?.addEventListener("click", () => toggleIrChatPanel("rules"));
  document.getElementById("btn-ir-access")?.addEventListener("click", () => toggleIrChatPanel("access"));
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
  appendActivityLog(`Theme renamed: «${String(oldTitle || "—").trim()}» → «${String(newTitle).trim()}»`);
  await renderThemesSidebar();
  refreshThemeHighlightsFromChat();
}

/** Меню темы (три полоски): Favorites, Rename, Delete. */
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

/** Свернуть списки диалогов у тем; `exceptCard` — не трогать эту карточку (открываем папку на ней). */
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

  /* Выбор диалога: capture — иначе всплытие не доходит до #dialogue-cards из‑за stopPropagation на панели. */
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

/** На узком экране закрывает выпадающий список тем (иначе он перекрывает поле ввода). Назначается в initDialoguesMenu. */
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

/** Иконка вложения в уже отправленном сообщении (без превью — только контур, как у документа/шестерни/сервера). */
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

function buildUserMessageCopyText(rawText, attachmentStrip) {
  const t = String(rawText ?? "").trim();
  const names = (attachmentStrip ?? [])
    .map((x) => String(x?.name ?? "").trim())
    .filter(Boolean);
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
  sendBtn.disabled = !hasText && !hasFiles;
}

function initNewDialogueButton() {
  const btn = document.getElementById("btn-new-dialogue");
  if (!btn) return;

  btn.addEventListener("click", () => {
    chatComposerSending = false;
    closeMobileThemesDropdown();
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

    composerAttachMode = "";
    refreshModelBadges();
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

  /** «Обычный ввод» только если основная кнопка уже не плюс (показана иконка режима). */
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
      composerAttachMode === "web" || composerAttachMode === "image" || composerAttachMode === "research",
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

/** Текст для API: в режиме «Поиск в сети» добавляется инструкция искать по вводу пользователя. */
function buildChatPromptForApi(userText, mode) {
  const t = String(userText ?? "").trim();
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

/** Двойной шеврон (как у ответа ИИ): вверх = свернуть / развёрнуто, поворот 180° = развернуть */
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

/** Блоки кода в markdown: круглая кнопка «копировать» в правом верхнем углу */
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

/** Иконка «Поиск в сети» (глобус), как в меню вложений */
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

/** Иконка «Создать изображение» (как в меню вложений) */
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

/** Иконка «Deep research» (как в меню вложений) */
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
 *   attachmentStrip?: Array<{ name: string; kind: string }>;
 * }} [options]
 */
function appendUserMessage(rawText, modelLabel, options) {
  const list = document.getElementById("messages-list");
  if (!list) return;

  const webSearch = Boolean(options?.webSearch);
  const imageCreation = Boolean(options?.imageCreation);
  const deepResearch = Boolean(options?.deepResearch);
  const attachmentStrip = Array.isArray(options?.attachmentStrip) ? options.attachmentStrip : [];

  const msg = document.createElement("div");
  msg.className = "msg msg-user";
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
  const copyPlain = buildUserMessageCopyText(rawText, attachmentStrip);
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

/** Подсветка карточек тем в сайдбаре, если название темы встречается в последнем сообщении пользователя. */
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
  el.classList.add("msg-assistant-text--md");
  el.innerHTML = renderAssistantMarkdown(markdownSource);
  enhanceAssistantMarkdownCodeBlocks(el);
}

function setAssistantMessagePlain(el, text) {
  if (!el) return;
  el.classList.remove("msg-assistant-text--md");
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
  textEl.className = "msg-assistant-text";
  textEl.textContent = "Reply…";
  body.appendChild(textEl);
  wrap.appendChild(body);
  list.appendChild(wrap);
  return wrap;
}

/** Кнопка «копировать» у ответа ИИ только если в буфере есть хотя бы один символ (стриминг). */
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
 * После потока или целого ответа: копирование; шеврон «свернуть», если больше 4 строк
 * @param {string} [modelHintOverride] — например модель генерации изображения
 */
function finalizeAssistantBubble(el, fullText, providerId, modelHintOverride) {
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
  let actions = null;
  if (hasChars) {
    actions = document.createElement("div");
    actions.className = "msg-bubble-actions";
    actions.appendChild(makeAssistantFavoriteStarButton(el));
    actions.appendChild(
      makeCopyButton(() => el.dataset.assistantMarkdown ?? "", {
        tryCopyImageFromMarkdown: copyAsImage,
        label: copyAsImage ? "Copy image to clipboard" : "Copy to clipboard",
        title: copyAsImage ? "Copy image" : "Copy",
      }),
    );
    body.appendChild(actions);
    syncAssistantFavoriteStarButton(el);
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
  meta.textContent = hint ? `Replied: ${label} · ${hint}` : `Replied: ${label}`;
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
      actions.appendChild(btn);
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
  appendActivityLog(`Theme deleted: «${String(themeTitle || "—").trim()}»`);
  removeFavoriteThemeId(tid);
  if (String(expandedThemeDialogListThemeId ?? "").trim() === tid) {
    expandedThemeDialogListThemeId = null;
  }
  if (String(activeThemeId ?? "").trim() === tid) {
    activeThemeId = null;
    activeDialogId = null;
    chatComposerSending = false;
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
  const reqProvider = turn.requested_provider_id;
  const respProvider = turn.responding_provider_id || reqProvider;
  const modelLabel = PROVIDER_DISPLAY[reqProvider] ?? reqProvider;
  const rt = turn.request_type || "default";
  /** @type {Array<{ name: string; kind: string }>} */
  let attachmentStrip = [];
  try {
    const j = JSON.parse(String(turn.user_attachments_json ?? "null"));
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
  appendUserMessage(turn.user_text, modelLabel, {
    webSearch: rt === "web",
    imageCreation: rt === "image",
    deepResearch: rt === "research",
    attachmentStrip: attachmentStrip.length > 0 ? attachmentStrip : undefined,
  });
  const pending = appendAssistantPending();
  if (!pending) return;
  pending.dataset.turnId = String(turn.id ?? "");
  pending.dataset.assistantFavorite = Number(turn.assistant_favorite) === 1 ? "1" : "0";
  const text = turn.assistant_text;
  if (text != null && String(text).length > 0) {
    pending.dataset.assistantWebSearch = rt === "web" ? "1" : "";
    pending.dataset.assistantDeepResearch = rt === "research" ? "1" : "";
    if (rt === "image") pending.dataset.assistantResponseKind = "image";
    const te = pending.querySelector(".msg-assistant-text");
    setAssistantMessageMarkdown(te, text);
    const imgHint =
      rt === "image" ? apiImageGenerationModelHint(respProvider) : undefined;
    finalizeAssistantBubble(pending, text, respProvider, imgHint || undefined);
  } else {
    renderAssistantError(pending, "No reply stored for this turn.");
  }
}

/** Выбрана тема: пустой чат; первое сообщение создаст новый диалог в теме. */
async function openThemeForNewDialog(themeId) {
  const tid = String(themeId ?? "").trim();
  if (!tid) return;
  expandedThemeDialogListThemeId = tid;
  chatComposerSending = false;
  closeMobileThemesDropdown();
  activeThemeId = tid;
  activeDialogId = null;
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
 * @param {string} [scrollToTurnId] — после загрузки треда прокрутить к ответу с этим id хода
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
    for (const t of turns) {
      replayTurnInChat(t);
    }
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
    if (!trimmed && filesSnapshot.length === 0) return;

    const mainChatEl = document.getElementById("main-chat");
    if (mainChatEl && irChatPanelIsOpen(mainChatEl)) {
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

    const attachmentStripMeta =
      filesSnapshot.length > 0
        ? filesSnapshot.map((f) => ({
            name: f.name || "file",
            kind: classifyComposerAttachmentKind(f),
          }))
        : [];

    const titleSeed =
      trimmed.trim() ||
      (filesSnapshot.length > 0 ? filesSnapshot.map((f) => f.name || "file").join(", ") : "");

    const userMessageAt = new Date().toISOString();
    let persistDialogId = activeDialogId;

    let pending = null;
    let fullText = "";
    let didAppendUserToUi = false;

    chatComposerSending = true;
    try {
      if (!persistDialogId) {
        try {
          /** Новый диалог в уже выбранной теме: без лишнего вызова LLM. Новая тема: заголовок через LLM с таймаутом. */
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

      /* Режим «Create image»: в API уходит только текст; прикреплённые картинки — явная подсказка в промпте. */
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
      ta.disabled = true;

      appendActivityLog(
        `Chat → request: ${attachModeLogLabel(modeForSend)}, model ${modelLabel}, input chars: ${trimmed.length}, attachments: ${filesSnapshot.length}`,
      );

      appendUserMessage(persistUserText, modelLabel, {
        webSearch: modeForSend === "web",
        imageCreation: modeForSend === "image",
        deepResearch: modeForSend === "research",
        attachmentStrip: attachmentStripMeta.length > 0 ? attachmentStripMeta : undefined,
      });
      didAppendUserToUi = true;
      refreshThemeHighlightsFromChat();
      ta.value = "";
      syncChatInputHeight(ta);
      scrollMessagesToEnd();

      pending = appendAssistantPending();
      if (pending) {
        pending.dataset.assistantWebSearch = modeForSend === "web" ? "1" : "";
        pending.dataset.assistantDeepResearch = modeForSend === "research" ? "1" : "";
        const te0 = pending.querySelector(".msg-assistant-text");
        if (te0 && modeForSend === "image") {
          te0.textContent = "Generating image…";
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
          finalizeAssistantBubble(pending, fullText, providerId, imgHint || undefined);
          appendActivityLog(`Chat ← reply: image, model ${modelLabel}, OK`);
        } else {
          const chatOpts = {
            webSearch: modeForSend === "web",
            deepResearch: modeForSend === "research",
          };
          if (chatAttachments) {
            chatOpts.chatAttachments = chatAttachments;
          }
          if (persistDialogId && modeForSend !== "image" && (await apiHealth())) {
            try {
              const pack = await fetchContextPack(persistDialogId, promptForApi);
              const built = buildModelContext({
                threadId: persistDialogId,
                userPrompt: promptForApi,
                contextPack: pack,
                modelFlags: { recentMessageCount: 10 },
              });
              const fitted = fitContextToBudget(built, MF0_MAX_CONTEXT_INPUT_TOKENS);
              chatOpts.systemInstruction = fitted.systemInstruction;
              chatOpts.llmMessages = fitted.messagesForApi;
              if (import.meta.env.DEV) {
                globalThis.__MF0_LAST_CONTEXT_DEBUG__ = fitted.debug;
              }
            } catch (ctxErr) {
              appendActivityLog(
                `LLM context: single-turn fallback (${ctxErr instanceof Error ? ctxErr.message : String(ctxErr)})`,
              );
            }
          }
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
          finalizeAssistantBubble(pending, fullText, providerId);
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
      scrollMessagesToEnd();
      if (persistDialogId && didAppendUserToUi) {
        const assistantMessageAt = new Date().toISOString();
        const assistantOut =
          pending?.classList.contains("msg-assistant--error") && pending?.dataset?.assistantMarkdown
            ? String(pending.dataset.assistantMarkdown)
            : fullText;
        try {
          /** @type {Record<string, unknown>} */
          const turnPayload = {
            user_text: persistUserText,
            assistant_text: assistantOut || null,
            requested_provider_id: providerId,
            responding_provider_id: providerId,
            request_type: requestTypeFromAttachMode(modeForSend),
            user_message_at: userMessageAt,
            assistant_message_at: assistantMessageAt,
          };
          if (attachmentStripMeta.length > 0) {
            turnPayload.user_attachments_json = JSON.stringify(attachmentStripMeta);
          }
          const saveOut = await saveConversationTurn(persistDialogId, turnPayload);
          const tid = saveOut && typeof saveOut === "object" && saveOut.id != null ? String(saveOut.id) : "";
          if (pending && tid) {
            pending.dataset.turnId = tid;
            syncAssistantFavoriteStarButton(pending);
          }
          await renderThemesSidebar();
        } catch (saveErr) {
          appendActivityLog(
            `Chat DB save: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
          );
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

/** Перетаскивание файлов на область чата — в композер, без кнопки «Добавить фото и файлы». */
function initChatFileDropZone() {
  const mainChat = document.getElementById("main-chat");
  if (!mainChat) return;

  /** После `drop` часть браузеров шлёт ещё `dragover` с типом Files — без этого рамка залипает. */
  let suppressDropHighlightUntil = 0;

  function clearDropHighlight() {
    mainChat.classList.remove(MAIN_CHAT_FILE_DROP_CLASS);
  }

  function onWindowDragOver(e) {
    if (performance.now() < suppressDropHighlightUntil) {
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
    if (!dataTransferHasFileList(e.dataTransfer)) return;
    const t = e.target;
    if (!(t instanceof Node) || !mainChat.contains(t)) return;
    e.preventDefault();
    e.stopPropagation();
    const fl = e.dataTransfer?.files;
    if (fl?.length) {
      addComposerAttachmentsFromFileList(fl);
      /* «Хвостовые» dragover с types: Files после сброса — иначе рамка снова включается. */
      suppressDropHighlightUntil = performance.now() + 600;
    }
    queueMicrotask(() => clearDropHighlight());
  }

  function onWindowDragEnd() {
    clearDropHighlight();
  }

  /** Уход курсора за пределы документа — без следующего `dragover` рамка иначе не снимается. */
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

/** Клик по картинке в истории чата — полноэкранный просмотр; Esc или клик по фону — закрыть. */
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
  initNewDialogueButton();
  initAttachMenu();
  initChatComposer();
  initChatFileDropZone();
  initChatImageLightbox();
  initIntroRulesAccessPanels();

  appendActivityLog("MF0-1984 ready.");

  void (async () => {
    try {
      if (await apiHealth()) {
        await renderThemesSidebar();
        appendActivityLog("Chat database connected.");
      } else {
        appendActivityLog(
          "Chat database offline — запустите API и интерфейс вместе (npm run dev) или pm2:restart; порт API по умолчанию 35184.",
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
