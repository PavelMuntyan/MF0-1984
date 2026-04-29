import { Router } from "express";
import { readAiModelListsCachePayload, writeAiModelListsCachePayload } from "../services/aiModelCache.mjs";
import { getProjectCacheStatsPayload, clearProjectMultimediaCacheFull } from "../services/projectCache.mjs";

const router = Router();

router.get("/settings/ai-model-lists-cache", (_req, res) => {
  res.json({ ok: true, cache: readAiModelListsCachePayload() });
});

router.put("/settings/ai-model-lists-cache", (req, res) => {
  const body = req.body ?? {};
  try {
    const cache = writeAiModelListsCachePayload(body);
    res.json({ ok: true, cache });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

router.get("/settings/project-cache-stats", (_req, res) => {
  res.json(getProjectCacheStatsPayload());
});

router.post("/settings/project-cache-clear-multimedia", (_req, res) => {
  try {
    const out = clearProjectMultimediaCacheFull();
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
