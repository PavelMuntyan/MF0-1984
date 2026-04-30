/**
 * Project cache: size stats and multimedia cleanup (voice files + embedded images in DB).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, dbPath } from "../db/migrations.mjs";
import { VOICE_REPLIES_DIR, TTS_SELFTEST_DIR } from "./voice.mjs";
import { ATTACHMENTS_DIR } from "./attachmentStorage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");

function countFilesAndBytesRecursive(absDir) {
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(absDir)) return { files, bytes };
  /** @param {string} dir */
  function walk(dir) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          files += 1;
          bytes += Number(fs.statSync(full).size) || 0;
        }
      } catch {
        /* skip */
      }
    }
  }
  walk(absDir);
  return { files, bytes };
}

/**
 * Removes image byte payloads from `user_attachments_json` (keeps names, kinds, `textInline`, etc.).
 * @param {unknown} raw
 * @returns {{ changed: boolean, out: string, bytesRemoved: number }}
 */
function stripImagePayloadsFromUserAttachmentsJson(raw) {
  if (raw == null || String(raw).trim() === "") {
    return { changed: false, out: String(raw ?? ""), bytesRemoved: 0 };
  }
  const rawStr = String(raw);
  let j;
  try {
    j = JSON.parse(rawStr);
  } catch {
    return { changed: false, out: rawStr, bytesRemoved: 0 };
  }
  if (!Array.isArray(j)) return { changed: false, out: rawStr, bytesRemoved: 0 };
  let changed = false;
  let bytesRemoved = 0;
  const next = j.map((x) => {
    if (!x || typeof x !== "object") return x;
    const o = { ...x };
    for (const key of ["imageBase64", "base64", "imageFile", "imageUrl"]) {
      if (o[key] == null) continue;
      const s = String(o[key]);
      if (s.length === 0) continue;
      bytesRemoved += Buffer.byteLength(s, "utf8");
      delete o[key];
      changed = true;
    }
    return o;
  });
  if (!changed) return { changed: false, out: rawStr, bytesRemoved: 0 };
  let out;
  try {
    out = JSON.stringify(next);
  } catch {
    return { changed: false, out: rawStr, bytesRemoved: 0 };
  }
  return { changed: true, out, bytesRemoved };
}

/**
 * Strips markdown image payloads (inline base64 and /api/files/attachments/ references) from a text field.
 * @param {unknown} raw
 * @returns {{ out: string, bytesRemoved: number }}
 */
function stripDataImagePayloadsFromTextField(raw) {
  const s = raw == null ? "" : String(raw);
  const hasContent = s.includes("data:image") || s.includes("/api/files/attachments/");
  if (!hasContent) return { out: s, bytesRemoved: 0 };
  const before = Buffer.byteLength(s, "utf8");
  let out = s.replace(
    /!\[[^\]]{0,800}?\]\(\s*data:image\/[a-z0-9.+-]+;base64,[\s\S]*?\)/gi,
    "*[inline image removed]*",
  );
  out = out.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, "");
  out = out.replace(/!\[[^\]]{0,800}?\]\(\s*\/api\/files\/attachments\/[^\s)]{1,200}\s*\)/gi, "*[image removed]*");
  const bytesRemoved = Math.max(0, before - Buffer.byteLength(out, "utf8"));
  return { out, bytesRemoved };
}

/**
 * Removes embedded image data from `conversation_turns` while keeping dialog text and attachment metadata.
 * @param {import("better-sqlite3").Database} database
 * @returns {{ turnsUpdated: number, bytesFreed: number }}
 */
