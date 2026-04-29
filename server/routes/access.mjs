import { Router } from "express";
import { db } from "../db/migrations.mjs";
import { sanitizeAccessExternalEntries, replaceAccessExternalServicesInDatabase } from "../accessExternalServicesDb.mjs";
import { buildAccessDataDumpEnrichmentFromEntries } from "../accessDataDump.mjs";
import { readAccessDataDumpEnrichmentImportCacheIfPresent, clearAccessDataDumpEnrichmentImportCache } from "../accessDataDumpImportCache.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");

const router = Router();

function readAccessExternalServicesPayload() {
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

async function getAccessDataDumpEnrichmentPayload() {
  const cached = readAccessDataDumpEnrichmentImportCacheIfPresent(root);
  if (cached) return cached;
  const { entries: entriesRaw } = readAccessExternalServicesPayload();
  return buildAccessDataDumpEnrichmentFromEntries(entriesRaw);
}

router.get("/access/external-services", (_req, res) => {
  res.json({ ok: true, ...readAccessExternalServicesPayload() });
});

router.get("/access/external-services/catalog", (_req, res) => {
  const { entries } = readAccessExternalServicesPayload();
  res.json({
    ok: true,
    entries: entries.map((e) => ({ id: e.id, name: e.name, description: e.description, endpointUrl: e.endpointUrl })),
  });
});

router.get("/access/data-dump-enrichment", async (_req, res) => {
  try {
    const out = await getAccessDataDumpEnrichmentPayload();
    res.json(out);
  } catch (e) {
    console.error("[mf-lab-api] data-dump-enrichment:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

router.put("/access/external-services", (req, res) => {
  const body = req.body ?? {};
  replaceAccessExternalServicesInDatabase(db, body.entries);
  clearAccessDataDumpEnrichmentImportCache(root);
  res.json({ ok: true, ...readAccessExternalServicesPayload() });
});

export default router;
