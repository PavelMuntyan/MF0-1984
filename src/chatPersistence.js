/** Client for /api chat persistence (themes, dialogs, turns). */

/** Respects `import.meta.env.BASE_URL` when the app is not at the site root. */
function apiUrl(path) {
  const p = String(path ?? "").replace(/^\//, "");
  const base = new URL(import.meta.env.BASE_URL || "/", window.location.origin);
  let href = new URL(p, base).href;
  /* new URL('api/…', '…/api/') can yield …/api/api/… — API then returns 404 Not found */
  while (href.includes("/api/api/")) {
    href = href.replace("/api/api/", "/api/");
  }
  return href;
}

export function titleFromUserMessage(text) {
  const line = String(text ?? "")
    .trim()
    .split(/\r?\n/)
    .find((l) => l.trim().length > 0);
  if (!line) return "New conversation";
  const collapsed = line.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 56) return collapsed;
  return `${collapsed.slice(0, 53)}…`;
}

export function requestTypeFromAttachMode(mode) {
  const m = String(mode ?? "");
  if (m === "web") return "web";
  if (m === "image") return "image";
  if (m === "research") return "research";
  return "default";
}

export async function apiHealth() {
  const res = await fetch(apiUrl("api/health"));
  if (!res.ok) return false;
  const data = await res.json().catch(() => ({}));
  /** Reject another service on the same path (e.g. response without our marker). */
  return data.ok === true && data.mfLabApi === true;
}

export async function fetchThemesPayload() {
  const res = await fetch(apiUrl("api/themes"));
  if (!res.ok) throw new Error(`Themes ${res.status}`);
  return res.json();
}

export async function fetchTurns(dialogId) {
  const res = await fetch(apiUrl(`api/dialogs/${encodeURIComponent(dialogId)}/turns`));
  if (!res.ok) throw new Error(`Turns ${res.status}`);
  const data = await res.json();
  return data.turns ?? [];
}

/**
 * Payload for building LLM context (thread = dialog id).
 * Tries GET /context-pack first (rules, memory, summaries, thread_messages).
 * On 404/old API, builds from existing /turns and /themes so dialog history still reaches the model.
 */
export async function fetchContextPack(dialogId, userQuery = "") {
  const did = String(dialogId ?? "").trim();
  if (!did) throw new Error("dialogId required");
  const q = encodeURIComponent(String(userQuery ?? "").slice(0, 2000));
  const res = await fetch(apiUrl(`api/dialogs/${encodeURIComponent(did)}/context-pack?q=${q}`));
  if (res.ok) {
    return res.json();
  }

  const [turns, themesData] = await Promise.all([fetchTurns(did), fetchThemesPayload()]);
  const themes = themesData.themes ?? [];
  let dialogTitle = "";
  let themeTitle = "";
  for (const th of themes) {
    const d = (th.dialogs ?? []).find((x) => String(x.id) === did);
    if (d) {
      dialogTitle = String(d.title ?? "");
      themeTitle = String(th.title ?? "");
      break;
    }
  }

  return {
    threadId: did,
    dialogTitle,
    themeTitle,
    rules: [],
    memoryItems: [],
    summaries: [],
    threadMessages: [],
    turns,
    userQuery: String(userQuery ?? "").slice(0, 2000),
  };
}

