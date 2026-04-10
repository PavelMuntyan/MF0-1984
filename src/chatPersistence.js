/** Client for /api chat persistence (themes, dialogs, turns). */

/** Учитывает `import.meta.env.BASE_URL` (приложение не в корне сайта). */
function apiUrl(path) {
  const p = String(path ?? "").replace(/^\//, "");
  const base = new URL(import.meta.env.BASE_URL || "/", window.location.origin);
  return new URL(p, base).href;
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
  if (m === "files") return "files";
  return "default";
}

export async function apiHealth() {
  const res = await fetch(apiUrl("api/health"));
  if (!res.ok) return false;
  const data = await res.json().catch(() => ({}));
  /** Отсекаем чужой сервис на том же пути (например, не наш ответ без метки). */
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
 * Пакет для сборки контекста LLM (тред = dialog id).
 * Сначала пробует GET /context-pack (rules, memory, summaries, thread_messages).
 * Если 404/старый API — собирает из уже существующих /turns и /themes, чтобы история диалога всё равно уходила в модель.
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

export async function deleteTheme(themeId) {
  const tid = String(themeId ?? "").trim();
  if (!tid) throw new Error("themeId required");

  async function parseJson(res) {
    return res.json().catch(() => null);
  }

  function isSuccess(res, data) {
    return Boolean(res.ok && data && data.ok === true);
  }

  /** Старый процесс API без POST /api/themes/delete отдаёт 404 { error: «Not found» }. */
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
