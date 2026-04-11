/**
 * #data / Access data: optional live JSON GET for each row’s `endpointUrl`.
 * - **Always:** host must be the same as that row’s URL hostname **or** match optional global suffix rules (env).
 * - **Optional:** `ACCESS_DATA_DUMP_ALLOW_HOST_SUFFIXES` — comma-separated host suffixes (e.g. CDN parents) in addition to self-host.
 * No per-vendor URLs are hardcoded in code.
 */
export function getAccessDataDumpAllowHostSuffixes() {
  const raw = String(process.env.ACCESS_DATA_DUMP_ALLOW_HOST_SUFFIXES ?? "").trim();
  if (!raw) return [];
  return raw
    .split(/[,;]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\.+/, ""))
    .filter((s) => s.length > 1 && /^[a-z0-9.-]+$/.test(s));
}

/** Hostname from this row’s stored URL (lowercase), or empty if invalid. */
export function rowEndpointHostname(entry) {
  try {
    return new URL(String(entry?.endpointUrl ?? "").trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Live GET allowed for this row if public HTTPS host matches **this row’s** endpoint hostname,
 * or matches any configured global suffix (parent/CDN domains).
 * @param {string} hostname
 * @param {{ endpointUrl?: string }} entry
 */
export function hostnameAllowedForDataDumpRow(hostname, entry) {
  const h = String(hostname ?? "").toLowerCase();
  const self = rowEndpointHostname(entry);
  if (self && h === self) return true;
  const host = h.replace(/\.$/, "");
  for (const suf of getAccessDataDumpAllowHostSuffixes()) {
    if (host === suf || host.endsWith("." + suf)) return true;
  }
  return false;
}

export function isSafePublicHttpsUrlForDataDump(urlStr) {
  try {
    const u = new URL(String(urlStr ?? "").trim());
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (!h || h === "localhost" || h === "[::1]") return false;
    if (h.endsWith(".local")) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(h)) return false;
    const ipv4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4) {
      const a = Number(ipv4[1]);
      const b = Number(ipv4[2]);
      if (a === 0 || a === 127) return false;
      if (a === 10) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Generic JSON trim for LLM context (no product-specific field lists).
 * @param {unknown} value
 * @param {number} depth
 * @param {WeakSet<object>} seen
 */
export function genericPruneJsonForDataDump(value, depth = 0, seen = new WeakSet()) {
  const maxDepth = 7;
  const maxStr = 1800;
  const maxKeys = 72;
  const maxArr = 48;
  if (depth > maxDepth) return "[truncated-depth]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length > maxStr ? `${value.slice(0, maxStr)}…` : value;
  }
  if (typeof value !== "object") return value;
  if (seen.has(/** @type {object} */ (value))) return "[circular]";
  seen.add(/** @type {object} */ (value));
  if (Array.isArray(value)) {
    const out = value.slice(0, maxArr).map((x) => genericPruneJsonForDataDump(x, depth + 1, seen));
    if (value.length > maxArr) out.push(`[…+${value.length - maxArr} items]`);
    return out;
  }
  const o = /** @type {Record<string, unknown>} */ ({});
  const keys = Object.keys(value).slice(0, maxKeys);
  for (const k of keys) {
    o[k] = genericPruneJsonForDataDump(value[k], depth + 1, seen);
  }
  if (Object.keys(value).length > maxKeys) o._truncatedKeys = true;
  return o;
}

/**
 * @param {{ id?: string, name?: string, endpointUrl?: string }} entry
 */
export async function fetchSafeAllowlistedJsonSnapshotForEntry(entry) {
  const url = String(entry?.endpointUrl ?? "").trim();
  if (!url) return { skipped: true, reason: "no endpointUrl" };
  if (!isSafePublicHttpsUrlForDataDump(url)) {
    return { skipped: true, reason: "only public HTTPS URLs (non-loopback) are allowed" };
  }
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return { skipped: true, reason: "invalid URL" };
  }
  if (!hostnameAllowedForDataDumpRow(hostname, entry)) {
    return {
      skipped: true,
      reason:
        "hostname does not match this row’s endpointUrl host and does not match ACCESS_DATA_DUMP_ALLOW_HOST_SUFFIXES",
    };
  }
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 9000);
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "MF0-1984-local-api/data-dump",
      },
    });
    clearTimeout(tid);
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, error: text.slice(0, 500) };
    }
    if (text.length > 1_200_000) {
      return { ok: false, error: "response body too large" };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, httpStatus: res.status, error: "non-JSON body", snippet: text.slice(0, 400) };
    }
    const pruned = genericPruneJsonForDataDump(parsed);
    return {
      ok: true,
      httpStatus: res.status,
      fetchedAt: new Date().toISOString(),
      body: pruned,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function getAccessDataDumpMaxLiveFetches() {
  const raw = process.env.ACCESS_DATA_DUMP_MAX_LIVE_FETCHES;
  if (raw === undefined || raw === null || String(raw).trim() === "") return 48;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) return 48;
  return n;
}