function stripEmbeddedMultimediaFromConversationTurns(database) {
  const rows = database
    .prepare(
      `SELECT id, user_text, user_attachments_json, assistant_text, assistant_favorite_markdown
       FROM conversation_turns
       WHERE (user_attachments_json IS NOT NULL AND TRIM(user_attachments_json) != '')
          OR (user_text LIKE '%data:image%')
          OR (assistant_text LIKE '%data:image%')
          OR (assistant_favorite_markdown LIKE '%data:image%')`,
    )
    .all();

  const upd = database.prepare(
    `UPDATE conversation_turns
     SET user_attachments_json = ?, user_text = ?, assistant_text = ?, assistant_favorite_markdown = ?
     WHERE id = ?`,
  );

  let turnsUpdated = 0;
  let bytesFreed = 0;

  const tx = database.transaction(() => {
    for (const row of rows) {
      const id = String(row.id ?? "").trim();
      if (!id) continue;

      let userText = String(row.user_text ?? "");
      let assistantText = row.assistant_text != null ? String(row.assistant_text) : "";
      let favMd = row.assistant_favorite_markdown != null ? String(row.assistant_favorite_markdown) : "";
      let attJson = row.user_attachments_json != null ? String(row.user_attachments_json) : "";

      let rowChanged = false;
      let rowFreed = 0;

      const att = stripImagePayloadsFromUserAttachmentsJson(attJson);
      if (att.changed) {
        const oldB = Buffer.byteLength(attJson, "utf8");
        attJson = att.out;
        rowFreed += Math.max(0, oldB - Buffer.byteLength(attJson, "utf8"));
        rowChanged = true;
      }

      const ut = stripDataImagePayloadsFromTextField(userText);
      if (ut.bytesRemoved > 0) {
        userText = ut.out;
        rowFreed += ut.bytesRemoved;
        rowChanged = true;
      }
      if (!userText.trim() && ut.bytesRemoved > 0) {
        userText = "[Images removed — there was no plain text left.]";
      }
      const at = stripDataImagePayloadsFromTextField(assistantText);
      if (at.bytesRemoved > 0) {
        assistantText = at.out;
        rowFreed += at.bytesRemoved;
        rowChanged = true;
      }
      const fm = stripDataImagePayloadsFromTextField(favMd);
      if (fm.bytesRemoved > 0) {
        favMd = fm.out;
        rowFreed += fm.bytesRemoved;
        rowChanged = true;
      }

      if (!rowChanged) continue;
      const attPayload =
        !attJson || attJson.trim() === "" || attJson === "[]" || attJson === "null" ? null : attJson;
      upd.run(attPayload, userText, assistantText.trim() === "" ? null : assistantText, favMd.trim() === "" ? null : favMd, id);
      turnsUpdated += 1;
      bytesFreed += rowFreed;
    }
  });
  tx();

  return { turnsUpdated, bytesFreed };
}

/**
 * Removes on-disk multimedia cache: voice-reply MP3/WAV and `data/tts-selftest/`.
 * @returns {{ filesRemoved: number, bytesFreed: number }}
 */
function clearProjectMultimediaCacheDiskOnly() {
  let filesRemoved = 0;
  let bytesFreed = 0;

  if (fs.existsSync(VOICE_REPLIES_DIR)) {
    let names;
    try {
      names = fs.readdirSync(VOICE_REPLIES_DIR);
    } catch {
      names = [];
    }
    for (const name of names) {
      const low = String(name).toLowerCase();
      if (!low.endsWith(".mp3") && !low.endsWith(".wav")) continue;
      const fp = path.join(VOICE_REPLIES_DIR, name);
      try {
        const st = fs.statSync(fp);
        if (!st.isFile()) continue;
        const sz = Number(st.size) || 0;
        fs.unlinkSync(fp);
        filesRemoved += 1;
        bytesFreed += sz;
      } catch {
        /* skip */
      }
    }
  }

  if (fs.existsSync(TTS_SELFTEST_DIR)) {
    const pre = countFilesAndBytesRecursive(TTS_SELFTEST_DIR);
    try {
      fs.rmSync(TTS_SELFTEST_DIR, { recursive: true, force: true });
      filesRemoved += pre.files;
      bytesFreed += pre.bytes;
    } catch {
      /* ignore partial failure */
    }
  }

  if (fs.existsSync(ATTACHMENTS_DIR)) {
    let names;
    try {
      names = fs.readdirSync(ATTACHMENTS_DIR);
    } catch {
      names = [];
    }
    for (const name of names) {
      const fp = path.join(ATTACHMENTS_DIR, name);
      try {
        const st = fs.statSync(fp);
        if (!st.isFile()) continue;
        const sz = Number(st.size) || 0;
        fs.unlinkSync(fp);
        filesRemoved += 1;
        bytesFreed += sz;
      } catch {
        /* skip */
      }
    }
  }

  return { filesRemoved, bytesFreed };
}

/**
 * Disk voice cache + tts self-test, plus embedded image payloads in `conversation_turns`.
 * @returns {{ filesRemoved: number, bytesFreed: number, turnsUpdated: number }}
 */
export function clearProjectMultimediaCacheFull() {
  const disk = clearProjectMultimediaCacheDiskOnly();
  const dbRes = stripEmbeddedMultimediaFromConversationTurns(db);
  /** Reclaim file space so `mf-lab.sqlite` shrinks on disk (otherwise stats stay huge). */
  let vacuumWarning = "";
  try {
    db.exec("VACUUM");
  } catch (e) {
    vacuumWarning = e instanceof Error ? e.message : String(e);
    console.warn("[mf-lab-api] VACUUM after multimedia clear:", vacuumWarning);
  }
  return {
    filesRemoved: disk.filesRemoved,
    bytesFreed: disk.bytesFreed + dbRes.bytesFreed,
    turnsUpdated: dbRes.turnsUpdated,
    ...(vacuumWarning ? { vacuumWarning } : {}),
  };
}

