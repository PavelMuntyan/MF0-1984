import crypto from "node:crypto";
import { Router } from "express";
import { db } from "../db/migrations.mjs";
import {
  rawDbTimestamp,
  archiveConversationTurnAggregatesForDialog,
  listThemesWithDialogs,
  listTurns,
  listAssistantFavorites,
  updateAssistantTurnFavoriteInDb,
  deleteThemeFromDb,
  createDialogUnderTheme,
  dialogRowToClient,
} from "../db/turns.mjs";
import {
  recordAuxLlmUsageRow,
} from "../db/analytics.mjs";
import {
  scheduleMemoryGraphKeeperIngestForChatApiTurn,
  shouldRunMemoryGraphKeeperForApiTurnBody,
} from "../memoryGraphApiTurnKeeper.mjs";
import { ingestMemoryGraphFromBody } from "../db/memoryGraph.mjs";
import {
  runAfterTurnPipeline,
  clearThreadDerivedData,
  userTextTriggersAccessDataDumpLockdown,
} from "../services/contextPipeline.mjs";

const router = Router();

const MAX_PERSIST_IMAGE_BASE64_CHARS = 14_000_000;
const MAX_PERSIST_TEXT_INLINE_CHARS = 120_000;

function parseTurnUserAttachmentsJson(raw) {
  if (raw == null || String(raw).trim() === "") return [];
  try {
    const j = JSON.parse(String(raw));
    if (!Array.isArray(j)) return [];
    return j
      .filter((x) => x && typeof x === "object")
      .slice(0, 10)
      .map((x) => {
        const name = String(x.name ?? "file").slice(0, 512);
        const kind = ["image", "document", "code", "other"].includes(String(x.kind)) ? String(x.kind) : "other";
        const out = { name, kind };
        const mimeRaw = String(x.mimeType ?? x.mime ?? "").trim().slice(0, 128);
        if (/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+\/-]*$/i.test(mimeRaw)) out.mimeType = mimeRaw;
        const b64src = x.imageBase64 != null ? String(x.imageBase64) : x.base64 != null ? String(x.base64) : "";
        const b64 = b64src.replace(/\s/g, "");
        if (kind === "image" && b64.length > 0 && b64.length <= MAX_PERSIST_IMAGE_BASE64_CHARS) {
          if (/^[A-Za-z0-9+/]+=*$/.test(b64)) out.imageBase64 = b64;
        }
        const textRaw = x.textInline != null ? String(x.textInline) : x.textSnapshot != null ? String(x.textSnapshot) : "";
        if (textRaw.length > 0 && textRaw.length <= MAX_PERSIST_TEXT_INLINE_CHARS) out.textInline = textRaw;
        return out;
      });
  } catch {
    return [];
  }
}

function userAttachmentsJsonFromBody(body) {
  const v = body?.user_attachments_json;
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return ""; }
}

function userTextForContextPipeline(storedUserText, attachmentsJson) {
  const base = String(storedUserText ?? "").trim();
  const rows = parseTurnUserAttachmentsJson(attachmentsJson);
  if (rows.length === 0) return base;
  const names = rows.map((r) => r.name).filter(Boolean);
  if (names.length === 0) return base;
  const hint = `[Attached: ${names.join(", ")}]`;
  return base ? `${base}\n\n${hint}` : hint;
}

// ── Themes ────────────────────────────────────────────────────────────────────

router.get("/themes", async (_req, res) => {
  res.json({ themes: await listThemesWithDialogs() });
});

