/**
 * Optional on-disk snapshot for #data / Access data-dump enrichment.
 * Written after a successful project-profile import from `.mf`; cleared when Access external services are replaced via API.
 */

import fs from "node:fs";
import path from "node:path";

export const ACCESS_DATA_DUMP_ENRICHMENT_IMPORT_CACHE = "mf0-access-data-dump-enrichment-import.json";

/**
 * @param {string} projectRoot
 * @returns {string}
 */
function cachePath(projectRoot) {
  return path.join(projectRoot, "data", ACCESS_DATA_DUMP_ENRICHMENT_IMPORT_CACHE);
}

/**
 * @param {unknown} v
 * @returns {{ ok: true, entries: unknown[], snapshots: unknown[], meta: Record<string, unknown> } | null}
 */
function normalizeEnrichmentBody(v) {
  if (!v || typeof v !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (v);
  const inner = o.data && typeof o.data === "object" ? /** @type {Record<string, unknown>} */ (o.data) : o;
  const entries = inner.entries;
  const snapshots = inner.snapshots;
  if (!Array.isArray(entries) || !Array.isArray(snapshots)) return null;
  const meta =
    inner.meta && typeof inner.meta === "object"
      ? /** @type {Record<string, unknown>} */ (inner.meta)
      : {
          globalHostSuffixRuleCount: 0,
          rowSelfHostnameFetch: true,
          maxLiveFetches: 0,
          entryRowCount: entries.length,
        };
  return { ok: true, entries, snapshots, meta };
}

/**
 * @param {string} projectRoot
 * @returns {{ ok: true, entries: unknown[], snapshots: unknown[], meta: Record<string, unknown> } | null}
 */
export function readAccessDataDumpEnrichmentImportCacheIfPresent(projectRoot) {
  const fp = cachePath(projectRoot);
  if (!fs.existsSync(fp)) return null;
  let raw;
  try {
    raw = fs.readFileSync(fp, "utf8");
  } catch {
    return null;
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  return normalizeEnrichmentBody(j);
}

/**
 * Persists enrichment from an imported `mf0_access_data_dump_enrichment_for_db.json` (or its inner `data` object).
 * @param {string} projectRoot
 * @param {unknown} filePayload parsed JSON from archive
 */
export function writeAccessDataDumpEnrichmentImportFromArchivedPayload(projectRoot, filePayload) {
  const normalized = normalizeEnrichmentBody(filePayload);
  if (!normalized) {
    throw new Error("Invalid Access data-dump enrichment payload (need entries and snapshots arrays).");
  }
  const fp = cachePath(projectRoot);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const wrapper = {
    schema: "mf0.access_data_dump_enrichment_import.v1",
    restoredAt: new Date().toISOString(),
    data: normalized,
  };
  fs.writeFileSync(fp, `${JSON.stringify(wrapper, null, 2)}\n`, "utf8");
}

/**
 * @param {string} projectRoot
 */
export function clearAccessDataDumpEnrichmentImportCache(projectRoot) {
  const fp = cachePath(projectRoot);
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {
    /* ignore */
  }
}
