import crypto from "node:crypto";
import { Router } from "express";
import { db } from "../db/migrations.mjs";

const router = Router();

/** SHA256(hex of MD5(6-digit PIN)) — verify by recomputing; PIN is not stored. */
function doubleHashIrPanelPin6(pin) {
  const raw = String(pin ?? "").replace(/\D/g, "");
  if (!/^[0-9]{6}$/.test(raw)) return null;
  const md5hex = crypto.createHash("md5").update(raw, "utf8").digest("hex");
  return crypto.createHash("sha256").update(md5hex, "utf8").digest("hex");
}

function getIrPanelLocksPayload() {
  const rows = db.prepare(`SELECT panel FROM ir_panel_pin_lock`).all();
  const set = new Set(rows.map((r) => String(r.panel)));
  return {
    intro: { locked: set.has("intro") },
    rules: { locked: set.has("rules") },
    access: { locked: set.has("access") },
  };
}

router.get("/ir-panel-lock", (_req, res) => {
  res.json({ ok: true, ...getIrPanelLocksPayload() });
});

router.post("/ir-panel-lock/:panel/set", (req, res) => {
  const panel = req.params.panel;
  if (!["intro", "rules", "access"].includes(panel)) return res.status(404).json({ ok: false, error: "Not found" });
  const body = req.body ?? {};
  const h = doubleHashIrPanelPin6(body.pin ?? body.PIN);
  if (!h) return res.status(400).json({ ok: false, error: "PIN must be exactly 6 digits." });
  db.prepare(
    `INSERT INTO ir_panel_pin_lock (panel, pin_double_hash) VALUES (?, ?) ON CONFLICT(panel) DO UPDATE SET pin_double_hash = excluded.pin_double_hash`,
  ).run(panel, h);
  res.json({ ok: true, panel, locked: true });
});

router.post("/ir-panel-lock/:panel/unlock", (req, res) => {
  const panel = req.params.panel;
  if (!["intro", "rules", "access"].includes(panel)) return res.status(404).json({ ok: false, error: "Not found" });
  const body = req.body ?? {};
  const h = doubleHashIrPanelPin6(body.pin ?? body.PIN);
  if (!h) return res.status(400).json({ ok: false, error: "PIN must be exactly 6 digits." });
  const row = db.prepare(`SELECT pin_double_hash FROM ir_panel_pin_lock WHERE panel = ?`).get(panel);
  if (!row?.pin_double_hash) {
    const label = panel === "intro" ? "Intro" : panel === "rules" ? "Rules" : "Access";
    return res.status(400).json({ ok: false, error: `${label} is not locked.` });
  }
  if (row.pin_double_hash !== h) return res.status(403).json({ ok: false, error: "Incorrect PIN." });
  db.prepare(`DELETE FROM ir_panel_pin_lock WHERE panel = ?`).run(panel);
  res.json({ ok: true, panel, locked: false });
});

export default router;