/**
 * Prefer likely air-quality rows first so a small fetch budget still hits relevant JSON APIs.
 * @param {Array<{ name?: string, endpointUrl?: string }>} list
 */
export function sortEntriesForDataDumpFetchPriority(list) {
  /** @param {{ name?: string, endpointUrl?: string }} e */
  const score = (e) => {
    const u = String(e?.endpointUrl ?? "").toLowerCase();
    const n = String(e?.name ?? "").toLowerCase();
    const h = `${u} ${n}`;
    let p = 0;
    if (/air-quality|airquality|aqi|pm2|pm10|pollution|smog/i.test(h)) p += 8;
    if (/marine|wave|sea state|ocean/i.test(h)) p += 2;
    if (/forecast|current_weather|weather/i.test(h)) p += 1;
    return p;
  };
  return [...list].sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    return String(a?.name ?? "").localeCompare(String(b?.name ?? ""), "und", { sensitivity: "base" });
  });
}

/**
 * @param {Array<{ id?: string, name?: string, endpointUrl?: string }>} entriesRaw
 */
export async function buildAccessDataDumpEnrichmentFromEntries(entriesRaw) {
  const entries = sortEntriesForDataDumpFetchPriority(entriesRaw);
  /** @type {unknown[]} */
  const snapshots = [];
  let fetchCount = 0;
  const suffixes = getAccessDataDumpAllowHostSuffixes();
  const maxFetches = getAccessDataDumpMaxLiveFetches();
  for (const e of entries) {
    const url = String(e?.endpointUrl ?? "").trim();
    if (!url) {
      snapshots.push({
        entryId: e.id,
        entryName: e.name,
        skipped: true,
        reason: "no endpointUrl",
      });
      continue;
    }
    if (!isSafePublicHttpsUrlForDataDump(url)) {
      snapshots.push({
        entryId: e.id,
        entryName: e.name,
        endpointUrl: url,
        skipped: true,
        reason: "only public HTTPS URLs are considered for live fetch",
      });
      continue;
    }
    let hostname = "";
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      snapshots.push({
        entryId: e.id,
        entryName: e.name,
        endpointUrl: url,
        skipped: true,
        reason: "invalid URL",
      });
      continue;
    }
    if (!hostnameAllowedForDataDumpRow(hostname, e)) {
      snapshots.push({
        entryId: e.id,
        entryName: e.name,
        endpointUrl: url,
        skipped: true,
        reason:
          "hostname not allowed for live fetch (must match this row’s endpointUrl host, or a suffix from ACCESS_DATA_DUMP_ALLOW_HOST_SUFFIXES)",
      });
      continue;
    }
    if (fetchCount >= maxFetches) {
      snapshots.push({
        entryId: e.id,
        entryName: e.name,
        endpointUrl: url,
        skipped: true,
        reason: `not fetched this round — server snapshot budget (${maxFetches} GETs per request; set ACCESS_DATA_DUMP_MAX_LIVE_FETCHES up to 120 to raise)`,
      });
      continue;
    }
    fetchCount += 1;
    const snap = await fetchSafeAllowlistedJsonSnapshotForEntry(e);
    snapshots.push({
      entryId: e.id,
      entryName: e.name,
      endpointUrl: url,
      ...snap,
    });
  }
  return {
    ok: true,
    entries,
    snapshots,
    meta: {
      globalHostSuffixRuleCount: suffixes.length,
      rowSelfHostnameFetch: true,
      maxLiveFetches: maxFetches,
      entryRowCount: entries.length,
    },
  };
}
