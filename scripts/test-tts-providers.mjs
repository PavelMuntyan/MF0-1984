/**
 * Self-test: which of the four mf-lab chat providers can synthesize speech via their HTTP APIs.
 *
 * - OpenAI: POST /v1/audio/speech (tts-1) → MP3 file
 * - Gemini: generateContent (gemini-3.1-flash-tts-preview) → WAV file (same as server/api.mjs)
 * - Anthropic: public REST has Messages / models / … — no documented TTS; we verify the key via GET /v1/models
 *   and probe POST /v1/audio/speech (OpenAI-shaped) → expect 404/405 (no route).
 * - Perplexity: public API is chat/completions style — no documented TTS; we verify the key with a 1-token
 *   chat call and probe POST /v1/audio/speech → expect 404/405.
 *
 * Usage (from repo root):
 *   node --env-file=.env scripts/test-tts-providers.mjs
 *
 * Writes audio only for OpenAI + Gemini under data/tts-selftest/.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "data", "tts-selftest");

const PHRASE = "TEST TEST TEST";

const GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const GEMINI_TTS_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`;
const GEMINI_TTS_DEFAULT_SAMPLE_RATE = 24000;

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

function geminiTtsPartInlineAudio(part) {
  if (!part || typeof part !== "object") return null;
  const inline = part.inlineData ?? part.inline_data;
  if (!inline || typeof inline !== "object") return null;
  const data = inline.data;
  if (typeof data !== "string" || !data) return null;
  const mimeType =
    typeof inline.mimeType === "string" ? inline.mimeType : inline.mime_type;
  return { data, mimeType: String(mimeType || "") };
}

async function testOpenAiSpeech(apiKey) {
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
      input: PHRASE,
    }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = JSON.parse(buf.toString("utf8"));
      msg = String(j?.error?.message ?? msg);
    } catch {
      msg = buf.slice(0, 200).toString("utf8") || msg;
    }
    throw new Error(`OpenAI ${res.status}: ${msg}`);
  }
  if (!buf.length) throw new Error("OpenAI: empty body");
  return buf;
}

async function testGeminiTts(apiKey) {
  const voiceName = String(process.env.GEMINI_TTS_VOICE ?? "").trim() || "Kore";
  const body = {
    contents: [{ parts: [{ text: PHRASE }] }],
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
  let data = null;
  try {
    data = rawJson.trim() ? JSON.parse(rawJson) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const errObj = data && typeof data === "object" ? data : null;
    const msg =
      (errObj?.error &&
        String(typeof errObj.error === "object" ? errObj.error.message : errObj.error)) ||
      rawJson.slice(0, 240) ||
      res.statusText;
    throw new Error(`Gemini TTS ${res.status}: ${msg}`);
  }
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new Error("Gemini: missing candidates.parts");
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
  if (!b64) throw new Error("Gemini: no inline audio");
  const pcm = Buffer.from(b64.replace(/\s/g, ""), "base64");
  if (!pcm.length) throw new Error("Gemini: empty pcm");
  const rateMatch = /rate=(\d+)/i.exec(mimeHint);
  const sampleRate = rateMatch
    ? Math.max(8000, Math.floor(Number(rateMatch[1]) || GEMINI_TTS_DEFAULT_SAMPLE_RATE))
    : GEMINI_TTS_DEFAULT_SAMPLE_RATE;
  return wrapPcm16leMonoToWav(pcm, sampleRate);
}

/** @returns {Promise<{ ok: boolean, detail: string }>} */
async function testAnthropicProvider(apiKey) {
  const list = await fetch("https://api.anthropic.com/v1/models", {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!list.ok) {
    const t = await list.text();
    return { ok: false, detail: `GET /v1/models → ${list.status} ${t.slice(0, 120)}` };
  }
  const ttsProbe = await fetch("https://api.anthropic.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "tts-1", input: PHRASE }),
  });
  const noRoute = ttsProbe.status === 404 || ttsProbe.status === 405;
  if (!noRoute) {
    const body = await ttsProbe.text();
    return {
      ok: false,
      detail: `Unexpected POST /v1/audio/speech → ${ttsProbe.status} ${body.slice(0, 120)}`,
    };
  }
  return {
    ok: true,
    detail: `API key OK (GET /v1/models). No TTS: POST /v1/audio/speech → ${ttsProbe.status} (not in public Anthropic API; use OpenAI/Gemini/ElevenLabs etc.).`,
  };
}

