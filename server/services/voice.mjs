/**
 * Voice services: transcription (Gemini → OpenAI fallback) and TTS reply synthesis
 * (OpenAI direct MP3 or Gemini WAV → ffmpeg → MP3).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { db } from "../db/migrations.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");

export const VOICE_REPLIES_DIR = path.join(root, "voice-replies");

/** Dev-only self-test audio under `data/tts-selftest` — safe to remove entirely with multimedia clear. */
export const TTS_SELFTEST_DIR = path.join(root, "data", "tts-selftest");

export function sanitizeTurnIdForVoiceFile(rawTurnId) {
  const tid = String(rawTurnId ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(tid)) {
    throw new Error("Invalid turn id for voice reply.");
  }
  return tid;
}

export function voiceReplyMp3Path(turnId) {
  return path.join(VOICE_REPLIES_DIR, `${turnId}.mp3`);
}

export function voiceReplyApiUrl(turnId) {
  return `/api/voice/replies/${encodeURIComponent(turnId)}/file`;
}

export function ensureVoiceRepliesDir() {
  fs.mkdirSync(VOICE_REPLIES_DIR, { recursive: true });
}

export function getAssistantTextForTurnId(turnId) {
  const row = db
    .prepare(`SELECT assistant_text AS assistantText FROM conversation_turns WHERE id = ?`)
    .get(turnId);
  if (!row) {
    throw new Error("Unknown turn id (no row in conversation_turns).");
  }
  const text = String(row?.assistantText ?? "").trim();
  if (!text) throw new Error("Assistant text is empty for this turn.");
  return text;
}

function normalizeAudioMimeType(raw) {
  const t = String(raw ?? "")
    .trim()
    .toLowerCase()
    .split(";")[0]
    .trim();
  return t || "audio/webm";
}

function decodeBase64Audio(rawBase64) {
  const compact = String(rawBase64 ?? "").replace(/\s/g, "");
  if (!compact) throw new Error("audioBase64 is required.");
  let buf;
  try {
    buf = Buffer.from(compact, "base64");
  } catch {
    throw new Error("audioBase64 is not valid base64.");
  }
  if (!buf.length) throw new Error("Decoded audio is empty.");
  return buf;
}

function extractGeminiTextFromGenerateContent(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const c of candidates) {
    const parts = Array.isArray(c?.content?.parts) ? c.content.parts : [];
    const txt = parts
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("\n")
      .trim();
    if (txt) return txt;
  }
  return "";
}

async function transcribeWithGemini(audioBuffer, mimeType, apiKey) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "Transcribe this audio exactly. Return only the plain transcript text in the detected language. No explanations.",
          },
          {
            inline_data: {
              mime_type: mimeType,
              data: audioBuffer.toString("base64"),
            },
          },
        ],
      },
    ],
  };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      String(data?.error?.message ?? "").trim() || `Gemini transcription failed (${res.status})`;
    throw new Error(msg);
  }
  const text = extractGeminiTextFromGenerateContent(data).trim();
  if (!text) throw new Error("Gemini returned empty transcription.");
  return text;
}

async function transcribeWithOpenAi(audioBuffer, mimeType, apiKey) {
  const form = new FormData();
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("response_format", "json");
  form.append("file", new Blob([audioBuffer], { type: mimeType }), `voice.${mimeType.split("/")[1] || "webm"}`);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(data?.error?.message ?? "").trim() || `OpenAI transcription failed (${res.status})`;
    throw new Error(msg);
  }
  const text = String(data?.text ?? "").trim();
  if (!text) throw new Error("OpenAI returned empty transcription.");
  return text;
}

export async function transcribeVoiceFromEnv(audioBuffer, mimeType, body) {
  const geminiKey =
    String(process.env.GEMINI_API_KEY ?? "").trim() || String(body?.geminiApiKey ?? "").trim();
  const openAiKey =
    String(process.env.OPENAI_API_KEY ?? "").trim() || String(body?.openAiApiKey ?? "").trim();
  if (!geminiKey && !openAiKey) {
    throw new Error("Voice transcription requires Gemini or ChatGPT key.");
  }
  if (geminiKey) {
    try {
      const text = await transcribeWithGemini(audioBuffer, mimeType, geminiKey);
      return { providerId: "gemini-flash", text };
    } catch (gemErr) {
      if (!openAiKey) throw gemErr;
    }
  }
  if (openAiKey) {
    const text = await transcribeWithOpenAi(audioBuffer, mimeType, openAiKey);
    return { providerId: "openai", text };
  }
  throw new Error("Voice transcription failed for available providers.");
}

