/** Build theme list cards (one row per theme; folder lists dialogs). */
/* innerHTML is used only for static SVG snippets defined in this file (not user text). */

import { formatThemeMetaLocal } from "./themeMetaTime.js";

const FOLDER_SVG_CLOSED = `<svg class="dialog-folder-icon dialog-folder-icon--closed" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.53 2.9A2 2 0 0 0 7.56 2H4a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2Z"/></svg>`;
const FOLDER_SVG_OPEN = `<svg class="dialog-folder-icon dialog-folder-icon--open" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-1.6-2l-1.8-1.2A2 2 0 0 0 16.74 4H9.5a2 2 0 0 0-2 2v2"/><path d="M2 14h12a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Z"/></svg>`;

const HAMBURGER_SVG = `<svg class="dialog-theme-menu-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`;

const MENU_STAR_SVG = `<svg class="dialog-theme-actions-star-svg" viewBox="0 0 24 24" aria-hidden="true"><path class="dialog-theme-actions-star-path" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;

const TITLE_STAR_SVG = `<svg class="dialog-card-title-star-svg" viewBox="0 0 24 24" aria-hidden="true"><path class="dialog-card-title-star-path" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;

const MENU_FILE_SVG = `<svg class="dialog-theme-actions-icon-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;

const MENU_TRASH_SVG = `<svg class="dialog-theme-actions-icon-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

const DIALOGS_PAGE_SIZE = 5;

/**
 * @param {object} theme
 * @param {string | null} activeDialogId
 * @param {string | null} activeThemeId — theme selected for a new dialog (empty chat)
 * @param {(themeId: string) => void} onSelectThemeForNewDialog — click theme row except menu/folder (new dialog)
 * @param {string | null} [expandedFolderThemeId] — theme id whose dialog list is expanded
 * @param {Set<string>} [favoriteThemeIds] — favorite theme ids (yellow star in title row)
 */
function normId(v) {
  return String(v ?? "").trim();
}

/** Dialog label in theme menu: up to 28 chars, then ellipsis if trimmed. */
function formatDialogMenuTitle(raw) {
  const s = String(raw ?? "").trim() || "Dialogue";
  if (s.length <= 28) return s;
  return `${s.slice(0, 28)}…`;
}

/**
 * @param {object} d
 * @param {string|number} themeId
 * @param {boolean} isActive
 */
function createDialogMenuItem(d, themeId, isActive) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "dialog-folder-menu-item";
  if (isActive) item.classList.add("dialog-folder-menu-item--active");
  item.setAttribute("role", "menuitem");
  item.dataset.dialogId = d.id;
  item.dataset.themeId = themeId;
  const bullet = document.createElement("span");
  bullet.className = "dialog-folder-menu-item-bullet";
  bullet.setAttribute("aria-hidden", "true");
  bullet.textContent = "•";
  const label = document.createElement("span");
  label.className = "dialog-folder-menu-item-label";
  const fullDialogTitle = String(d.title ?? "").trim() || "Dialogue";
  const menuLabel = formatDialogMenuTitle(d.title);
  label.textContent = menuLabel;
  if (menuLabel !== fullDialogTitle) {
    item.setAttribute("title", fullDialogTitle);
  }
  item.append(bullet, label);
  return item;
}

