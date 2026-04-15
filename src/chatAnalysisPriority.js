const STORAGE_KEY = "mf0.settings.chatAnalysisPriority";

/** @typedef {"openai" | "anthropic" | "gemini-flash" | "perplexity"} ChatAnalysisProviderId */

/** @type {ChatAnalysisProviderId[]} */
const DEFAULT_CHAT_ANALYSIS_PRIORITY = ["openai", "anthropic", "gemini-flash", "perplexity"];

const PROVIDER_TITLE = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  "gemini-flash": "Gemini",
  perplexity: "Perplexity",
};

/**
 * @param {unknown} raw
 * @returns {ChatAnalysisProviderId[]}
 */
function normalizePriority(raw) {
  const rest = [...DEFAULT_CHAT_ANALYSIS_PRIORITY];
  const out = [];
  if (Array.isArray(raw)) {
    for (const x of raw) {
      const id = String(x ?? "").trim();
      if (!DEFAULT_CHAT_ANALYSIS_PRIORITY.includes(/** @type {ChatAnalysisProviderId} */ (id))) continue;
      if (out.includes(/** @type {ChatAnalysisProviderId} */ (id))) continue;
      out.push(/** @type {ChatAnalysisProviderId} */ (id));
    }
  }
  for (const id of rest) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * @returns {ChatAnalysisProviderId[]}
 */
export function getChatAnalysisPriority() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_CHAT_ANALYSIS_PRIORITY];
    return normalizePriority(JSON.parse(raw));
  } catch {
    return [...DEFAULT_CHAT_ANALYSIS_PRIORITY];
  }
}

/**
 * @param {ChatAnalysisProviderId[]} order
 */
export function setChatAnalysisPriority(order) {
  const normalized = normalizePriority(order);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    /* ignore */
  }
}

/** @type {{ onSave?: () => void }} */
let globalHooks = {};
let listenersBound = false;

function readPriorityFromDom() {
  const list = document.getElementById("settings-chat-analysis-priority-list");
  if (!(list instanceof HTMLElement)) return getChatAnalysisPriority();
  const out = [];
  list.querySelectorAll("[data-provider-id]").forEach((el) => {
    const id = String(el.getAttribute("data-provider-id") ?? "").trim();
    if (!DEFAULT_CHAT_ANALYSIS_PRIORITY.includes(/** @type {ChatAnalysisProviderId} */ (id))) return;
    if (out.includes(/** @type {ChatAnalysisProviderId} */ (id))) return;
    out.push(/** @type {ChatAnalysisProviderId} */ (id));
  });
  return normalizePriority(out);
}

function savePriorityFromDom() {
  setChatAnalysisPriority(readPriorityFromDom());
  globalHooks.onSave?.();
}

export function refreshChatAnalysisPrioritySettings() {
  const list = document.getElementById("settings-chat-analysis-priority-list");
  if (!(list instanceof HTMLElement)) return;
  const order = getChatAnalysisPriority();
  list.replaceChildren();
  for (const id of order) {
    const item = document.createElement("div");
    item.className = "settings-analysis-priority-item";
    item.setAttribute("draggable", "true");
    item.setAttribute("data-provider-id", id);

    const grip = document.createElement("span");
    grip.className = "settings-analysis-priority-grip";
    grip.setAttribute("aria-hidden", "true");
    grip.textContent = "⋮⋮";

    const label = document.createElement("span");
    label.className = "settings-analysis-priority-label";
    label.textContent = PROVIDER_TITLE[id] ?? id;

    item.append(grip, label);
    list.appendChild(item);
  }
}

/**
 * @param {{ onSave?: () => void }} [hooks]
 */
export function initChatAnalysisPrioritySettings(hooks = {}) {
  globalHooks = hooks ?? {};
  refreshChatAnalysisPrioritySettings();
  if (listenersBound) return;
  listenersBound = true;

  const list = document.getElementById("settings-chat-analysis-priority-list");
  if (!(list instanceof HTMLElement)) return;

  /** @type {HTMLElement | null} */
  let dragging = null;
  const EDGE_SCROLL_PX = 48;
  const EDGE_SCROLL_STEP = 18;

  /**
   * FLIP animation for smooth horizontal reordering.
   * @param {() => void} mutate
   */
  function animateReorder(mutate) {
    const items = [...list.querySelectorAll(".settings-analysis-priority-item")];
    const before = new Map(items.map((el) => [el, el.getBoundingClientRect()]));
    mutate();
    const afterItems = [...list.querySelectorAll(".settings-analysis-priority-item")];
    for (const el of afterItems) {
      const a = before.get(el);
      if (!a) continue;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      if (Math.abs(dx) < 0.5) continue;
      el.style.transition = "none";
      el.style.transform = `translateX(${dx}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "transform 160ms ease";
        el.style.transform = "translateX(0)";
        const clear = () => {
          el.style.transition = "";
          el.style.transform = "";
          el.removeEventListener("transitionend", clear);
        };
        el.addEventListener("transitionend", clear);
      });
    }
  }

  function dragAfterElement(x) {
    const els = [...list.querySelectorAll(".settings-analysis-priority-item")].filter((el) => el !== dragging);
    let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const offset = x - r.left - r.width / 2;
      if (offset < 0 && offset > closest.offset) {
        closest = { offset, element: el };
      }
    }
    return closest.element;
  }

  list.addEventListener("dragstart", (e) => {
    const item = e.target?.closest?.(".settings-analysis-priority-item");
    if (!(item instanceof HTMLElement)) return;
    dragging = item;
    item.classList.add("settings-analysis-priority-item--dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(item.dataset.providerId ?? ""));
    }
  });

  list.addEventListener("dragend", () => {
    const hadDragging = dragging;
    if (dragging) dragging.classList.remove("settings-analysis-priority-item--dragging");
    dragging = null;
    if (hadDragging) savePriorityFromDom();
  });

  list.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();
    const lr = list.getBoundingClientRect();
    if (e.clientX < lr.left + EDGE_SCROLL_PX) {
      list.scrollLeft -= EDGE_SCROLL_STEP;
    } else if (e.clientX > lr.right - EDGE_SCROLL_PX) {
      list.scrollLeft += EDGE_SCROLL_STEP;
    }
    const after = dragAfterElement(e.clientX);
    if (!after) {
      if (list.lastElementChild !== dragging) {
        animateReorder(() => {
          list.appendChild(dragging);
        });
      }
    } else if (after !== dragging && after.previousElementSibling !== dragging) {
      animateReorder(() => {
        list.insertBefore(dragging, after);
      });
    }
  });

  list.addEventListener("drop", (e) => {
    if (!dragging) return;
    e.preventDefault();
    savePriorityFromDom();
  });
}
