import { Router, raw as expressRaw } from "express";
import { db } from "../db/migrations.mjs";
import { MAX_BODY_BYTES } from "../config.mjs";
import { normalizeMemoryGraphCategory, normGraphLabel, ensureMemoryGraphHubAnchorsPresent, getMemoryGraphPayload } from "../db/memoryGraph.mjs";
import { buildProjectProfileMf7zBuffer, projectProfileMfFilename } from "../projectProfileExport.mjs";
import { importProjectProfileFromMfBuffer } from "../projectProfileImport.mjs";
import { buildAccessDataDumpEnrichmentFromEntries } from "../accessDataDump.mjs";
import { readAccessDataDumpEnrichmentImportCacheIfPresent } from "../accessDataDumpImportCache.mjs";
import { readAccessExternalServicesPayload } from "../services/accessServices.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");

const router = Router();

router.post("/project-profile/export", async (req, res) => {
  const body = req.body ?? {};
  const hex = String(body.archivePassphraseHex ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return res.status(400).json({ ok: false, error: "Invalid archive passphrase encoding." });
  const snap = body.aiModelsSnapshot;
  if (!snap || typeof snap !== "object") return res.status(400).json({ ok: false, error: "aiModelsSnapshot object is required." });
  try {
    await ensureMemoryGraphHubAnchorsPresent();
    const memoryGraph = await getMemoryGraphPayload();
    const accessExternal = readAccessExternalServicesPayload();
    let accessEnrichment = {};
    try {
      accessEnrichment = readAccessDataDumpEnrichmentImportCacheIfPresent(root)
        ?? await buildAccessDataDumpEnrichmentFromEntries(accessExternal.entries);
    } catch {
      accessEnrichment = { ok: false, error: "enrichment_unavailable" };
    }
    const buf = await buildProjectProfileMf7zBuffer({
      database: db, projectRoot: root, archivePassphraseHex: hex,
      aiModelsSnapshot: snap, memoryGraph, accessExternal, accessEnrichment,
    });
    const fn = projectProfileMfFilename();
    res.set({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fn}"`,
      "Content-Length": String(buf.length),
    });
    res.end(buf);
  } catch (e) {
    console.error("[mf-lab-api] project-profile/export:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

router.post(
  "/project-profile/import",
  expressRaw({ type: "*/*", limit: MAX_BODY_BYTES }),
  async (req, res) => {
    const hex = String(req.headers["x-mf0-archive-passphrase-hex"] ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) return res.status(400).json({ ok: false, error: "Invalid archive passphrase encoding." });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 64) {
      return res.status(400).json({ ok: false, error: "Request body is too small to be a profile archive." });
    }
    try {
      const out = await importProjectProfileFromMfBuffer({
        projectRoot: root, database: db, buffer: buf, archivePassphraseHex: hex,
        normalizeCategory: normalizeMemoryGraphCategory, normLabel: normGraphLabel,
        ensureMemoryGraphHubAnchorsPresent: () => { void ensureMemoryGraphHubAnchorsPresent(); },
      });
      res.json({ ok: true, ...out });
    } catch (e) {
      const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
      const msg = e instanceof Error ? e.message : String(e);
      if (code === "WRONG_ARCHIVE_PASSWORD" || msg === "WRONG_ARCHIVE_PASSWORD") {
        return res.status(401).json({ ok: false, error: "WRONG_ARCHIVE_PASSWORD" });
      }
      console.error("[mf-lab-api] project-profile/import:", e);
      res.status(400).json({ ok: false, error: msg });
    }
  },
);

export default router;