export function buildThemeCard(
  theme,
  activeDialogId,
  activeThemeId,
  onSelectThemeForNewDialog,
  expandedFolderThemeId = null,
  favoriteThemeIds = null,
) {
  const dialogs = Array.isArray(theme.dialogs) ? theme.dialogs : [];
  const favSet = favoriteThemeIds instanceof Set ? favoriteThemeIds : new Set();
  const isFavorite = Boolean(normId(theme.id) && favSet.has(normId(theme.id)));

  const card = document.createElement("div");
  card.className = "dialog-card";
  card.dataset.themeId = theme.id;
  const ad = normId(activeDialogId);
  const at = normId(activeThemeId);
  const selectedByDialog = Boolean(ad && dialogs.some((d) => normId(d.id) === ad));
  const selectedByThemeOnly = Boolean(!ad && at && normId(theme.id) === at);
  if (selectedByDialog || selectedByThemeOnly) {
    card.classList.add("dialog-card--selected");
  }

  const inner = document.createElement("div");
  inner.className = "dialog-card-inner";

  const info = document.createElement("div");
  info.className = "dialog-card-info";

  const titleRow = document.createElement("div");
  titleRow.className = "dialog-card-title-row";
  if (isFavorite) titleRow.classList.add("dialog-card-title-row--favorite");

  const titleStar = document.createElement("span");
  titleStar.className = "dialog-card-title-star";
  titleStar.setAttribute("aria-hidden", "true");
  titleStar.innerHTML = TITLE_STAR_SVG;

  const titleEl = document.createElement("div");
  titleEl.className = "dialog-card-title";
  titleEl.textContent = theme.title ?? "";

  titleRow.append(titleStar, titleEl);

  const meta = document.createElement("div");
  meta.className = "dialog-card-meta";
  const line1 = document.createElement("span");
  line1.className = "dialog-card-meta-line";
  line1.textContent = `Starter ${formatThemeMetaLocal(theme.starterDate)}`;
  const line2 = document.createElement("span");
  line2.className = "dialog-card-meta-line";
  line2.textContent = `Last action ${formatThemeMetaLocal(theme.lastActionDate)}`;
  meta.append(line1, line2);
  info.append(titleRow, meta);

  const actions = document.createElement("div");
  actions.className = "dialog-card-actions";

  const themeMenuWrap = document.createElement("div");
  themeMenuWrap.className = "dialog-card-theme-menu-wrap";

  const themeMenuBtn = document.createElement("button");
  themeMenuBtn.type = "button";
  themeMenuBtn.className = "dialog-theme-menu-btn";
  themeMenuBtn.setAttribute("aria-expanded", "false");
  themeMenuBtn.setAttribute("aria-haspopup", "true");
  themeMenuBtn.setAttribute("aria-label", "Theme actions");
  themeMenuBtn.innerHTML = HAMBURGER_SVG;

  const themeActionsMenu = document.createElement("div");
  themeActionsMenu.className = "dialog-theme-actions-menu";
  themeActionsMenu.setAttribute("role", "menu");
  themeActionsMenu.setAttribute("aria-label", "Theme actions");
  themeActionsMenu.hidden = true;

  function makeActionItem(action, label, iconHtml) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "dialog-theme-actions-item";
    row.setAttribute("role", "menuitem");
    row.dataset.themeAction = action;
    const ic = document.createElement("span");
    ic.className = "dialog-theme-actions-item-icon";
    ic.setAttribute("aria-hidden", "true");
    ic.innerHTML = iconHtml;
    const lab = document.createElement("span");
    lab.className = "dialog-theme-actions-item-label";
    lab.textContent = label;
    row.append(ic, lab);
    if (action === "favorites") {
      ic.querySelector(".dialog-theme-actions-star-svg")?.classList.add("dialog-theme-actions-star");
    }
    return row;
  }

  const favItem = makeActionItem("favorites", "Favorites", MENU_STAR_SVG);
  if (isFavorite) favItem.classList.add("is-active");
  themeActionsMenu.append(
    favItem,
    makeActionItem("rename", "Rename", MENU_FILE_SVG),
    makeActionItem("delete", "Delete", MENU_TRASH_SVG),
  );

  themeMenuWrap.append(themeMenuBtn, themeActionsMenu);

  const folderWrap = document.createElement("div");
  folderWrap.className = "dialog-card-folder-wrap";

  const folderBtn = document.createElement("button");
  folderBtn.type = "button";
  folderBtn.className = "dialog-folder-btn";
  const folderExpanded = Boolean(
    expandedFolderThemeId != null && normId(theme.id) === normId(expandedFolderThemeId),
  );
  folderBtn.setAttribute("aria-expanded", folderExpanded ? "true" : "false");
  folderBtn.setAttribute("aria-haspopup", "true");
  folderBtn.setAttribute("aria-label", "Show dialogues in this theme");
  folderBtn.innerHTML = FOLDER_SVG_CLOSED + FOLDER_SVG_OPEN;

  const menu = document.createElement("div");
  menu.className = "dialog-folder-menu";
  menu.setAttribute("role", "presentation");
  menu.setAttribute("aria-label", "Theme dialogues");
  menu.hidden = !folderExpanded;

  const menuInner = document.createElement("div");
  menuInner.className = "dialog-folder-menu-inner";

  let visibleDialogCount = 0;

  function removeMoreRow() {
    menu.querySelector(".dialog-folder-more-wrap")?.remove();
  }

  function appendMoreRow() {
    removeMoreRow();
    if (visibleDialogCount >= dialogs.length) return;
    const wrap = document.createElement("div");
    wrap.className = "dialog-folder-more-wrap";
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "dialog-folder-more-btn";
    moreBtn.textContent = "More...";
    moreBtn.setAttribute("aria-label", "Show more dialogues in this theme");
    moreBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const next = Math.min(visibleDialogCount + DIALOGS_PAGE_SIZE, dialogs.length);
      for (let i = visibleDialogCount; i < next; i++) {
        menuInner.appendChild(
          createDialogMenuItem(dialogs[i], theme.id, normId(dialogs[i]?.id) === ad),
        );
      }
      visibleDialogCount = next;
      appendMoreRow();
    });
    wrap.appendChild(moreBtn);
    menu.appendChild(wrap);
  }

  function showInitialDialogs() {
    menuInner.replaceChildren();
    visibleDialogCount = 0;
    const first = Math.min(DIALOGS_PAGE_SIZE, dialogs.length);
    for (let i = 0; i < first; i++) {
      menuInner.appendChild(
        createDialogMenuItem(dialogs[i], theme.id, normId(dialogs[i]?.id) === ad),
      );
    }
    visibleDialogCount = first;
    appendMoreRow();
  }

  menu.appendChild(menuInner);
  if (dialogs.length > 0) {
    showInitialDialogs();
  }

  folderWrap.append(folderBtn);
  actions.append(themeMenuWrap, folderWrap);
  inner.append(info, actions);
  card.appendChild(inner);
  /* Dialog list inside the theme bubble, expands downward (not a separate dropdown). */
  card.appendChild(menu);

  const themeId = normId(theme.id);
  /* Clicks on card padding miss inner — without this, "new dialog in theme" selection did not fire. */
  if (themeId && typeof onSelectThemeForNewDialog === "function") {
    card.addEventListener("click", (e) => {
      if (
        e.target.closest(".dialog-card-theme-menu-wrap") ||
        e.target.closest(".dialog-card-folder-wrap") ||
        e.target.closest(".dialog-folder-menu")
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      onSelectThemeForNewDialog(themeId);
    });
  }

  return card;
}

