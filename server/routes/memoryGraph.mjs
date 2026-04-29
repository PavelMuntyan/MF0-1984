import { Router, raw as expressRaw } from "express";
import { db } from "../db/migrations.mjs";
import { MAX_BODY_BYTES } from "../config.mjs";
import {
  normalizeMemoryGraphCategory,
  normGraphLabel,
  ensureMemoryGraphHubAnchorsPresent,
  getMemoryGraphPayload,
  ingestMemoryGraphFromBody,
} from "../db/memoryGraph.mjs";
import { decodeImportBodyFromBuffer, normalizeImportPayload, replaceMemoryGraphInDatabase } from "../memoryGraphImport.mjs";

const router = Router();
const BODY_LIMIT = MAX_BODY_BYTES;

router.get("/memory-graph", async (_req, res) => {
  res.json(await getMemoryGraphPayload());
});

router.post(
  "/memory-graph/import",
  expressRaw({ type: ["application/gzip", "application/x-gzip", "application/octet-stream"], limit: BODY_LIMIT }),
  async (req, res) => {
    const ct = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    try {
      let parsed;
      if (ct === "application/json" || ct === "text/json") {
        parsed = req.body && typeof req.body === "object" ? req.body : JSON.parse(String(req.body ?? "{}"));
      } else if (["application/gzip", "application/x-gzip", "application/octet-stream"].includes(ct)) {
        parsed = decodeImportBodyFromBuffer(req.body);
      } else {
        return res.status(415).json({ ok: false, error: "Content-Type must be application/json, application/gzip, or application/octet-stream." });
      }
      const payload = normalizeImportPayload(parsed, normalizeMemoryGraphCategory, normGraphLabel);
      const counts = replaceMemoryGraphInDatabase(db, payload, () => { void ensureMemoryGraphHubAnchorsPresent(); });
      res.json({ ok: true, ...counts });
    } catch (e) {
      const status = e?.type === "entity.too.large" ? 413 : 400;
      res.status(status).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
);

router.post("/memory-graph/ingest", async (req, res) => {
  const body = req.body ?? {};
  try {
    const out = await ingestMemoryGraphFromBody(body);
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
