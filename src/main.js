import "./theme.css";
import pkg from "../package.json";
import {
  apiImageGenerationModelHint,
  apiModelHint,
  completeChatMessage,
  completeChatMessageStreaming,
  completeImageGeneration,
  PROVIDER_DISPLAY,
} from "./chatApi.js";
import { renderAssistantMarkdown } from "./markdown.js";
import { getModelApiKeys } from "./modelEnv.js";
import { setTheme } from "./theme.js";

const MAX_LOG_LINES = 400;

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
  if (m === "web") return "поиск в сети";
  if (m === "image") return "изображение";
  if (m === "research") return "глубокое исследование";
  if (m === "files") return "файлы (только выбор)";
  return "обычный текст";
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
    appendActivityLog(isDark ? "Тема: включена светлая" : "Тема: включена тёмная");
  });
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
    appendActivityLog(show ? "Журнал активности: открыт" : "Журнал активности: скрыт");
  });

  clearBtn?.addEventListener("click", () => {
    appendActivityLog("Журнал активности: очищен");
    activityLogLines = [];
    renderActivityLog();
    setOpen(false);
  });

  closeBtn?.addEventListener("click", () => {
    appendActivityLog("Журнал активности: закрыт");
    setOpen(false);
  });
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

const PROVIDER_LABEL_RU = {
  "gemini-flash": "Gemini",
  perplexity: "Perplexity",
  anthropic: "Claude",
  openai: "ChatGPT",
};

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
      const label = PROVIDER_LABEL_RU[id] ?? id;
      appendActivityLog(`Поиск в сети: активен ${label}`);
      return;
    }
  }
  appendActivityLog(
    "Поиск в сети: в .env нет ключей Gemini / Perplexity / Claude / ChatGPT",
  );
}

function activateProviderForDeepResearch() {
  const keys = getModelApiKeys();
  for (const id of DEEP_RESEARCH_PROVIDER_PRIORITY) {
    if (providerHasKey(keys, id) && setActiveProviderBadge(id)) {
      const label = PROVIDER_LABEL_RU[id] ?? id;
      appendActivityLog(`Глубокое исследование: активен ${label}`);
      return;
    }
  }
  appendActivityLog(
    "Глубокое исследование: в .env нет ключей Perplexity / ChatGPT / Gemini / Claude",
  );
}

function activateProviderForImageCreation() {
  const keys = getModelApiKeys();
  for (const id of IMAGE_CREATION_PROVIDER_PRIORITY) {
    if (providerHasKey(keys, id) && setActiveProviderBadge(id)) {
      const label = PROVIDER_LABEL_RU[id] ?? id;
      appendActivityLog(`Создать изображение: активен ${label}`);
      return;
    }
  }
  appendActivityLog("Создать изображение: в .env нет ключей ChatGPT или Gemini");
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
      btn.title = "В режиме «Создать изображение» доступны только ChatGPT и Gemini";
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
    appendActivityLog(`Модель: выбран ${PROVIDER_DISPLAY[pid] ?? pid ?? "—"}`);
  });
}

function initDialogueFavourites() {
  const root = document.getElementById("dialogue-cards");
  if (!root) return;

  root.addEventListener("click", (e) => {
    const star = e.target.closest(".dialog-star");
    if (!star) return;
    e.preventDefault();
    e.stopPropagation();
    const on = star.classList.toggle("is-starred");
    star.setAttribute("aria-pressed", on ? "true" : "false");
    star.setAttribute("aria-label", on ? "Remove from favorites" : "Add to favorites");
    appendActivityLog(on ? "Диалог: в избранном" : "Диалог: убран из избранного");
  });
}

/** Узкий экран: список диалогов в выпадающей панели над чатом */
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
    btn.setAttribute("aria-label", "Open dialogues list");
    cards.removeAttribute("aria-hidden");
  }

  function setOpen(open) {
    if (!isMobile()) {
      applyDesktop();
      return;
    }
    panel.classList.toggle("dialogues-dropdown-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.setAttribute("aria-label", open ? "Close dialogues list" : "Open dialogues list");
    syncCardsAria(open);
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!isMobile()) return;
    const willOpen = !panel.classList.contains("dialogues-dropdown-open");
    setOpen(willOpen);
    appendActivityLog(willOpen ? "Диалоги (моб.): открыт список" : "Диалоги (моб.): закрыт список");
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
}

