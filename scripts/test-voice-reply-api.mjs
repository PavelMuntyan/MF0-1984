/**
 * POST /api/voice/replies/:turnId against local mf-lab-api (same body as browser).
 * Uses latest non-empty assistant turn from data/mf-lab.sqlite.
 *
 *   node --env-file=.env scripts/test-voice-reply-api.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { resolveApiPort } from "../server/resolveApiPort.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dbPath = process.env.API_SQLITE_PATH
  ? path.resolve(process.cwd(), process.env.API_SQLITE_PATH)
  : path.join(root, "data", "mf-lab.sqlite");

const db = new Database(dbPath);
const row = db
  .prepare(
    `SELECT id, length(trim(assistant_text)) AS n
     FROM conversation_turns
     WHERE trim(assistant_text) != ''
     ORDER BY assistant_message_at DESC
     LIMIT 1`,
  )
  .get();

if (!row?.id) {
  console.error("No conversation_turns with assistant_text — cannot test voice reply route.");
  process.exit(1);
}

const turnId = String(row.id);
const port = resolveApiPort(process.env.API_PORT);
const url = `http://127.0.0.1:${port}/api/voice/replies/${encodeURIComponent(turnId)}`;

const body = {
  geminiApiKey:
    String(process.env.GEMINI_API_KEY ?? "").trim() ||
    String(process.env.GOOGLE_AI_STUDIO_KEY ?? "").trim(),
  openAiApiKey: String(process.env.OPENAI_API_KEY ?? "").trim(),
};

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const txt = await res.text();
console.log("turnId:", turnId);
console.log("assistant chars (db):", row.n);
console.log("POST", url);
console.log("status:", res.status);
console.log("body:", txt.slice(0, 800));

process.exitCode = res.ok ? 0 : 1;
