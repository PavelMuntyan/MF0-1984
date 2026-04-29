import crypto from "node:crypto";
import { Router } from "express";
import { db } from "../db/migrations.mjs";
import {
  ANALYTICS_PROVIDER_IDS,
  AUX_LLM_USAGE_KINDS,
  normalizeAuxAnalyticsProviderId,
  estimateProviderUsd,
  analyticsProcessLabelForTurnRequestType,
  analyticsProcessLabelForAuxKind,
  getAnalyticsPayload,
} from "../db/analytics.mjs";

const router = Router();

router.get("/analytics", async (_req, res) => {
  res.json({ ok: true, ...(await getAnalyticsPayload()) });
});

router.get("/analytics/turn-costs/:turnId", (req, res) => {
  const turnId = req.params.turnId.trim();
  if (!turnId) return res.status(400).json({ ok: false, error: "turnId is required" });
  const turn = db.prepare(
    `SELECT id, dialog_id, request_type, requested_provider_id, responding_provider_id,
            llm_prompt_tokens, llm_completion_tokens, llm_total_tokens, user_message_at, assistant_message_at
     FROM conversation_turns WHERE id = ?`,
  ).get(turnId);
  if (!turn) return res.status(404).json({ ok: false, error: "Turn not found" });

  const userAt = String(turn.user_message_at ?? "").trim();
  const assistantAt = String(turn.assistant_message_at ?? "").trim();
  const pid = String(turn.responding_provider_id ?? turn.requested_provider_id ?? "").trim().toLowerCase();
  const promptTok = Math.max(0, Number(turn.llm_prompt_tokens) || 0);
  const completionTok = Math.max(0, Number(turn.llm_completion_tokens) || 0);
  const totalTok = Math.max(0, Number(turn.llm_total_tokens) || 0) || Math.max(0, promptTok + completionTok);
  const turnUsd = estimateProviderUsd(pid, promptTok, completionTok);

  const rows = [];
  if (promptTok > 0 || completionTok > 0 || totalTok > 0) {
    rows.push({
      process: analyticsProcessLabelForTurnRequestType(String(turn.request_type ?? "")),
      provider_id: pid, model: pid,
      llm_prompt_tokens: promptTok, llm_completion_tokens: completionTok, llm_total_tokens: totalTok,
      cost_usd: turnUsd.totalUsd, source: "turn", occurred_at: assistantAt || userAt || "",
    });
  }

  const auxRows = db.prepare(
    `SELECT created_at, provider_id, request_kind, llm_prompt_tokens, llm_completion_tokens, llm_total_tokens
     FROM analytics_aux_llm_usage WHERE conversation_turn_id = ? ORDER BY DATETIME(created_at) ASC`,
  ).all(turnId);
  for (const r of auxRows) {
    const apid = String(r.provider_id ?? "").trim().toLowerCase();
    const pp = Math.max(0, Number(r.llm_prompt_tokens) || 0);
    const pc = Math.max(0, Number(r.llm_completion_tokens) || 0);
    const pt = Math.max(0, Number(r.llm_total_tokens) || 0) || Math.max(0, pp + pc);
    rows.push({
      process: analyticsProcessLabelForAuxKind(String(r.request_kind ?? "")),
      provider_id: apid, model: apid,
      llm_prompt_tokens: pp, llm_completion_tokens: pc, llm_total_tokens: pt,
      cost_usd: estimateProviderUsd(apid, pp, pc).totalUsd, source: "aux",
      occurred_at: String(r.created_at ?? ""),
    });
  }

  const totals = rows.reduce(
    (a, r) => ({
      llm_prompt_tokens: a.llm_prompt_tokens + (Number(r.llm_prompt_tokens) || 0),
      llm_completion_tokens: a.llm_completion_tokens + (Number(r.llm_completion_tokens) || 0),
      llm_total_tokens: a.llm_total_tokens + (Number(r.llm_total_tokens) || 0),
      cost_usd: a.cost_usd + (Number(r.cost_usd) || 0),
    }),
    { llm_prompt_tokens: 0, llm_completion_tokens: 0, llm_total_tokens: 0, cost_usd: 0 },
  );

  res.json({
    ok: true, noAttributedUsage: rows.length === 0,
    turn: { id: String(turn.id ?? ""), dialog_id: String(turn.dialog_id ?? ""), user_message_at: userAt, assistant_message_at: assistantAt, provider_id: pid, request_type: String(turn.request_type ?? "") },
    rows, totals,
  });
});

router.post("/analytics/aux-llm-usage", (req, res) => {
  const body = req.body ?? {};
  try {
    const pidRaw = String(body.provider_id ?? body.providerId ?? "").trim();
    const pid = normalizeAuxAnalyticsProviderId(pidRaw);
    const kind = String(body.request_kind ?? body.requestKind ?? "").trim();
    if (!ANALYTICS_PROVIDER_IDS.includes(pid)) return res.status(400).json({ ok: false, error: "Unknown or missing provider_id" });
    if (!AUX_LLM_USAGE_KINDS.has(kind)) return res.status(400).json({ ok: false, error: "Unknown or missing request_kind" });
    const optTok = (v) => { const n = parseInt(String(v ?? ""), 10); return Number.isFinite(n) && n >= 0 ? n : 0; };
    const pp = optTok(body.llm_prompt_tokens);
    const pc = optTok(body.llm_completion_tokens);
    const pt = optTok(body.llm_total_tokens);
    if (pp === 0 && pc === 0 && pt === 0 && kind !== "optimizer_llm_check") {
      return res.status(400).json({ ok: false, error: "At least one non-zero token field is required" });
    }
    const ctIn = String(body.conversation_turn_id ?? body.conversationTurnId ?? "").trim();
    const dlgIn = String(body.dialog_id ?? body.dialogId ?? "").trim();
    db.prepare(
      `INSERT INTO analytics_aux_llm_usage (id, provider_id, request_kind, llm_prompt_tokens, llm_completion_tokens, llm_total_tokens, conversation_turn_id, dialog_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(crypto.randomUUID(), pid, kind, pp, pc, pt, ctIn || null, dlgIn || null);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
