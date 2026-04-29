import fs from "node:fs";
import { Router } from "express";
import {
  sanitizeTurnIdForVoiceFile,
  voiceReplyMp3Path,
  voiceReplyApiUrl,
  transcribeVoiceFromEnv,
  ensureVoiceReplyMp3ForTurn,
  getAssistantTextForTurnId,
  decodeBase64Audio,
  normalizeAudioMimeType,
} from "../services/voice.mjs";
import { db } from "../db/migrations.mjs";
import {
  analyticsProviderFromVoiceProvider,
  estimateTokensFromText,
  recordAuxLlmUsageRow,
  ANALYTICS_PROVIDER_IDS,
} from "../db/analytics.mjs";

const router = Router();

router.post("/voice/transcribe", async (req, res) => {
  const body = req.body ?? {};
  try {
    const audioBuffer = decodeBase64Audio(body.audioBase64);
    const mimeType = normalizeAudioMimeType(body.mimeType);
    const out = await transcribeVoiceFromEnv(audioBuffer, mimeType, body);
    try {
      const pid = analyticsProviderFromVoiceProvider(out.providerId);
      const completionTokens = estimateTokensFromText(out.text);
      recordAuxLlmUsageRow(pid, "voice_transcription", 0, completionTokens, completionTokens);
    } catch (e) {
      console.warn("[mf-lab-api] voice_transcription analytics:", e);
    }
    res.json({ ok: true, providerId: out.providerId, text: out.text });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

router.get("/voice/replies/:turnId/file", (req, res) => {
  try {
    const turnId = sanitizeTurnIdForVoiceFile(req.params.turnId);
    const mp3Path = voiceReplyMp3Path(turnId);
    if (!fs.existsSync(mp3Path)) {
      return res.status(404).json({ ok: false, error: "Voice reply not found." });
    }
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(mp3Path);
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

router.get("/voice/replies/:turnId", (req, res) => {
  try {
    const turnId = sanitizeTurnIdForVoiceFile(req.params.turnId);
    const mp3Path = voiceReplyMp3Path(turnId);
    const exists = fs.existsSync(mp3Path);
    res.json({ ok: true, turnId, exists, url: exists ? voiceReplyApiUrl(turnId) : "" });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

router.post("/voice/replies/:turnId", async (req, res) => {
  const body = req.body ?? {};
  try {
    const turnId = sanitizeTurnIdForVoiceFile(req.params.turnId);
    const out = await ensureVoiceReplyMp3ForTurn(turnId, body);
    if (out.created) {
      try {
        let pid = analyticsProviderFromVoiceProvider(out.providerId);
        if (!pid || !ANALYTICS_PROVIDER_IDS.includes(pid)) pid = "gemini-flash";
        const promptTokens = estimateTokensFromText(getAssistantTextForTurnId(turnId));
        let vDid = "";
        try {
          const tr = db.prepare(`SELECT dialog_id FROM conversation_turns WHERE id = ?`).get(turnId);
          vDid = String(tr?.dialog_id ?? "").trim();
        } catch { /* ignore */ }
        recordAuxLlmUsageRow(pid, "voice_reply_tts", promptTokens, 0, promptTokens, turnId, vDid);
      } catch (e) {
        console.warn("[mf-lab-api] voice_reply_tts analytics:", e);
      }
    }
    res.json({ ok: true, turnId, exists: true, created: out.created, providerId: out.providerId, url: voiceReplyApiUrl(turnId) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