router.post("/themes/bootstrap", async (req, res) => {
  const body = req.body ?? {};
  const title = String(body.title ?? "").trim() || "New conversation";
  const themeId = crypto.randomUUID();
  const dialogId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO themes (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(themeId, title, now, now);
    db.prepare(`INSERT INTO dialogs (id, theme_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(dialogId, themeId, title, now, now);
  })();
  const theme = db.prepare(`SELECT * FROM themes WHERE id = ?`).get(themeId);
  const dialog = db.prepare(`SELECT * FROM dialogs WHERE id = ?`).get(dialogId);
  res.status(201).json({
    theme: { id: theme.id, title: theme.title, starterDate: rawDbTimestamp(theme.created_at), lastActionDate: rawDbTimestamp(theme.updated_at) },
    dialog: { id: dialog.id, themeId: dialog.theme_id, title: dialog.title, starterDate: rawDbTimestamp(dialog.created_at), lastActionDate: rawDbTimestamp(dialog.updated_at) },
  });
});

router.post("/themes/new-dialog", async (req, res) => {
  const body = req.body ?? {};
  const themeId = String(body.themeId ?? body.theme_id ?? "").trim();
  if (!themeId) return res.status(400).json({ ok: false, error: "themeId required" });
  if (!db.prepare(`SELECT id FROM themes WHERE id = ?`).get(themeId)) return res.status(404).json({ ok: false, error: "Theme not found" });
  const title = String(body.title ?? "").trim() || "New conversation";
  const dialog = await createDialogUnderTheme(themeId, title);
  res.status(201).json({ dialog: dialogRowToClient(dialog) });
});

router.post("/themes/:themeId/dialogs", async (req, res) => {
  const themeId = req.params.themeId.trim();
  if (!themeId) return res.status(400).json({ ok: false, error: "themeId required" });
  if (!db.prepare(`SELECT id FROM themes WHERE id = ?`).get(themeId)) return res.status(404).json({ ok: false, error: "Theme not found" });
  const body = req.body ?? {};
  const title = String(body.title ?? "").trim() || "New conversation";
  const dialog = await createDialogUnderTheme(themeId, title);
  res.status(201).json({ dialog: dialogRowToClient(dialog) });
});

router.post(["/themes/delete", "/theme-delete"], async (req, res) => {
  const body = req.body ?? {};
  const themeId = String(body.themeId ?? body.theme_id ?? "").trim();
  const out = await deleteThemeFromDb(themeId);
  if (out.error) return res.status(out.status).json({ ok: false, error: out.error });
  console.log(`[mf-lab-api] theme deleted (POST): ${out.deletedThemeId}`);
  res.json(out);
});

router.delete("/themes/:themeId", async (req, res) => {
  const themeId = req.params.themeId.trim();
  const out = await deleteThemeFromDb(themeId);
  if (out.error) return res.status(out.status).json({ ok: false, error: out.error });
  console.log(`[mf-lab-api] theme deleted (DELETE): ${out.deletedThemeId}`);
  res.json(out);
});

router.post(["/themes/rename", "/theme-rename"], (req, res) => {
  const body = req.body ?? {};
  const themeId = String(body.themeId ?? body.theme_id ?? "").trim();
  const title = String(body.title ?? "").trim();
  if (!themeId) return res.status(400).json({ ok: false, error: "themeId required" });
  if (!title) return res.status(400).json({ ok: false, error: "title required" });
  if (!db.prepare(`SELECT id FROM themes WHERE id = ?`).get(themeId)) return res.status(404).json({ ok: false, error: "Theme not found" });
  const now = new Date().toISOString();
  db.prepare(`UPDATE themes SET title = ?, updated_at = ? WHERE id = ?`).run(title, now, themeId);
  res.json({ ok: true, themeId, title });
});

// ── Dialogs ───────────────────────────────────────────────────────────────────

router.get("/dialogs/:dialogId/turns", async (req, res) => {
  const dialogId = req.params.dialogId;
  if (!dialogId) return res.status(400).json({ ok: false, error: "Missing dialog id" });
  if (!db.prepare(`SELECT id FROM dialogs WHERE id = ?`).get(dialogId)) return res.status(404).json({ ok: false, error: "Dialog not found" });
  res.json({ turns: await listTurns(dialogId) });
});

router.get("/dialogs/:dialogId/context-pack", async (req, res) => {
  const { listContextPack } = await import("../services/contextPipeline.mjs");
  const dialogId = req.params.dialogId;
  if (!dialogId) return res.status(400).json({ ok: false, error: "Missing dialog id" });
  const q = String(req.query.q ?? req.query.userQuery ?? "");
  const pack = await listContextPack(dialogId, q);
  if (!pack) return res.status(404).json({ ok: false, error: "Dialog not found" });
  res.json(pack);
});

router.post("/dialogs/:dialogId/clear-turns", async (req, res) => {
  const dialogId = req.params.dialogId.trim();
  if (!dialogId) return res.status(400).json({ ok: false, error: "Missing dialog id" });
  const drow = db.prepare(`SELECT id, IFNULL(purpose, '') AS purpose FROM dialogs WHERE id = ?`).get(dialogId);
  if (!drow) return res.status(404).json({ ok: false, error: "Dialog not found" });
  if (!["intro", "rules", "access"].includes(String(drow.purpose ?? ""))) {
    return res.status(403).json({ ok: false, error: "Clear is only allowed for Intro, Rules, or Access threads." });
  }
  try {
    await archiveConversationTurnAggregatesForDialog(dialogId, "ir_thread_cleared", null);
    db.transaction(() => {
      clearThreadDerivedData(dialogId);
      db.prepare(`DELETE FROM conversation_turns WHERE dialog_id = ?`).run(dialogId);
    })();
  } catch (e) {
    console.error("[mf-lab-api] clear-turns:", e);
    return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
  res.json({ ok: true, dialogId });
});

router.post("/dialogs/:dialogId/turns", async (req, res) => {
  const dialogId = req.params.dialogId;
  if (!dialogId) return res.status(400).json({ ok: false, error: "Missing dialog id" });
  const drow = db.prepare(`SELECT id, theme_id, IFNULL(purpose, '') AS purpose FROM dialogs WHERE id = ?`).get(dialogId);
  if (!drow) return res.status(404).json({ ok: false, error: "Dialog not found" });

  const body = req.body ?? {};
  const turnId = crypto.randomUUID();
  const cloneFrom = String(body.clone_user_from_turn_id ?? "").trim();
  let userText = String(body.user_text ?? "");
  let userAttachmentsJson = userAttachmentsJsonFromBody(body);
  const assistantText = body.assistant_text != null ? String(body.assistant_text) : null;
  let requestedProviderId = String(body.requested_provider_id ?? "");
  const respondingProviderId = body.responding_provider_id != null ? String(body.responding_provider_id) : null;
  let requestType = String(body.request_type ?? "default");
  let userMessageAt = String(body.user_message_at ?? "");
  const assistantMessageAt = body.assistant_message_at != null ? String(body.assistant_message_at) : null;
  const assistantError = body.assistant_error === 1 || body.assistant_error === true ? 1 : 0;

  const optNonNegInt = (v) => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(Math.floor(n), 2_000_000_000);
  };
  const llmPromptTokens = optNonNegInt(body.llm_prompt_tokens);
  const llmCompletionTokens = optNonNegInt(body.llm_completion_tokens);
  const llmTotalTokens = optNonNegInt(body.llm_total_tokens);

  if (cloneFrom) {
    const src = db.prepare(
      `SELECT user_text, user_attachments_json, user_message_at, request_type, requested_provider_id
       FROM conversation_turns WHERE id = ? AND dialog_id = ?`,
    ).get(cloneFrom, dialogId);
    if (!src) return res.status(400).json({ ok: false, error: "clone_user_from_turn_id not found in this dialog" });
    userText = String(src.user_text ?? "");
    userAttachmentsJson = src.user_attachments_json != null ? String(src.user_attachments_json) : "";
    userMessageAt = String(src.user_message_at ?? "");
    requestType = String(src.request_type ?? "default");
    if (!String(requestedProviderId ?? "").trim()) requestedProviderId = String(src.requested_provider_id ?? "").trim();
  }

  const attachRows = parseTurnUserAttachmentsJson(userAttachmentsJson);
  const hasUserChars = String(userText).trim().length > 0;
  const hasAttach = attachRows.length > 0;
  const allowEmptyUserText = requestType === "access_data";
  if ((!hasUserChars && !hasAttach && !allowEmptyUserText) || !requestedProviderId || !userMessageAt) {
    return res.status(400).json({ ok: false, error: "user_text (or attachments), requested_provider_id, user_message_at required" });
  }

  const attachJsonToStore = hasAttach ? JSON.stringify(attachRows) : null;
  const pipelineUserText = userTextForContextPipeline(userText, attachJsonToStore);
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO conversation_turns (
         id, dialog_id, user_text, user_attachments_json, assistant_text, requested_provider_id, responding_provider_id,
         request_type, user_message_at, assistant_message_at, assistant_error,
         llm_prompt_tokens, llm_completion_tokens, llm_total_tokens
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(turnId, dialogId, userText, attachJsonToStore, assistantText, requestedProviderId, respondingProviderId,
      requestType, userMessageAt, assistantMessageAt, assistantError, llmPromptTokens, llmCompletionTokens, llmTotalTokens);
    db.prepare(`UPDATE dialogs SET updated_at = ? WHERE id = ?`).run(now, dialogId);
    db.prepare(`UPDATE themes SET updated_at = ? WHERE id = ?`).run(now, drow.theme_id);
  })();

  try {
    const dataDumpLockdown = userTextTriggersAccessDataDumpLockdown(userText) || requestType === "access_data";
    const skipPipelineForRetryClone = Boolean(cloneFrom);
    if (String(drow.purpose ?? "") !== "access" && !dataDumpLockdown && !skipPipelineForRetryClone) {
      runAfterTurnPipeline(dialogId, turnId, pipelineUserText, assistantText, userMessageAt, assistantMessageAt || now);
    }
    const graphPur = String(drow.purpose ?? "").trim();
    const graphKeeperEligiblePurpose = graphPur !== "access" && graphPur !== "rules" && graphPur !== "intro";
    if (
      graphKeeperEligiblePurpose && !dataDumpLockdown && !skipPipelineForRetryClone &&
      assistantError === 0 && requestType !== "image" && requestType !== "access_data" &&
      shouldRunMemoryGraphKeeperForApiTurnBody(body) && String(pipelineUserText ?? "").trim().length > 0
    ) {
      scheduleMemoryGraphKeeperIngestForChatApiTurn(
        db,
        (ingestBody) => ingestMemoryGraphFromBody(ingestBody),
        pipelineUserText,
        {
          dialogId, conversationTurnId: turnId,
          recordAuxUsage: (row) => {
            if (!row || typeof row !== "object") return;
            recordAuxLlmUsageRow(
              String(row.providerId ?? "openai"), String(row.requestKind ?? ""),
              Number(row.promptTokens) || 0, Number(row.completionTokens) || 0,
              Number(row.totalTokens) || 0, turnId, dialogId,
            );
          },
        },
      );
    }
  } catch (e) {
    console.error("context pipeline after turn:", e);
  }
  res.status(201).json({ id: turnId });
});

// ── Favorites ─────────────────────────────────────────────────────────────────

router.get(["/assistant-favorites", "/dialogs/assistant-favorites"], async (_req, res) => {
  const rows = await listAssistantFavorites();
  const favorites = rows.map((r) => {
    const line = String(r.user_text ?? "").trim().split(/\r?\n/).find((x) => x.trim().length > 0)?.trim();
    const fromFiles = parseTurnUserAttachmentsJson(r.user_attachments_json).map((x) => x.name).filter(Boolean).join(", ");
    const userPreview = (line && line.slice(0, 120)) || (fromFiles && fromFiles.slice(0, 120)) || "";
    return {
      turnId: r.turn_id, dialogId: r.dialog_id, themeId: r.theme_id,
      themeTitle: r.theme_title, dialogTitle: r.dialog_title, userPreview,
      markdown: r.assistant_favorite_markdown ?? "",
      assistantMessageAt: rawDbTimestamp(r.assistant_message_at),
    };
  });
  res.json({ favorites });
});

router.post(["/assistant-favorite", "/dialogs/assistant-favorite"], async (req, res) => {
  const body = req.body ?? {};
  const turnId = String(body.turnId ?? body.turn_id ?? "").trim();
  const favorite = Boolean(body.favorite);
  const markdown = body.markdown != null ? String(body.markdown) : "";
  const errOut = await updateAssistantTurnFavoriteInDb(turnId, favorite, markdown);
  if (errOut) return res.status(errOut.status).json({ ok: false, error: errOut.error });
  res.json({ ok: true });
});

router.post("/turns/:turnId/favorite", async (req, res) => {
  const turnId = req.params.turnId.trim();
  const body = req.body ?? {};
  const favorite = Boolean(body.favorite);
  const markdown = body.markdown != null ? String(body.markdown) : "";
  const errOut = await updateAssistantTurnFavoriteInDb(turnId, favorite, markdown);
  if (errOut) return res.status(errOut.status).json({ ok: false, error: errOut.error });
  res.json({ ok: true });
});

export default router;
