import { getModelApiKeys } from "./modelEnv.js";
import {
  FALLBACK_AI_MODEL_LISTS,
  getUserAiModel,
  mergeModelIdOptions,
  setUserAiModel,
} from "./userChatModels.js";
import * as fetchLists from "./fetchRemoteModelLists.js";

/** @typedef {import("./userChatModels.js").AiSettingsProvider} AiSettingsProvider */
/** @typedef {import("./userChatModels.js").AiModelRole} AiModelRole */

const AI_SETTINGS_PROVIDERS = [
  { provider: "openai", envKey: "openai", title: "ChatGPT", images: true },
  { provider: "perplexity", envKey: "perplexity", title: "Perplexity", images: false },
  { provider: "gemini", envKey: "gemini-flash", title: "Gemini", images: true },
  { provider: "anthropic", envKey: "anthropic", title: "Claude", images: false },
];

const ROLE_ROWS = [
  { role: "dialogue", label: "Dialogue", needsImages: false },
  { role: "images", label: "Images", needsImages: true },
  { role: "search", label: "Search", needsImages: false },
  { role: "research", label: "Research", needsImages: false },
];

/** @type {Set<HTMLElement>} */
const openPickers = new Set();

let listenersBound = false;

/** @type {{ onSave?: () => void }} */
let globalHooks = {};

/**
 * @param {AiSettingsProvider} provider
 * @param {AiModelRole} role
 * @param {string} apiKey
 * @returns {Promise<string[]>}
 */
async function fetchIdsForRole(provider, role, apiKey) {
  switch (provider) {
    case "openai":
      if (role === "dialogue") return fetchLists.fetchOpenAiDialogueModelIds(apiKey);
      if (role === "images") return fetchLists.fetchOpenAiImageModelIds(apiKey);
      if (role === "search") return fetchLists.fetchOpenAiSearchModelIds(apiKey);
      return fetchLists.fetchOpenAiResearchModelIds(apiKey);
    case "perplexity":
      if (role === "dialogue") return fetchLists.fetchPerplexityDialogueModelIds(apiKey);
      if (role === "search") return fetchLists.fetchPerplexitySearchModelIds(apiKey);
      return fetchLists.fetchPerplexityResearchModelIds(apiKey);
    case "gemini":
      if (role === "images") return fetchLists.fetchGeminiImageModelIds(apiKey);
      return fetchLists.fetchGeminiGenerateContentModelIds(apiKey);
    case "anthropic":
      return fetchLists.fetchAnthropicModelIds(apiKey);
    default:
      return [];
  }
}

/**
 * @param {HTMLElement} root
 * @returns {HTMLDivElement}
 */
function ensurePopover(root) {
  const listId = `${root.id}-list`;
  let pop = document.getElementById(listId);
  if (pop instanceof HTMLDivElement) return pop;
  pop = document.createElement("div");
  pop.id = listId;
  pop.className = "settings-model-picker-list";
  pop.setAttribute("role", "listbox");
  pop.hidden = true;
  pop.tabIndex = -1;
  document.body.appendChild(pop);
  return pop;
}

/**
 * @param {HTMLElement | null} trigger
 * @param {HTMLDivElement} list
 */
