import { db } from "../db/migrations.mjs";
import { sanitizeAccessExternalEntries } from "../accessExternalServicesDb.mjs";

export function readAccessExternalServicesPayload() {
  const rows = db.prepare(
    `SELECT id, name, description, endpoint_url AS endpointUrl, access_key AS accessKey, notes, updated_at AS updatedAt
     FROM access_external_services ORDER BY name COLLATE NOCASE`,
  ).all();
  const entries = (rows ?? []).map((r) => ({
    id: String(r.id ?? "").trim(),
    name: String(r.name ?? "").trim(),
    description: String(r.description ?? "").trim(),
    endpointUrl: String(r.endpointUrl ?? "").trim(),
    accessKey: String(r.accessKey ?? "").trim(),
    notes: String(r.notes ?? "").trim(),
    updatedAt: String(r.updatedAt ?? "").trim(),
  }));
  return { entries: sanitizeAccessExternalEntries(entries) };
}
