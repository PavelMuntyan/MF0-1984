/**
 * One-time migration: extract base64 image payloads from conversation_turns to disk.
 *
 * For each turn that still has:
 *   - user_attachments_json[].imageBase64  → save to data/attachments/, replace with imageFile
 *   - assistant_text with data:image/...;base64,...  → save to data/attachments/, replace with URL
 *
 * Safe to re-run: skips turns where extraction already happened (no imageBase64 / no data:image).
 *
 * Usage:
 *   node scripts/migrate-attachments.mjs [--dry-run]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// Load env (same as the server)
const envPath = path.join(root, ".env");
try {
  const { config } = await import("dotenv");
  config({ path: envPath });
} catch {
  // --env-file=.env is used by the server; dotenv is optional here
}

const { default: Database } = await import("better-sqlite3");
const { saveBase64ToFile, attachmentFileUrl, extractDataImageUrlsFromText } = await import(
  "../server/services/attachmentStorage.mjs"
);

const dbFile = path.join(root, "data", "mf-lab.sqlite");
const dryRun = process.argv.includes("--dry-run");

console.log(`migrate-attachments: db=${dbFile} dry-run=${dryRun}`);

const db = new Database(dbFile);
db.pragma("journal_mode = WAL");

const rows = db
  .prepare(
    `SELECT id, user_attachments_json, assistant_text
     FROM conversation_turns
     WHERE (user_attachments_json IS NOT NULL AND user_attachments_json LIKE '%imageBase64%')
        OR (assistant_text IS NOT NULL AND assistant_text LIKE '%data:image%')`,
  )
  .all();

console.log(`Found ${rows.length} turns to process.`);

const upd = db.prepare(
  `UPDATE conversation_turns SET user_attachments_json = ?, assistant_text = ? WHERE id = ?`,
);

let turnsUpdated = 0;
let imagesExtracted = 0;

const tx = db.transaction(() => {
  for (const row of rows) {
    const id = String(row.id ?? "").trim();
    let attJson = row.user_attachments_json != null ? String(row.user_attachments_json) : "";
    let assistantText = row.assistant_text != null ? String(row.assistant_text) : "";
    let changed = false;

    // --- user_attachments_json ---
    if (attJson && attJson.includes("imageBase64")) {
      let parsed;
      try {
        parsed = JSON.parse(attJson);
      } catch {
        parsed = null;
      }
      if (Array.isArray(parsed)) {
        const next = parsed.map((x) => {
          if (!x || typeof x !== "object" || x.kind !== "image" || !x.imageBase64) return x;
          try {
            const fileName = saveBase64ToFile(x.imageBase64, x.mimeType ?? "image/png");
            imagesExtracted += 1;
            const { imageBase64: _drop, ...rest } = x;
            return { ...rest, imageFile: fileName, imageUrl: attachmentFileUrl(fileName) };
          } catch (e) {
            console.warn(`  turn ${id}: attachment extract failed: ${e?.message}`);
            return x;
          }
        });
        const newJson = JSON.stringify(next);
        if (newJson !== attJson) {
          attJson = newJson;
          changed = true;
        }
      }
    }

    // --- assistant_text ---
    if (assistantText && assistantText.includes("data:image")) {
      try {
        const { out, savedFiles } = extractDataImageUrlsFromText(assistantText);
        if (savedFiles.length > 0) {
          assistantText = out;
          imagesExtracted += savedFiles.length;
          changed = true;
        }
      } catch (e) {
        console.warn(`  turn ${id}: assistant_text extract failed: ${e?.message}`);
      }
    }

    if (!changed) continue;

    if (!dryRun) {
      upd.run(
        attJson || null,
        assistantText.trim() === "" ? null : assistantText,
        id,
      );
    }
    turnsUpdated += 1;
    console.log(`  ${dryRun ? "[dry]" : "updated"} turn ${id}`);
  }
});

tx();

console.log(
  `Done. Turns updated: ${turnsUpdated}, images extracted: ${imagesExtracted}${dryRun ? " (dry run — nothing written)" : ""}.`,
);
db.close();