const ATTACH_TITLES = {
  "": "Добавить",
  files: "Добавить фото и файлы",
  image: "Создать изображение",
  research: "Глубокое исследование",
  web: "Поиск в сети",
};

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
        appendActivityLog('Меню «+»: обычный ввод');
        close();
        return;
      }

      composerAttachMode = action ?? "";
      syncAttachButton();

      if (action === "files") {
        fileInput?.click();
      } else if (action === "image") {
        appendActivityLog('Меню «+»: режим «Создать изображение»');
        activateProviderForImageCreation();
        appendActivityLog("В этом режиме доступны только ChatGPT и Gemini (остальные модели отключены)");
      } else if (action === "research") {
        appendActivityLog('Меню «+»: режим «Глубокое исследование»');
        activateProviderForDeepResearch();
      } else if (action === "web") {
        appendActivityLog('Меню «+»: режим «Поиск в сети»');
        activateProviderForWebSearch();
      }
      refreshModelBadges();
      close();
    });
  });

  fileInput?.addEventListener("change", () => {
    const n = fileInput.files?.length ?? 0;
    if (n > 0) {
      appendActivityLog(`Добавить фото и файлы: выбрано файлов — ${n}`);
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
      "Выполни поиск в интернете по следующему запросу пользователя и ответь, опираясь на актуальные данные из сети. " +
      "По возможности укажи источники (ссылки).\n\n" +
      "Запрос пользователя:\n" +
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
  const label = opts.label ?? "Копировать в буфер обмена";
  const tryImg = Boolean(opts.tryCopyImageFromMarkdown);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-bubble-action-btn msg-bubble-copy";
  btn.setAttribute("aria-label", label);
  btn.title = opts.title ?? (tryImg ? "Копировать изображение" : "Копировать");
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
          "Буфер: не удалось скопировать изображение (сеть или ограничения браузера); скопирован текст ответа",
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
    btn.setAttribute("aria-label", "Копировать код");
    btn.title = "Копировать код";
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

/**
 * @param {string} rawText
 * @param {string} modelLabel
 * @param {{ webSearch?: boolean; imageCreation?: boolean }} [options]
 */
function appendUserMessage(rawText, modelLabel, options) {
  const list = document.getElementById("messages-list");
  if (!list) return;

  const webSearch = Boolean(options?.webSearch);
  const imageCreation = Boolean(options?.imageCreation);

  const msg = document.createElement("div");
  msg.className = "msg msg-user";

  const head = document.createElement("div");
  head.className = "msg-user-head";
  if (webSearch) {
    const webBadge = document.createElement("span");
    webBadge.className = "msg-user-web-badge";
    webBadge.setAttribute("aria-label", "Поиск в сети");
    webBadge.title = "Поиск в сети";
    webBadge.appendChild(createWebSearchBadgeIcon());
    head.appendChild(webBadge);
  }
  if (imageCreation) {
    const imageBadge = document.createElement("span");
    imageBadge.className = "msg-user-image-badge";
    imageBadge.setAttribute("aria-label", "Создать изображение");
    imageBadge.title = "Создать изображение";
    imageBadge.appendChild(createImageCreationBadgeIcon());
    head.appendChild(imageBadge);
  }
  const badge = document.createElement("span");
  badge.className = "msg-model-badge";
  badge.textContent = modelLabel;
  badge.setAttribute("aria-label", `Модель: ${modelLabel}`);
  head.appendChild(badge);

  const content = document.createElement("div");
  content.className = "msg-user-content";

  const textEl = document.createElement("div");
  textEl.className = "msg-user-text msg-user-text--clamped";
  textEl.textContent = rawText;

  const actions = document.createElement("div");
  actions.className = "msg-bubble-actions";
  actions.appendChild(makeCopyButton(() => rawText));

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "msg-bubble-action-btn msg-bubble-chevron";
  expandBtn.setAttribute("aria-expanded", "false");
  expandBtn.setAttribute("aria-label", "Развернуть сообщение");
  expandBtn.title = "Развернуть / свернуть";
  expandBtn.appendChild(createBubbleChevronIcon());

  expandBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const now = msg.classList.toggle("msg-user--expanded");
    expandBtn.setAttribute("aria-expanded", now ? "true" : "false");
    expandBtn.setAttribute("aria-label", now ? "Свернуть сообщение" : "Развернуть сообщение");
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
  textEl.textContent = "Ответ…";
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
  if (!actions.querySelector(".msg-bubble-copy")) {
    actions.insertBefore(
      makeCopyButton(() => wrap.dataset.assistantMarkdown ?? ""),
      actions.firstChild,
    );
  }
}

function renderAssistantError(el, message) {
  if (!el) return;
  el.classList.remove("msg-assistant--pending");
  el.classList.add("msg-assistant--error");
  el.replaceChildren();
  delete el.dataset.assistantResponseKind;
  delete el.dataset.assistantWebSearch;
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
    actions.appendChild(makeCopyButton(() => el.dataset.assistantMarkdown ?? ""));
    body.appendChild(actions);
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
    actions.appendChild(
      makeCopyButton(() => el.dataset.assistantMarkdown ?? "", {
        tryCopyImageFromMarkdown: copyAsImage,
        label: copyAsImage ? "Копировать изображение в буфер обмена" : "Копировать в буфер обмена",
        title: copyAsImage ? "Копировать изображение" : "Копировать",
      }),
    );
    body.appendChild(actions);
  }

  const meta = document.createElement("div");
  meta.className = "msg-assistant-model";
  const label = PROVIDER_DISPLAY[providerId] ?? providerId;
  const hint =
    modelHintOverride != null && String(modelHintOverride).trim()
      ? String(modelHintOverride).trim()
      : apiModelHint(providerId, { webSearch: el.dataset.assistantWebSearch === "1" });
  meta.textContent = hint ? `Ответил: ${label} · ${hint}` : `Ответил: ${label}`;
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
      btn.setAttribute("aria-label", "Свернуть ответ");
      btn.title = "Свернуть / развернуть";
      btn.appendChild(createBubbleChevronIcon());
      actions.appendChild(btn);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const collapsed = el.classList.toggle("msg-assistant--collapsed");
        btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
        btn.setAttribute("aria-label", collapsed ? "Развернуть ответ" : "Свернуть ответ");
      });
    });
  });
}