/** @returns {Promise<{ ok: boolean, detail: string }>} */
async function testPerplexityProvider(apiKey) {
  const chat = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    }),
  });
  if (!chat.ok) {
    const t = await chat.text();
    return { ok: false, detail: `POST /chat/completions → ${chat.status} ${t.slice(0, 160)}` };
  }
  const ttsProbe = await fetch("https://api.perplexity.ai/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "tts-1", input: PHRASE }),
  });
  const noRoute = ttsProbe.status === 404 || ttsProbe.status === 405;
  if (!noRoute) {
    const body = await ttsProbe.text();
    return {
      ok: false,
      detail: `Unexpected POST /v1/audio/speech → ${ttsProbe.status} ${body.slice(0, 120)}`,
    };
  }
  return {
    ok: true,
    detail: `API key OK (minimal chat). No TTS: POST /v1/audio/speech → ${ttsProbe.status} (not in Perplexity developer API; app “read aloud” is product-side / extensions).`,
  };
}

function keyLine(label, val) {
  const ok = String(val ?? "").trim().length > 0;
  console.log(`${label}: ${ok ? "present" : "missing"}`);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const openaiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
  const geminiKey =
    String(process.env.GEMINI_API_KEY ?? "").trim() ||
    String(process.env.GOOGLE_AI_STUDIO_KEY ?? "").trim();
  const anthropicKey = String(process.env.ANTHROPIC_API_KEY ?? "").trim();
  const perplexityKey = String(process.env.PERPLEXITY_API_KEY ?? "").trim();

  console.log("mf-lab provider TTS / API check — phrase:", JSON.stringify(PHRASE));
  keyLine("OPENAI_API_KEY", openaiKey);
  keyLine("GEMINI_API_KEY or GOOGLE_AI_STUDIO_KEY", geminiKey);
  keyLine("ANTHROPIC_API_KEY", anthropicKey);
  keyLine("PERPLEXITY_API_KEY", perplexityKey);
  console.log("");

  let hardFail = 0;

  if (openaiKey) {
    try {
      const mp3 = await testOpenAiSpeech(openaiKey);
      const fp = path.join(outDir, "openai-tts-test.mp3");
      fs.writeFileSync(fp, mp3);
      console.log(`OpenAI (ChatGPT): TTS OK → ${fp} (${mp3.length} bytes)`);
    } catch (e) {
      console.log(`OpenAI (ChatGPT): TTS FAIL — ${e instanceof Error ? e.message : String(e)}`);
      hardFail += 1;
    }
  } else {
    console.log("OpenAI (ChatGPT): SKIP (no OPENAI_API_KEY)");
    hardFail += 1;
  }

  if (geminiKey) {
    try {
      const wav = await testGeminiTts(geminiKey);
      const fp = path.join(outDir, "gemini-tts-test.wav");
      fs.writeFileSync(fp, wav);
      console.log(`Gemini: TTS OK → ${fp} (${wav.length} bytes)`);
    } catch (e) {
      console.log(`Gemini: TTS FAIL — ${e instanceof Error ? e.message : String(e)}`);
      hardFail += 1;
    }
  } else {
    console.log("Gemini: SKIP (no GEMINI_API_KEY / GOOGLE_AI_STUDIO_KEY)");
    hardFail += 1;
  }

  if (anthropicKey) {
    const r = await testAnthropicProvider(anthropicKey);
    console.log(`Anthropic (Claude): ${r.ok ? "no TTS in public API (expected)" : "CHECK FAIL"} — ${r.detail}`);
    if (!r.ok) hardFail += 1;
  } else {
    console.log("Anthropic (Claude): SKIP (no ANTHROPIC_API_KEY) — public API has no documented speech synthesis.");
  }

  if (perplexityKey) {
    const r = await testPerplexityProvider(perplexityKey);
    console.log(`Perplexity: ${r.ok ? "no TTS in public API (expected)" : "CHECK FAIL"} — ${r.detail}`);
    if (!r.ok) hardFail += 1;
  } else {
    console.log("Perplexity: SKIP (no PERPLEXITY_API_KEY) — developer API has no documented speech synthesis.");
  }

  console.log("");
  console.log(
    hardFail
      ? `Done with ${hardFail} failure(s) (OpenAI/Gemini TTS or provider verification).`
      : "Done — OpenAI + Gemini produced audio; Claude + Perplexity verified as text-only APIs here.",
  );
  process.exitCode = hardFail > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
