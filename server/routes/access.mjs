import { Router } from "express";
import { db } from "../db/migrations.mjs";
import { replaceAccessExternalServicesInDatabase } from "../accessExternalServicesDb.mjs";
import { buildAccessDataDumpEnrichmentFromEntries } from "../accessDataDump.mjs";
import { readAccessDataDumpEnrichmentImportCacheIfPresent, clearAccessDataDumpEnrichmentImportCache } from "../accessDataDumpImportCache.mjs";
import { readAccessExternalServicesPayload } from "../services/accessServices.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");

const router = Router();

async function getAccessDataDumpEnrichmentPayload() {
  const cached = readAccessDataDumpEnrichmentImportCacheIfPresent(root);
  if (cached) return cached;
  const { entries } = readAccessExternalServicesPayload();
  return buildAccessDataDumpEnrichmentFromEntries(entries);
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