function initChatComposer() {
  const ta = document.getElementById("chat-input");
  const sendBtn = document.getElementById("btn-chat-send");
  if (!ta || !sendBtn) return;

  syncChatInputHeight(ta);
  ta.addEventListener("input", () => syncChatInputHeight(ta));

  let sending = false;

  async function submitChat() {
    if (sending) return;
    const trimmed = ta.value.trim();
    if (!trimmed) return;

    const providerId = getActiveProviderId();
    if (!providerId) {
      appendActivityLog("Чат → запрос отменён: нет выбранной модели с ключом (.env)");
      return;
    }

    const keys = getModelApiKeys();
    const key = keys[providerId];
    if (!String(key ?? "").trim()) {
      appendActivityLog(
        `Чат → запрос отменён: нет ключа для ${PROVIDER_DISPLAY[providerId] ?? providerId}`,
      );
      return;
    }

    const modelLabel = PROVIDER_DISPLAY[providerId] ?? providerId;
    const modeForSend = composerAttachMode;
    const promptForApi = buildChatPromptForApi(trimmed, modeForSend);
    sending = true;
    sendBtn.disabled = true;
    ta.disabled = true;

    appendActivityLog(
      `Чат → запрос: ${attachModeLogLabel(modeForSend)}, модель ${modelLabel}, символов ввода: ${trimmed.length}`,
    );

    appendUserMessage(trimmed, modelLabel, {
      webSearch: modeForSend === "web",
      imageCreation: modeForSend === "image",
    });
    ta.value = "";
    syncChatInputHeight(ta);
    scrollMessagesToEnd();

    const pending = appendAssistantPending();
    if (pending) {
      pending.dataset.assistantWebSearch = modeForSend === "web" ? "1" : "";
      const te0 = pending.querySelector(".msg-assistant-text");
      if (te0 && modeForSend === "image") {
        te0.textContent = "Генерация изображения…";
      }
    }
    scrollMessagesToEnd();

    try {
      if (pending) {
        delete pending.dataset.assistantResponseKind;
      }
      let fullText = "";
      if (modeForSend === "image") {
        const { text } = await completeImageGeneration(providerId, promptForApi, key);
        fullText = text;
        const te = pending?.querySelector(".msg-assistant-text");
        if (te) setAssistantMessageMarkdown(te, fullText);
        scrollMessagesToEnd();
        const imgHint = apiImageGenerationModelHint(providerId);
        if (pending) {
          pending.dataset.assistantResponseKind = "image";
        }
        finalizeAssistantBubble(pending, fullText, providerId, imgHint || undefined);
        appendActivityLog(`Чат ← ответ: изображение, модель ${modelLabel}, OK`);
      } else {
        const chatOpts = { webSearch: modeForSend === "web" };
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
              syncAssistantCopyButtonDuringStream(pending);
              scrollMessagesToEnd();
            },
            chatOpts,
          );
        } catch {
          appendActivityLog(`Чат: стрим недоступен, запрос целиком (${modelLabel})`);
          const { text } = await completeChatMessage(providerId, promptForApi, key, chatOpts);
          fullText = text;
          const te = pending.querySelector(".msg-assistant-text");
          if (te) setAssistantMessageMarkdown(te, fullText);
          scrollMessagesToEnd();
        }
        finalizeAssistantBubble(pending, fullText, providerId);
        appendActivityLog(
          `Чат ← ответ: текст, модель ${modelLabel}, символов ответа: ${String(fullText).length}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      renderAssistantError(pending, msg);
      appendActivityLog(
        `Чат ← ошибка, модель ${modelLabel}: ${msg.length > 280 ? `${msg.slice(0, 280)}…` : msg}`,
      );
    } finally {
      sending = false;
      sendBtn.disabled = false;
      ta.disabled = false;
      scrollMessagesToEnd();
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

initThemeToggle();
initActivityPanel();
initProviderBadges();
initDialogueFavourites();
initDialoguesMenu();
initAttachMenu();
initChatComposer();

appendActivityLog("MF0-1984 ready.");

const keys = getModelApiKeys();
const configured = Object.entries(keys).filter(([, v]) => v.length > 0);
if (configured.length) {
  appendActivityLog(`Ключи в .env: ${configured.map(([k]) => k).join(", ")}`);
} else {
  appendActivityLog("Ключи моделей в .env не загружены (проверьте .env для dev).");
}
