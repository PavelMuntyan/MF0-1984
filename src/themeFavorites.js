const STORAGE_KEY = "mf-lab-theme-favorites";

function normId(v) {
  return String(v ?? "").trim();
}

export function getFavoriteThemeIdSet() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map((x) => normId(x)).filter(Boolean));
  } catch {
    return new Set();
  }
}

function saveFavoriteSet(set) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
}

/** @returns {boolean} new state: true = now favorited */
export function toggleFavoriteThemeId(themeId) {
  const id = normId(themeId);
  if (!id) return false;
  const set = getFavoriteThemeIdSet();
  let on;
  if (set.has(id)) {
    set.delete(id);
    on = false;
  } else {
    set.add(id);
    on = true;
  }
  saveFavoriteSet(set);
  return on;
}

export function removeFavoriteThemeId(themeId) {
  const id = normId(themeId);
  if (!id) return;
  const set = getFavoriteThemeIdSet();
  if (set.delete(id)) saveFavoriteSet(set);
}

/** Favorites first in API list order, then the rest. */
export function sortThemesFavoritesFirst(themes, favSet) {
  const fav = [];
  const rest = [];
  for (const t of themes) {
    const id = normId(t?.id);
    if (id && favSet.has(id)) fav.push(t);
    else rest.push(t);
  }
  return [...fav, ...rest];
}
