import "./theme.css";
import pkg from "../package.json";
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
    setOpen(panel?.hidden ?? true);
  });

  clearBtn?.addEventListener("click", () => {
    activityLogLines = [];
    renderActivityLog();
    setOpen(false);
  });

  closeBtn?.addEventListener("click", () => setOpen(false));
}

const versionEl = document.getElementById("app-version");
if (versionEl) {
  versionEl.textContent = `v${pkg.version ?? "0.0.1"}`;
}

/** Порядок выбора активного провайдера по умолчанию */
const PROVIDER_ORDER = ["openai", "perplexity", "gemini", "anthropic"];

function providerHasKey(keys, id) {
  return Boolean(String(keys[id] ?? "").trim());
}

/** Для режима «Поиск в сети»: Gemini → Perplexity → Claude → ChatGPT */
const WEB_SEARCH_PROVIDER_PRIORITY = ["gemini", "perplexity", "anthropic", "openai"];

/** Для режима «Глубокое исследование»: Perplexity → ChatGPT → Gemini → Claude */
const DEEP_RESEARCH_PROVIDER_PRIORITY = ["perplexity", "openai", "gemini", "anthropic"];

/** Для режима «Создать изображение»: ChatGPT → Gemini → Claude → Perplexity */
const IMAGE_CREATION_PROVIDER_PRIORITY = ["openai", "gemini", "anthropic", "perplexity"];

const PROVIDER_LABEL_RU = {
  gemini: "Gemini",
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
  appendActivityLog("Поиск в сети: в .env нет ключей Gemini / Perplexity / Claude / ChatGPT");
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
  appendActivityLog(
    "Создать изображение: в .env нет ключей ChatGPT / Gemini / Claude / Perplexity",
  );
}

function initProviderBadges() {
  const wrap = document.getElementById("model-badges");
  if (!wrap) return;

  const keys = getModelApiKeys();
  const buttons = [...wrap.querySelectorAll("[data-provider]")];

  for (const btn of buttons) {
    const id = btn.getAttribute("data-provider");
    if (!id) continue;
    if (!providerHasKey(keys, id)) {
      btn.classList.add("badge--no-key");
      btn.classList.remove("active");
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
    } else {
      btn.classList.remove("badge--no-key");
      btn.disabled = false;
      btn.removeAttribute("aria-disabled");
    }
  }

  for (const btn of buttons) {
    btn.classList.remove("active");
  }
  const firstOk = PROVIDER_ORDER.find((id) => providerHasKey(keys, id));
  if (firstOk) {
    wrap.querySelector(`[data-provider="${firstOk}"]`)?.classList.add("active");
  }

  wrap.addEventListener("click", (e) => {
    const t = e.target.closest("[data-provider]");
    if (!t || t.disabled || t.classList.contains("badge--no-key")) return;
    for (const b of buttons) {
      b.classList.remove("active");
    }
    t.classList.add("active");
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
  });
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

  let attachMode = "";

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
    if (!attachMode) {
      visual.textContent = "+";
      visual.classList.remove("btn-attach-visual--icon");
    } else {
      const svg = cloneMenuIconSvg(attachMode);
      visual.classList.add("btn-attach-visual--icon");
      if (svg) {
        visual.replaceChildren(svg);
      } else {
        visual.textContent = "+";
        visual.classList.remove("btn-attach-visual--icon");
      }
    }
    btn.title = ATTACH_TITLES[attachMode] ?? ATTACH_TITLES[""];
    btn.setAttribute("aria-label", ATTACH_TITLES[attachMode] ?? ATTACH_TITLES[""]);
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
        attachMode = "";
        syncAttachButton();
        close();
        return;
      }

      attachMode = action ?? "";
      syncAttachButton();

      if (action === "files") {
        fileInput?.click();
      } else if (action === "image") {
        appendActivityLog("[меню] Создать изображение");
        activateProviderForImageCreation();
      } else if (action === "research") {
        appendActivityLog("[меню] Глубокое исследование");
        activateProviderForDeepResearch();
      } else if (action === "web") {
        appendActivityLog("[меню] Поиск в сети");
        activateProviderForWebSearch();
      }
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

initThemeToggle();
initActivityPanel();
initProviderBadges();
initDialogueFavourites();
initAttachMenu();

appendActivityLog("MF0-1984 ready.");

const keys = getModelApiKeys();
const configured = Object.entries(keys).filter(([, v]) => v.length > 0);
if (configured.length) {
  appendActivityLog(`Providers with keys in .env: ${configured.map(([k]) => k).join(", ")}`);
} else {
  appendActivityLog("No model API keys loaded (check .env for dev).");
}
