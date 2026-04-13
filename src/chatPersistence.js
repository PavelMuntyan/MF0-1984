/** Client for /api chat persistence (themes, dialogs, turns). */

/** Respects `import.meta.env.BASE_URL` when the app is not at the site root. */
export function apiUrl(path) {
  const p = String(path ?? "").replace(/^\//, "");
  const base = new URL(import.meta.env.BASE_URL || "/", window.location.origin);
  let href = new URL(p, base).href;
  /* new URL('api/…', '…/api/') can yield …/api/api/… — API then returns 404 Not found */
  while (href.includes("/api/api/")) {
    href = href.replace("/api/api/", "/api/");
  }
  return href;
}

async function readJsonSafe(res) {
  return res.json().catch(() => ({}));
}

function apiErrMessage(body, fallback) {
  if (body && typeof body === "object" && body.error != null) {
    const t = String(body.error).trim();
    if (t) return t;
  }
  return fallback;
}

/** Parse JSON, throw if HTTP not OK (uses server `error` field when present). */
async function assertOkOrThrow(res, failLabel) {
  const data = await readJsonSafe(res);
  if (!res.ok) throw new Error(apiErrMessage(data, `${failLabel} ${res.status}`));
  return data;
}

async function fetchIntroAccessRulesSession(path, label) {
  const res = await fetch(apiUrl(path));
  const data = await readJsonSafe(res);
  if (!res.ok) throw new Error(apiErrMessage(data, `${label} ${res.status}`));
  const dialogId = String(data?.dialogId ?? "").trim();
  if (!dialogId) throw new Error(`${label}: empty dialog id`);
  return { themeId: String(data?.themeId ?? "").trim(), dialogId };
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
  if (m === "accessData") return "access_data";
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
    userAddressingProfile: "",
  };
}