function positionList(trigger, list) {
  if (!trigger) return;
  const r = trigger.getBoundingClientRect();
  const margin = 4;
  const spaceBelow = window.innerHeight - r.bottom - margin - 12;
  const maxH = Math.min(320, Math.max(120, spaceBelow));
  list.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8))}px`;
  list.style.top = `${r.bottom + margin}px`;
  list.style.width = `${r.width}px`;
  list.style.maxHeight = `${maxH}px`;
}

/**
 * @param {HTMLElement} root
 */
function closePicker(root) {
  const trigger = root.querySelector(".settings-model-picker-trigger");
  const list = document.getElementById(`${root.id}-list`);
  if (list) {
    list.hidden = true;
    list.classList.remove("settings-model-picker-list--open");
  }
  openPickers.delete(root);
  if (trigger) {
    trigger.setAttribute("aria-expanded", "false");
    trigger.classList.remove("settings-model-picker-trigger--open");
  }
}

export function closeAllSettingsModelPickers() {
  for (const root of [...openPickers]) {
    closePicker(root);
  }
}

/**
 * @param {HTMLDivElement} list
 */
function scrollSelectedModelIntoView(list) {
  const sel = list.querySelector('.settings-model-picker-option[aria-selected="true"]');
  if (!(sel instanceof HTMLElement)) return;
  sel.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
}

/**
 * @param {HTMLElement} root
 */
function openPicker(root) {
  closeAllSettingsModelPickers();
  const trigger = root.querySelector(".settings-model-picker-trigger");
  const list = ensurePopover(root);
  positionList(trigger, list);
  list.hidden = false;
  list.classList.add("settings-model-picker-list--open");
  openPickers.add(root);
  if (trigger) {
    trigger.setAttribute("aria-expanded", "true");
    trigger.classList.add("settings-model-picker-trigger--open");
  }
  requestAnimationFrame(() => {
    positionList(trigger, list);
    requestAnimationFrame(() => {
      scrollSelectedModelIntoView(list);
    });
  });
}

/**
 * @param {HTMLDivElement} list
 * @param {string} activeId
 */
function syncSelectedState(list, activeId) {
  list.querySelectorAll(".settings-model-picker-option").forEach((el) => {
    const id = String(el.dataset.value ?? "");
    el.setAttribute("aria-selected", id === activeId ? "true" : "false");
  });
}

/**
 * @param {HTMLElement} root
 * @param {AiSettingsProvider} provider
 * @param {AiModelRole} role
 * @param {string} id
 */
function pickModel(root, provider, role, id) {
  const valueEl = root.querySelector(".settings-model-picker-value");
  const trigger = root.querySelector(".settings-model-picker-trigger");
  const list = document.getElementById(`${root.id}-list`);
  if (valueEl) valueEl.textContent = id;
  if (list) syncSelectedState(list, id);
  if (trigger) {
    trigger.dataset.value = id;
    trigger.focus();
  }
  closePicker(root);
}

/**
 * @param {HTMLElement} root
 * @param {AiSettingsProvider} provider
 * @param {AiModelRole} role
 * @param {string[]} optionIds
 * @param {string} current
 */
function fillPicker(root, provider, role, optionIds, current) {
  const trigger = root.querySelector(".settings-model-picker-trigger");
  const valueEl = root.querySelector(".settings-model-picker-value");
  const list = ensurePopover(root);
  const cur = String(current).trim();
  const merged = [...optionIds];
  const active = cur && merged.includes(cur) ? cur : merged[0] ?? "";
  list.replaceChildren();
  for (const id of merged) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "option");
    btn.className = "settings-model-picker-option";
    btn.dataset.value = id;
    btn.textContent = id;
    btn.setAttribute("aria-selected", id === active ? "true" : "false");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      pickModel(root, provider, role, id);
    });
    list.appendChild(btn);
  }
  if (valueEl) valueEl.textContent = active || "—";
  if (trigger && active) trigger.dataset.value = active;
  syncSelectedState(list, active);
}

/**
 * Rebuilds AI settings (only providers with a key in .env) and fills model pickers.
 */
export async function refreshSettingsModelSelects() {
  closeAllSettingsModelPickers();
  document.querySelectorAll('[id^="settings-ai-"][id$="-list"]').forEach((n) => n.remove());
  const saveWrap = document.getElementById("settings-ai-save-wrap");
  const saveBtnEarly = document.getElementById("settings-ai-save-btn");
  if (saveWrap) {
    saveWrap.hidden = true;
  }
  if (saveBtnEarly instanceof HTMLButtonElement) {
    saveBtnEarly.disabled = true;
  }

  const container = document.getElementById("settings-ai-providers");
  if (!container) return;

  const keys = getModelApiKeys();
  container.replaceChildren();

  let anyProvider = false;
  for (const p of AI_SETTINGS_PROVIDERS) {
    const apiKey = String(keys[p.envKey] ?? "").trim();
    if (!apiKey) continue;
    anyProvider = true;

    const block = document.createElement("div");
    block.className = "settings-ai-provider";

    const name = document.createElement("div");
    name.className = "settings-ai-provider-name";
    name.textContent = p.title;

    const rowsWrap = document.createElement("div");
    rowsWrap.className = "settings-ai-provider-rows";

    const rowsDef = ROLE_ROWS.filter((r) => !r.needsImages || p.images);
    for (const r of rowsDef) {
      const row = document.createElement("div");
      row.className = "settings-ai-row";

      const lab = document.createElement("label");
      lab.className = "settings-ai-role";
      lab.htmlFor = `settings-ai-${p.provider}-${r.role}-trigger`;
      lab.textContent = r.label;

      const root = document.createElement("div");
      root.className = "settings-model-picker";
      root.id = `settings-ai-${p.provider}-${r.role}`;
      root.dataset.provider = p.provider;
      root.dataset.role = r.role;

      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "settings-model-picker-trigger";
      trigger.id = `settings-ai-${p.provider}-${r.role}-trigger`;
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-controls", `${root.id}-list`);
      trigger.setAttribute(
        "aria-label",
        `${p.title} — ${r.label} model`,
      );

      const val = document.createElement("span");
      val.className = "settings-model-picker-value";
      const chev = document.createElement("span");
      chev.className = "settings-model-picker-chevron";
      chev.setAttribute("aria-hidden", "true");
      trigger.append(val, chev);
      root.appendChild(trigger);

      row.append(lab, root);
      rowsWrap.appendChild(row);

      /** @type {AiModelRole} */
      const role = /** @type {AiModelRole} */ (r.role);
      /** @type {AiSettingsProvider} */
      const prov = /** @type {AiSettingsProvider} */ (p.provider);

      let remote = [];
      try {
        remote = await fetchIdsForRole(prov, role, apiKey);
      } catch {
        remote = [];
      }
      const fallback = FALLBACK_AI_MODEL_LISTS[prov]?.[role] ?? [];
      const stored = getUserAiModel(prov, role);
      const merged = mergeModelIdOptions(remote, fallback, stored);
      fillPicker(root, prov, role, merged, stored);
    }

    block.append(name, rowsWrap);
    container.appendChild(block);
  }

  if (!anyProvider) {
    const empty = document.createElement("p");
    empty.className = "settings-ai-empty";
    empty.textContent =
      "No model API keys in the environment for this build. Add keys to .env for local development.";
    container.appendChild(empty);
  }

  const saveBtn = document.getElementById("settings-ai-save-btn");
  if (saveWrap && anyProvider) {
    saveWrap.hidden = false;
  }
  if (saveBtn instanceof HTMLButtonElement) {
    saveBtn.disabled = !anyProvider;
  }
}

/**
 * Writes current picker values from the AI settings panel to localStorage.
 */
export function saveSettingsAiModels() {
  const container = document.getElementById("settings-ai-providers");
  if (!container) return;
  let count = 0;
  container.querySelectorAll(".settings-model-picker").forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    const prov = el.dataset.provider;
    const role = el.dataset.role;
    const val = el.querySelector(".settings-model-picker-value")?.textContent?.trim();
    if (!prov || !role || !val || val === "—") return;
    setUserAiModel(/** @type {AiSettingsProvider} */ (prov), /** @type {AiModelRole} */ (role), val);
    count += 1;
  });
  if (count > 0) {
    globalHooks.onSave?.();
  }
}

/**
 * @param {{ onSave?: () => void }} [hooks]
 */
export function initSettingsModelSelects(hooks = {}) {
  globalHooks = hooks ?? {};

  if (!listenersBound) {
    listenersBound = true;
    document.getElementById("settings-ai-save-btn")?.addEventListener("click", () => {
      saveSettingsAiModels();
    });

    const container = document.getElementById("settings-ai-providers");
    container?.addEventListener("click", (e) => {
      const trigger = e.target?.closest?.(".settings-model-picker-trigger");
      if (!(trigger instanceof HTMLButtonElement)) return;
      if (!container?.contains(trigger)) return;
      const root = trigger.closest(".settings-model-picker");
      if (!(root instanceof HTMLElement)) return;
      e.stopPropagation();
      if (openPickers.has(root)) closePicker(root);
      else openPicker(root);
    });

    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!(e.target instanceof Node)) return;
        for (const root of [...openPickers]) {
          const list = document.getElementById(`${root.id}-list`);
          const trigger = root.querySelector(".settings-model-picker-trigger");
          if (trigger?.contains(e.target)) continue;
          if (list?.contains(e.target)) continue;
          closePicker(root);
        }
      },
      true,
    );

    window.addEventListener("resize", () => closeAllSettingsModelPickers());

    const settingsBody = document.querySelector("#settings-modal .settings-modal-body");
    settingsBody?.addEventListener("scroll", () => closeAllSettingsModelPickers(), { passive: true });

    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || !openPickers.size) return;
        closeAllSettingsModelPickers();
        e.stopPropagation();
      },
      true,
    );
  }
}