async function synthesizeSpeechMp3BufferWithOpenAi(text, apiKey) {
  const input = String(text ?? "").trim();
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      voice: "alloy",
      response_format: "mp3",
      input,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const msg = String(data?.error?.message ?? "").trim() || `OpenAI TTS failed (${res.status})`;
    throw new Error(msg);
  }
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!buf.length) throw new Error("OpenAI TTS returned empty audio.");
  return buf;
}

/** Same TTS contract as cyprusdiscovery `server/geminiTts.mjs`. */
const GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const GEMINI_TTS_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`;
const GEMINI_TTS_DEFAULT_SAMPLE_RATE = 24000;

/**
 * Gemini TTS returns raw PCM16LE mono; wrap as WAV for ffmpeg.
 * @param {Buffer} pcm
 * @param {number} [sampleRate]
 */
function wrapPcm16leMonoToWav(pcm, sampleRate = GEMINI_TTS_DEFAULT_SAMPLE_RATE) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const subchunk2Size = pcm.length;
  const chunkSize = 36 + subchunk2Size;
  const buf = Buffer.alloc(44 + pcm.length);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(chunkSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(subchunk2Size, 40);
  pcm.copy(buf, 44);
  return buf;
}

/** @param {unknown} part */
function geminiTtsPartInlineAudio(part) {
  if (!part || typeof part !== "object") return null;
  const p = /** @type {{ inlineData?: { data?: string, mimeType?: string }, inline_data?: { data?: string, mime_type?: string } }} */ (
    part
  );
  const inline = p.inlineData ?? p.inline_data;
  if (!inline || typeof inline !== "object") return null;
  const data = inline.data;
  if (typeof data !== "string" || !data) return null;
  const mimeType =
    typeof inline.mimeType === "string" ? inline.mimeType : inline.mime_type;
  return { data, mimeType: String(mimeType || "") };
}

async function synthesizeSpeechWavWithGemini(text, apiKey) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error("Empty text for TTS.");

  const voiceName = String(process.env.GEMINI_TTS_VOICE ?? "").trim() || "Kore";

  const body = {
    contents: [{ parts: [{ text: trimmed }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
    model: GEMINI_TTS_MODEL,
  };

  const res = await fetch(GEMINI_TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": String(apiKey).trim(),
    },
    body: JSON.stringify(body),
  });

  const rawJson = await res.text();
  /** @type {unknown} */
  let data = null;
  try {
    data = rawJson.trim() ? JSON.parse(rawJson) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const errObj = data && typeof data === "object" ? /** @type {{ error?: { message?: string } | string }} */ (data) : null;
    const msg =
      (errObj?.error &&
        String(typeof errObj.error === "object" ? errObj.error.message : errObj.error)) ||
      rawJson.slice(0, 280) ||
      res.statusText;
    throw new Error(`Gemini TTS failed (${res.status}): ${msg}`);
  }

  const parts = /** @type {{ candidates?: Array<{ content?: { parts?: unknown[] } }> }} */ (data)
    ?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new Error("Gemini TTS response missing candidates.");

  let b64 = null;
  let mimeHint = "";
  for (const part of parts) {
    const inline = geminiTtsPartInlineAudio(part);
    if (inline?.data) {
      b64 = inline.data;
      mimeHint = inline.mimeType;
      break;
    }
  }
  if (!b64) throw new Error("Gemini TTS response missing inline audio.");

  const pcm = decodeBase64Audio(b64);
  const rateMatch = /rate=(\d+)/i.exec(mimeHint);
  const sampleRate = rateMatch
    ? Math.max(8000, Math.floor(Number(rateMatch[1]) || GEMINI_TTS_DEFAULT_SAMPLE_RATE))
    : GEMINI_TTS_DEFAULT_SAMPLE_RATE;
  const wav = wrapPcm16leMonoToWav(pcm, sampleRate);
  return { audioBuffer: wav, mimeType: "audio/wav" };
}

function convertWavBufferToMp3File(wavBuffer, wavMimeType, mp3Path) {
  ensureVoiceRepliesDir();
  const ext = wavMimeType.includes("wav") ? "wav" : wavMimeType.split("/")[1] || "audio";
  const tmpIn = path.join(VOICE_REPLIES_DIR, `${crypto.randomUUID()}.${ext}`);
  fs.writeFileSync(tmpIn, wavBuffer);
  try {
    const out = spawnSync(
      "ffmpeg",
      ["-y", "-hide_banner", "-loglevel", "error", "-i", tmpIn, "-vn", "-ar", "44100", "-ac", "2", "-b:a", "192k", mp3Path],
      { encoding: "utf8" },
    );
    if (out.status !== 0) {
      const msg = String(out.stderr || out.stdout || "").trim() || "ffmpeg conversion failed";
      throw new Error(msg);
    }
  } finally {
    try {
      fs.unlinkSync(tmpIn);
    } catch {
      /* ignore */
    }
  }
  const st = fs.statSync(mp3Path);
  if (!st.isFile() || st.size <= 0) throw new Error("MP3 conversion produced empty file.");
}

/**
 * @param {string} turnId
 * @param {{ geminiApiKey?: string, openAiApiKey?: string }} [body]
 */
export async function ensureVoiceReplyMp3ForTurn(turnId, body = {}) {
  const OPENAI_SPEECH_INPUT_MAX = 4096;
  const mp3Path = voiceReplyMp3Path(turnId);
  if (fs.existsSync(mp3Path)) {
    return { mp3Path, providerId: "", created: false };
  }
  const text = getAssistantTextForTurnId(turnId);
  const geminiKey =
    String(process.env.GEMINI_API_KEY ?? "").trim() ||
    String(process.env.GOOGLE_AI_STUDIO_KEY ?? "").trim() ||
    String(body?.geminiApiKey ?? "").trim();
  const openAiKey =
    String(process.env.OPENAI_API_KEY ?? "").trim() || String(body?.openAiApiKey ?? "").trim();
  if (!geminiKey && !openAiKey) {
    throw new Error("Voice playback requires Gemini or ChatGPT key.");
  }

  async function tryOpenAiDirectMp3() {
    const t = String(text ?? "");
    if (t.length > OPENAI_SPEECH_INPUT_MAX) {
      throw new Error(
        `OpenAI speech allows at most ${OPENAI_SPEECH_INPUT_MAX} characters; this reply has ${t.length}. For long replies use Gemini audio (needs ffmpeg) or split the message.`,
      );
    }
    const mp3Buf = await synthesizeSpeechMp3BufferWithOpenAi(text, openAiKey);
    ensureVoiceRepliesDir();
    fs.writeFileSync(mp3Path, mp3Buf);
    return { mp3Path, providerId: "openai", created: true };
  }

  /** @type {Buffer | null} */
  let wavBuffer = null;
  let wavMimeType = "audio/wav";
  let providerId = "";

  if (geminiKey) {
    try {
      const out = await synthesizeSpeechWavWithGemini(text, geminiKey);
      wavBuffer = out.audioBuffer;
      wavMimeType = out.mimeType || "audio/wav";
      providerId = "gemini-3.1-flash-tts";
    } catch (e) {
      if (!openAiKey) throw e;
    }
  }
  if (!wavBuffer && openAiKey) {
    return await tryOpenAiDirectMp3();
  }
  if (!wavBuffer) throw new Error("Voice synthesis failed for available providers.");
  if (normalizeAudioMimeType(wavMimeType).includes("mpeg") || wavMimeType.includes("mp3")) {
    ensureVoiceRepliesDir();
    fs.writeFileSync(mp3Path, wavBuffer);
    return { mp3Path, providerId, created: true };
  }
  try {
    convertWavBufferToMp3File(wavBuffer, wavMimeType, mp3Path);
    return { mp3Path, providerId, created: true };
  } catch (convErr) {
    const hint = convErr instanceof Error ? convErr.message : String(convErr);
    const len = String(text ?? "").length;
    if (openAiKey && len <= OPENAI_SPEECH_INPUT_MAX) {
      try {
        return await tryOpenAiDirectMp3();
      } catch (ttsErr) {
        const t2 = ttsErr instanceof Error ? ttsErr.message : String(ttsErr);
        throw new Error(`${hint} · ChatGPT fallback: ${t2}`);
      }
    }
    if (openAiKey && len > OPENAI_SPEECH_INPUT_MAX) {
      throw new Error(
        `${hint} For replies over ${OPENAI_SPEECH_INPUT_MAX} characters, install ffmpeg so Gemini audio can be converted to MP3 (this reply: ${len} chars).`,
      );
    }
    throw convErr instanceof Error ? convErr : new Error(hint);
  }
}
