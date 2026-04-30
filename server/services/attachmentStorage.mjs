/**
 * Attachment file storage: save base64 image payloads to disk under data/attachments/.
 * Replaces inline base64 in conversation_turns with on-disk files served via /api/files/attachments/.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");

export const ATTACHMENTS_DIR = path.join(root, "data", "attachments");

export function ensureAttachmentsDir() {
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
}

const MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};

function extFromMime(mimeType) {
  const base = String(mimeType ?? "").split(";")[0].trim().toLowerCase();
  return MIME_TO_EXT[base] ?? "bin";
}

/**
 * Saves a base64-encoded image to disk and returns the file name.
 * @param {string} base64
 * @param {string} mimeType
 * @returns {string} fileName (e.g. "a1b2c3d4.jpg")
 */
export function saveBase64ToFile(base64, mimeType) {
  const compact = String(base64 ?? "").replace(/\s/g, "");
  if (!compact) throw new Error("base64 is empty");
  const buf = Buffer.from(compact, "base64");
  if (!buf.length) throw new Error("Decoded attachment is empty");
  const ext = extFromMime(mimeType);
  const fileName = `${crypto.randomUUID()}.${ext}`;
  ensureAttachmentsDir();
  fs.writeFileSync(path.join(ATTACHMENTS_DIR, fileName), buf);
  return fileName;
}

/**
 * @param {string} fileName
 * @returns {string} absolute path
 */
export function attachmentFilePath(fileName) {
  return path.join(ATTACHMENTS_DIR, fileName);
}

/**
 * @param {string} fileName
 * @returns {string} URL served by the API
 */
export function attachmentFileUrl(fileName) {
  return `/api/files/attachments/${encodeURIComponent(fileName)}`;
}

/**
 * Deletes an attachment file silently (ignores ENOENT).
 * @param {string} fileName
 */
export function deleteAttachmentFileSafe(fileName) {
  try {
    fs.unlinkSync(path.join(ATTACHMENTS_DIR, fileName));
  } catch {
    /* ignore missing */
  }
}

/**
 * Extracts inline `data:image/...;base64,...` payloads from a markdown/plain-text string,
 * saves each to disk, and returns the rewritten string plus the list of saved file names.
 * @param {string} text
 * @returns {{ out: string, savedFiles: string[] }}
 */
export function extractDataImageUrlsFromText(text) {
  const s = String(text ?? "");
  if (!s.includes("data:image")) return { out: s, savedFiles: [] };

  const savedFiles = [];
  const out = s.replace(
    /data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/gi,
    (_match, subtype, b64) => {
      const mimeType = `image/${subtype.toLowerCase()}`;
      try {
        const fileName = saveBase64ToFile(b64, mimeType);
        savedFiles.push(fileName);
        return attachmentFileUrl(fileName);
      } catch {
        return _match;
      }
    },
  );
  return { out, savedFiles };
}