export async function bootstrapThemeAndDialog(title) {
  const res = await fetch(apiUrl("api/themes/bootstrap"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Bootstrap ${res.status}`);
  }
  return res.json();
}

export async function renameTheme(themeId, title) {
  const tid = String(themeId ?? "").trim();
  const t = String(title ?? "").trim();
  if (!tid) throw new Error("themeId required");
  if (!t) throw new Error("title required");
  const res = await fetch(apiUrl("api/themes/rename"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ themeId: tid, title: t }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok !== true) {
    throw new Error(data?.error || `Rename theme ${res.status}`);
  }
  return data;
}

export async function deleteTheme(themeId) {
  const tid = String(themeId ?? "").trim();
  if (!tid) throw new Error("themeId required");

  async function parseJson(res) {
    return res.json().catch(() => null);
  }

  function isSuccess(res, data) {
    return Boolean(res.ok && data && data.ok === true);
  }

  /** Old API build without POST /api/themes/delete returns 404 { error: "Not found" }. */
  function shouldTryDeleteFallback(res, data) {
    return res.status === 404 && (!data || data.error === "Not found");
  }

  let res = await fetch(apiUrl("api/themes/delete"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ themeId: tid }),
  });
  let data = await parseJson(res);

  if (!isSuccess(res, data) && shouldTryDeleteFallback(res, data)) {
    res = await fetch(apiUrl(`api/themes/${encodeURIComponent(tid)}`), { method: "DELETE" });
    data = await parseJson(res);
  }

  if (!isSuccess(res, data) && shouldTryDeleteFallback(res, data)) {
    res = await fetch(apiUrl("api/theme-delete"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ themeId: tid }),
    });
    data = await parseJson(res);
  }

  if (!isSuccess(res, data)) {
    const hint =
      res.ok && !data
        ? "Invalid response from server — restart API (npm run dev or pm2 restart mf-lab-api)."
        : null;
    const raw = data?.error || hint || `Delete theme ${res.status}`;
    if (raw === "Not found") {
      throw new Error(
        "API delete route missing or wrong path — restart mf-lab-api. If the app is behind a URL prefix, set API_PATH_PREFIX on the API process (see server log 404 POST delete-theme line).",
      );
    }
    throw new Error(raw);
  }
  return data;
}

export async function createDialogInTheme(themeId, title) {
  const t = String(themeId ?? "").trim();
  if (!t) throw new Error("themeId required");
  const res = await fetch(apiUrl("api/themes/new-dialog"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ themeId: t, title }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Create dialog ${res.status}`);
  }
  const d = await res.json();
  if (!d?.dialog?.id) {
    throw new Error(d?.error || "Create dialog: empty response");
  }
  return d;
}

export async function saveConversationTurn(dialogId, payload) {
  const res = await fetch(apiUrl(`api/dialogs/${encodeURIComponent(dialogId)}/turns`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Save turn ${res.status}`);
  }
  return res.json();
}

/**
 * Favorite assistant reply: markdown snapshot in the DB.
 * @param {string} turnId
 * @param {{ favorite: boolean, markdown?: string }} body
 */
export async function setAssistantTurnFavorite(turnId, body) {
  const tid = String(turnId ?? "").trim();
  if (!tid) throw new Error("turnId required");
  const res = await fetch(apiUrl("api/assistant-favorite"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      turnId: tid,
      favorite: Boolean(body.favorite),
      markdown: body.markdown != null ? String(body.markdown) : "",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) {
    throw new Error(data.error || `Favorite ${res.status}`);
  }
}

export async function fetchAssistantFavorites() {
  const res = await fetch(apiUrl("api/assistant-favorites"));
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Favorites ${res.status}`);
  }
  const data = await res.json();
  return data.favorites ?? [];
}

/** Ensures Intro theme and dialog exist for the Intro section. */
export async function fetchIntroSession() {
  const res = await fetch(apiUrl("api/intro/session"));
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Intro session ${res.status}`);
  }
  const data = await res.json();
  const dialogId = String(data?.dialogId ?? "").trim();
  if (!dialogId) throw new Error("Intro session: empty dialog id");
  return { themeId: String(data?.themeId ?? "").trim(), dialogId };
}

/** Whether a 6-digit Intro PIN is set on the server (Intro stays gated until unlock). */
export async function fetchIntroLockState() {
  const res = await fetch(apiUrl("api/intro/lock"));
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Intro lock ${res.status}`);
  }
  const data = await res.json();
  return { locked: data.locked === true };
}

export async function postIntroLockSet(pin) {
  const res = await fetch(apiUrl("api/intro/lock/set"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: String(pin ?? "") }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) {
    throw new Error(data.error || `Set Intro PIN ${res.status}`);
  }
  return data;
}

export async function postIntroLockUnlock(pin) {
  const res = await fetch(apiUrl("api/intro/lock/unlock"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: String(pin ?? "") }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) {
    throw new Error(data.error || `Unlock Intro ${res.status}`);
  }
  return data;
}

/** Raw memory graph from the DB (category, short label, fact blob, edges). */
export async function fetchMemoryGraphFromApi() {
  const res = await fetch(apiUrl("api/memory-graph"));
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Memory graph ${res.status}`);
  }
  return res.json();
}

/** Aggregated usage stats (excludes Intro / Rules / Access dialogs). */
export async function fetchAnalytics() {
  const res = await fetch(apiUrl("api/analytics"));
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Analytics ${res.status}`);
  }
  return res.json();
}

/**
 * Upserts graph nodes and edges (Intro extraction / ingest result).
 * @param {{ entities?: unknown[], links?: unknown[] }} payload
 */
export async function ingestMemoryGraphPayload(payload) {
  const res = await fetch(apiUrl("api/memory-graph/ingest"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Memory graph ingest ${res.status}`);
  return data;
}