export async function bootstrapThemeAndDialog(title) {
  const res = await fetch(apiUrl("api/themes/bootstrap"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const err = await readJsonSafe(res);
    throw new Error(apiErrMessage(err, `Bootstrap ${res.status}`));
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
    throw new Error(apiErrMessage(data ?? {}, `Rename theme ${res.status}`));
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
    const err = await readJsonSafe(res);
    throw new Error(apiErrMessage(err, `Create dialog ${res.status}`));
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
    const err = await readJsonSafe(res);
    throw new Error(apiErrMessage(err, `Save turn ${res.status}`));
  }
  return res.json();
}

/**
 * Record token usage for background LLM calls (Memory tree router, interest sketch, graph extract/normalize).
 * @param {{ provider_id: string, request_kind: string, llm_prompt_tokens?: number, llm_completion_tokens?: number, llm_total_tokens?: number }} payload
 */
export async function recordAuxLlmUsage(payload) {
  const res = await fetch(apiUrl("api/analytics/aux-llm-usage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await readJsonSafe(res);
    throw new Error(apiErrMessage(err, `Aux LLM usage ${res.status}`));
  }
  const data = await readJsonSafe(res);
  if (data?.ok !== true) {
    throw new Error(apiErrMessage(data, "Aux LLM usage rejected"));
  }
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
    throw new Error(apiErrMessage(data, `Favorite ${res.status}`));
  }
}

export async function fetchAssistantFavorites() {
  const res = await fetch(apiUrl("api/assistant-favorites"));
  if (!res.ok) {
    const err = await readJsonSafe(res);
    throw new Error(apiErrMessage(err, `Favorites ${res.status}`));
  }
  const data = await res.json();
  return data.favorites ?? [];
}

/** Ensures Intro theme and dialog exist for the Intro section. */
export async function fetchIntroSession() {
  return fetchIntroAccessRulesSession("api/intro/session", "Intro session");
}

/** Ensures Access theme and dialog exist for the Access section. */
export async function fetchAccessSession() {
  return fetchIntroAccessRulesSession("api/access/session", "Access session");
}

/** Ensures Rules theme and dialog exist for the Rules section. */
export async function fetchRulesSession() {
  return fetchIntroAccessRulesSession("api/rules/session", "Rules session");
}

/** Saved Rules buckets from `/api/rules/keeper-files` (same shape as merge body). */
export async function fetchRulesKeeperBundle() {
  const res = await fetch(apiUrl("api/rules/keeper-files"));
  const data = await assertOkOrThrow(res, "Rules keeper files");
  const items = (k) => (Array.isArray(data[k]) ? data[k] : []);
  return {
    core_rules: items("core_rules"),
    private_rules: items("private_rules"),
    forbidden_actions: items("forbidden_actions"),
    workflow_rules: items("workflow_rules"),
  };
}

/**
 * @param {{ core_rules?: string[], private_rules?: string[], forbidden_actions?: string[], workflow_rules?: string[] }} patch
 */
export async function mergeRulesKeeperPatch(patch) {
  const res = await fetch(apiUrl("api/rules/keeper-merge"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) {
    throw new Error(apiErrMessage(data, `Rules keeper merge ${res.status}`));
  }
  return { merged_total: Number(data.merged_total) || 0 };
}

/**
 * Intro / Rules / Access: archive usage then delete all turns (and thread mirror rows) for this dialog.
 * @param {string} dialogId
 */
export async function clearDialogTurnsArchive(dialogId) {
  const did = String(dialogId ?? "").trim();
  if (!did) throw new Error("dialog id required");
  const res = await fetch(apiUrl(`api/dialogs/${encodeURIComponent(did)}/clear-turns`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) {
    throw new Error(apiErrMessage(data, `Clear thread ${res.status}`));
  }
  return data;
}

/** Keeper 2 store: third-party APIs / endpoints (not model keys). */
export async function fetchAccessExternalServices() {
  const res = await fetch(apiUrl("api/access/external-services"));
  const data = await assertOkOrThrow(res, "Access external services");
  return { entries: Array.isArray(data.entries) ? data.entries : [] };
}

/**
 * For `#data`: full `entries`, per-row `snapshots`, and `meta` (live GET policy from env allowlist).
 * @returns {Promise<{ ok?: boolean, entries: unknown[], snapshots: unknown[], meta?: { globalHostSuffixRuleCount: number, rowSelfHostnameFetch: boolean, maxLiveFetches: number, entryRowCount: number } }>}
 */
export async function fetchAccessDataDumpEnrichment() {
  const res = await fetch(apiUrl("api/access/data-dump-enrichment"));
  return assertOkOrThrow(res, "Access data-dump enrichment");
}

/**
 * Same services as Access store, **without** `accessKey` — safe to merge into LLM system context.
 * @returns {Promise<{ entries: Array<{ id: string, name: string, description: string, endpointUrl: string }> }>}
 */
export async function fetchAccessExternalServicesCatalog() {
  const res = await fetch(apiUrl("api/access/external-services/catalog"));
  const data = await assertOkOrThrow(res, "Access catalog");
  return { entries: Array.isArray(data.entries) ? data.entries : [] };
}

/** @param {{ entries: unknown[] }} body */
export async function putAccessExternalServices(body) {
  const res = await fetch(apiUrl("api/access/external-services"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? { entries: [] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) {
    throw new Error(apiErrMessage(data, `Access external services PUT ${res.status}`));
  }
  return { entries: Array.isArray(data.entries) ? data.entries : [] };
}

/** @typedef {"intro"|"rules"|"access"} IrPanelId */

/** Lock state for Intro / Rules / Access (each may have its own 6-digit PIN). */
export async function fetchIrPanelLocksAll() {
  const res = await fetch(apiUrl("api/ir-panel-lock"));
  const data = await assertOkOrThrow(res, "IR panel lock");
  return {
    intro: { locked: data.intro?.locked === true },
    rules: { locked: data.rules?.locked === true },
    access: { locked: data.access?.locked === true },
  };
}

/** @param {IrPanelId} panel */
export async function postIrPanelLockSet(panel, pin) {
  const res = await fetch(apiUrl(`api/ir-panel-lock/${encodeURIComponent(panel)}/set`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: String(pin ?? "") }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) {
    throw new Error(apiErrMessage(data, `Set PIN ${res.status}`));
  }
  return data;
}

/** @param {IrPanelId} panel */
export async function postIrPanelLockUnlock(panel, pin) {
  const res = await fetch(apiUrl(`api/ir-panel-lock/${encodeURIComponent(panel)}/unlock`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: String(pin ?? "") }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) {
    throw new Error(apiErrMessage(data, `Unlock PIN ${res.status}`));
  }
  return data;
}

/**
 * Raw memory graph from the DB (category, short label, fact blob, edges).
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function fetchMemoryGraphFromApi(opts = {}) {
  const { signal } = opts;
  const res = await fetch(apiUrl("api/memory-graph"), { signal });
  return assertOkOrThrow(res, "Memory graph");
}

/**
 * Full replace import (JSON or gzip+tar from export). Server wipes existing graph then inserts file data.
 * @param {string | Blob | ArrayBuffer | ArrayBufferView} body
 * @param {string} contentType e.g. `application/json` or `application/gzip`
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ nodesImported: number, edgesImported: number }>}
 */
/**
 * @param {string} archivePassphraseHex 64 hex chars (SHA256(SHA384(utf8 password)) chain)
 * @param {Record<string, unknown>} aiModelsSnapshot
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<Blob>}
 */
/**
 * @param {ArrayBuffer | ArrayBufferView} buffer
 * @param {string} archivePassphraseHex
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function importProjectProfileMf(buffer, archivePassphraseHex, opts = {}) {
  const { signal } = opts;
  const body =
    buffer instanceof ArrayBuffer
      ? buffer
      : new Uint8Array(
          /** @type {ArrayBuffer} */ (buffer.buffer),
          buffer.byteOffset,
          buffer.byteLength,
        );
  const res = await fetch(apiUrl("api/project-profile/import"), {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Mf0-Archive-Passphrase-Hex": String(archivePassphraseHex ?? "")
        .trim()
        .toLowerCase(),
    },
    body,
    signal,
  });
  const data = await readJsonSafe(res);
  if (res.status === 401 && data.error === "WRONG_ARCHIVE_PASSWORD") {
    const err = new Error("WRONG_ARCHIVE_PASSWORD");
    throw err;
  }
  if (!res.ok || data.ok !== true) {
    throw new Error(apiErrMessage(data, `Project profile import ${res.status}`));
  }
  return data;
}

export async function exportProjectProfileMf(archivePassphraseHex, aiModelsSnapshot, opts = {}) {
  const { signal } = opts;
  const res = await fetch(apiUrl("api/project-profile/export"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      archivePassphraseHex: String(archivePassphraseHex ?? "").trim().toLowerCase(),
      aiModelsSnapshot: aiModelsSnapshot && typeof aiModelsSnapshot === "object" ? aiModelsSnapshot : { keys: {} },
    }),
    signal,
  });
  if (!res.ok) {
    const data = await readJsonSafe(res);
    throw new Error(apiErrMessage(data, `Project profile export ${res.status}`));
  }
  return res.blob();
}

export async function importMemoryGraphReplace(body, contentType, opts = {}) {
  const { signal } = opts;
  const res = await fetch(apiUrl("api/memory-graph/import"), {
    method: "POST",
    headers: { "Content-Type": String(contentType || "application/octet-stream") },
    body,
    signal,
  });
  const data = await readJsonSafe(res);
  if (!res.ok || data.ok !== true) {
    throw new Error(apiErrMessage(data, `Memory graph import ${res.status}`));
  }
  return {
    nodesImported: Number(data.nodesImported) || 0,
    edgesImported: Number(data.edgesImported) || 0,
  };
}

/** Aggregated usage stats: live regular chats plus archived rows from cleared IR threads and deleted themes. */
export async function fetchAnalytics() {
  const res = await fetch(apiUrl("api/analytics"));
  return assertOkOrThrow(res, "Analytics");
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
  if (!res.ok) throw new Error(apiErrMessage(data, `Memory graph ingest ${res.status}`));
  return data;
}