/**
 * Sum byte size of all regular files under `absDir` (recursive).
 * @param {string} absDir
 * @param {{ skipSqlite?: boolean }} [opts]
 */
function sumDirectoryFileBytesRecursive(absDir, opts = {}) {
  const skipSqlite = Boolean(opts.skipSqlite);
  let total = 0;
  if (!fs.existsSync(absDir)) return 0;
  let st0;
  try {
    st0 = fs.statSync(absDir);
  } catch {
    return 0;
  }
  if (!st0.isDirectory()) return 0;

  /** @param {string} dir */
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          if (skipSqlite && ent.name.toLowerCase().endsWith(".sqlite")) continue;
          const st = fs.statSync(full);
          total += Number(st.size) || 0;
        }
      } catch {
        /* skip unreadable entries */
      }
    }
  }
  walk(absDir);
  return total;
}

function utf8ByteLength(s) {
  return Buffer.byteLength(String(s ?? ""), "utf8");
}

function estimateMediaBytesFromAttachmentsJson(raw) {
  if (raw == null || String(raw).trim() === "") return 0;
  let j;
  try {
    j = JSON.parse(String(raw));
  } catch {
    return 0;
  }
  if (!Array.isArray(j)) return 0;
  let sum = 0;
  for (const x of j) {
    if (!x || typeof x !== "object") continue;
    for (const key of ["imageBase64", "base64"]) {
      if (typeof x[key] === "string" && x[key].length > 0) {
        sum += utf8ByteLength(x[key]);
      }
    }
  }
  return sum;
}

const DATA_IMAGE_BASE64_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi;

function estimateDataImageBytesInPlainText(val) {
  const s = val == null ? "" : String(val);
  if (!s.includes("data:image")) return 0;
  let sum = 0;
  let m;
  DATA_IMAGE_BASE64_RE.lastIndex = 0;
  while ((m = DATA_IMAGE_BASE64_RE.exec(s)) !== null) {
    sum += utf8ByteLength(m[0]);
  }
  return sum;
}

/**
 * Embedded media stored in `conversation_turns` only.
 * Same image duplicated in JSON and markdown would be counted twice — treat as an upper-bound estimate.
 * @param {import("better-sqlite3").Database} database
 */
function estimateEmbeddedMediaBytesInConversationTurns(database) {
  const stmt = database.prepare(
    `SELECT user_attachments_json, user_text, assistant_text, assistant_favorite_markdown FROM conversation_turns`,
  );
  let total = 0;
  for (const row of stmt.iterate()) {
    total += estimateMediaBytesFromAttachmentsJson(row.user_attachments_json);
    total += estimateDataImageBytesInPlainText(row.user_text);
    total += estimateDataImageBytesInPlainText(row.assistant_text);
    total += estimateDataImageBytesInPlainText(row.assistant_favorite_markdown);
  }
  return total;
}

export function getProjectCacheStatsPayload() {
  const dataDir = path.join(root, "data");
  const dataDirCacheBytes = sumDirectoryFileBytesRecursive(dataDir, { skipSqlite: true });
  let chatDatabaseBytes = 0;
  try {
    const st = fs.statSync(dbPath);
    if (st.isFile()) chatDatabaseBytes = Number(st.size) || 0;
  } catch {
    /* missing or unreadable */
  }
  let chatEmbeddedMediaBytes = 0;
  try {
    chatEmbeddedMediaBytes = estimateEmbeddedMediaBytesInConversationTurns(db);
  } catch (e) {
    console.warn("[mf-lab-api] estimateEmbeddedMediaBytesInConversationTurns:", e);
  }
  if (chatEmbeddedMediaBytes > chatDatabaseBytes) {
    chatEmbeddedMediaBytes = chatDatabaseBytes;
  }
  const chatDbOtherApproxBytes = Math.max(0, chatDatabaseBytes - chatEmbeddedMediaBytes);
  const soundFilesBytes = sumDirectoryFileBytesRecursive(VOICE_REPLIES_DIR, { skipSqlite: false });
  const attachmentFilesBytes = sumDirectoryFileBytesRecursive(ATTACHMENTS_DIR, { skipSqlite: false });
  /** @deprecated Combined total; clients should prefer split fields. */
  const filesAndPicturesBytes = dataDirCacheBytes + chatDatabaseBytes;
  return {
    ok: true,
    filesAndPicturesBytes,
    soundFilesBytes,
    attachmentFilesBytes,
    dataDirCacheBytes,
    chatDatabaseBytes,
    chatEmbeddedMediaBytes,
    chatDbOtherApproxBytes,
  };
}