/**
 * @param {HTMLElement} root
 * @param {object[]} themes
 * @param {string | null} activeDialogId
 * @param {string | null} [activeThemeId]
 * @param {(themeId: string) => void} [onSelectThemeForNewDialog]
 * @param {string | null} [expandedFolderThemeId]
 * @param {Set<string>} [favoriteThemeIds]
 */
export function renderThemeCards(
  root,
  themes,
  activeDialogId,
  activeThemeId = null,
  onSelectThemeForNewDialog,
  expandedFolderThemeId = null,
  favoriteThemeIds = null,
) {
  root.replaceChildren();
  for (const t of themes) {
    root.appendChild(
      buildThemeCard(
        t,
        activeDialogId,
        activeThemeId,
        onSelectThemeForNewDialog,
        expandedFolderThemeId,
        favoriteThemeIds,
      ),
    );
  }
}

/**
 * Updates theme card + folder row selection from current ids without refetching `/api/themes`
 * (e.g. right after picking a dialog while turns are still loading).
 *
 * @param {HTMLElement | null} root `#dialogue-cards`
 * @param {string | null} activeDialogId
 * @param {string | null} [activeThemeId]
 */
export function syncSidebarSelectionState(root, activeDialogId, activeThemeId = null) {
  const r = root ?? document.getElementById("dialogue-cards");
  if (!r) return;
  const ad = normId(activeDialogId);
  const at = normId(activeThemeId);
  const adSel = ad && typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(ad) : ad;

  for (const item of r.querySelectorAll(".dialog-folder-menu-item")) {
    const id = normId(item.getAttribute("data-dialog-id"));
    item.classList.toggle("dialog-folder-menu-item--active", Boolean(ad && id === ad));
  }

  for (const card of r.querySelectorAll(".dialog-card")) {
    const tid = normId(card.dataset.themeId);
    let selectedByDialog = Boolean(
      ad && card.querySelector(`.dialog-folder-menu-item[data-dialog-id="${adSel}"]`),
    );
    /* Folder list is paginated — the open dialog row may not be mounted yet; still mark this theme card. */
    if (ad && !selectedByDialog && at && tid === at) {
      selectedByDialog = true;
    }
    const selectedByThemeOnly = Boolean(!ad && at && tid === at);
    card.classList.toggle("dialog-card--selected", selectedByDialog || selectedByThemeOnly);
  }
}
