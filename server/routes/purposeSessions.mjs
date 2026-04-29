import crypto from "node:crypto";
import { Router } from "express";
import { db } from "../db/migrations.mjs";
import { readRulesKeeperBundlePayload, mergeRulesKeeperPatchFromBody } from "../services/rulesKeeper.mjs";

const router = Router();

function getOrCreatePurposeSession(purpose, spec) {
  const row = db.prepare(
    `SELECT d.id AS dialog_id, d.theme_id FROM dialogs d WHERE d.purpose = ? LIMIT 1`,
  ).get(purpose);
  if (row) return { themeId: row.theme_id, dialogId: row.dialog_id };
  const themeId = crypto.randomUUID();
  const dialogId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO themes (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(themeId, spec.themeTitle, now, now);
    db.prepare(`INSERT INTO dialogs (id, theme_id, title, created_at, updated_at, purpose) VALUES (?, ?, ?, ?, ?, ?)`).run(dialogId, themeId, spec.dialogTitle, now, now, purpose);
  })();
  return { themeId, dialogId };
}

router.get("/intro/session", (_req, res) => {
  const s = getOrCreatePurposeSession("intro", { themeTitle: "Intro", dialogTitle: "Self profile" });
  res.json({ ok: true, themeId: s.themeId, dialogId: s.dialogId });
});

router.get("/access/session", (_req, res) => {
  const s = getOrCreatePurposeSession("access", { themeTitle: "Access", dialogTitle: "External services" });
  res.json({ ok: true, themeId: s.themeId, dialogId: s.dialogId });
});

router.get("/rules/session", (_req, res) => {
  const s = getOrCreatePurposeSession("rules", { themeTitle: "Rules", dialogTitle: "Project rules" });
  res.json({ ok: true, themeId: s.themeId, dialogId: s.dialogId });
});

router.get("/rules/keeper-files", (_req, res) => {
  try {
    const bundle = readRulesKeeperBundlePayload();
    res.json({ ok: true, ...bundle });
  } catch (e) {
    console.error("[mf-lab-api] rules/keeper-files:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

router.put("/rules/keeper-merge", async (req, res) => {
  const body = req.body ?? {};
  const out = mergeRulesKeeperPatchFromBody(body);
  if ("error" in out) return res.status(out.status).json({ ok: false, error: out.error });
  res.json({ ok: true, merged_total: out.merged_total });
});

export default router;
