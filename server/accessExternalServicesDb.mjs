/**
 * Shared Access external-services row sanitization + full replace (used by API and project-profile import).
 */

import crypto from "node:crypto";

export const ACCESS_ENTRY_NOTES_MAX = 12000;

/**
 * @param {unknown[]} entries
 * @returns {Array<{ id: string, name: string, description: string, endpointUrl: string, accessKey: string, notes: string, updatedAt: string }>}
 */
export function sanitizeAccessExternalEntries(entries) {
  const now = new Date().toISOString();
  /** @type {Array<{ id: string, name: string, description: string, endpointUrl: string, accessKey: string, notes: string, updatedAt: string }>} */
  const out = [];
  const arr = Array.isArray(entries) ? entries : [];
  for (const e of arr.slice(0, 200)) {
    if (!e || typeof e !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (e);
    const id = String(o.id ?? "").trim() || crypto.randomUUID();
    const name = String(o.name ?? "").trim().slice(0, 200);
    if (!name) continue;
    out.push({
      id,
      name,
      description: String(o.description ?? "").trim().slice(0, 2000),
      endpointUrl: String(o.endpointUrl ?? o.endpoint_or_url ?? "").trim().slice(0, 2000),
      accessKey: String(o.accessKey ?? o.access_key ?? "").trim().slice(0, 2000),
      notes: String(o.notes ?? "").trim().slice(0, ACCESS_ENTRY_NOTES_MAX),
      updatedAt: String(o.updatedAt ?? o.updated_at ?? now).slice(0, 40),
    });
  }
  return out;
}

/**
 * @param {import("better-sqlite3").Database} database
 * @param {unknown[]} entriesRaw
 */
export function replaceAccessExternalServicesInDatabase(database, entriesRaw) {
  const entries = sanitizeAccessExternalEntries(entriesRaw);
  const del = database.prepare(`DELETE FROM access_external_services`);
  const ins = database.prepare(
    `INSERT INTO access_external_services (id, name, description, endpoint_url, access_key, notes, updated_at)
     VALUES (@id, @name, @description, @endpointUrl, @accessKey, @notes, @updatedAt)`,
  );
  const tx = database.transaction((rows) => {
    del.run();
    for (const e of rows) {
      ins.run({
        id: e.id,
        name: e.name,
        description: e.description,
        endpointUrl: e.endpointUrl,
        accessKey: e.accessKey,
        notes: e.notes,
        updatedAt: e.updatedAt,
      });
    }
  });
  tx(entries);
  return entries.length;
}
