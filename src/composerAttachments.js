/** Лимит и подготовка вложений в поле ввода чата перед отправкой в LLM. */

export const MAX_COMPOSER_ATTACHMENTS = 10;

const MAX_TEXT_READ_BYTES = 512 * 1024;
const MAX_TEXT_CHARS = 120_000;

const DOCUMENT_EXT = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".odt",
  ".rtf",
  ".txt",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".ods",
  ".csv",
  ".tsv",
  ".pages",
]);

const CODE_EXT = new Set([
  ".html",
  ".htm",
  ".xhtml",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".xml",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".vue",
  ".svelte",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".config",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".cxx",
  ".cs",
  ".php",
  ".sql",
  ".md",
  ".markdown",
  ".svg",
  ".wasm",
  ".gradle",
  ".properties",
  ".env",
  ".htaccess",
  ".plist",
  ".ipynb",
  ".lock",
  ".log",
]);

function extLower(name) {
  const n = String(name ?? "");
  const i = n.lastIndexOf(".");
  return i >= 0 ? n.slice(i).toLowerCase() : "";
}

/**
 * @param {File} file
 * @returns {"image" | "document" | "code" | "other"}
 */
export function classifyComposerAttachmentKind(file) {
  const mime = String(file.type ?? "").toLowerCase();
  const ext = extLower(file.name);

  if (mime.startsWith("image/")) return "image";
  if (DOCUMENT_EXT.has(ext)) return "document";
  if (CODE_EXT.has(ext)) return "code";
  if (
    mime.includes("json") ||
    mime.includes("javascript") ||
    mime.includes("xml") ||
    mime.includes("html") ||
    mime === "text/css" ||
    mime === "application/x-sh" ||
    mime === "application/x-yaml"
  ) {
    return "code";
  }
  return "other";
}

export function revokeComposerAttachmentPreview(item) {
  if (item?.previewUrl) {
    try {
      URL.revokeObjectURL(item.previewUrl);
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {File} file
 * @returns {Promise<{ base64: string, mimeType: string } | null>}
 */
async function readImageFileAsBase64(file) {
  const buf = await file.arrayBuffer();
  const mime =
    String(file.type || "application/octet-stream")
      .split(";")[0]
      .trim() || "application/octet-stream";
  if (!mime.startsWith("image/")) return null;
  let bin = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return { base64: btoa(bin), mimeType: mime };
}

function pushTextBlock(pieces, name, text) {
  const t = String(text ?? "");
  const clipped =
    t.length > MAX_TEXT_CHARS ? `${t.slice(0, MAX_TEXT_CHARS)}\n\n[…truncated…]` : t;
  pieces.push(`### ${name}\n\n${clipped}`);
}

/**
 * @param {File[]} files
 * @returns {Promise<{ images: Array<{ mimeType: string, base64: string }>, textAppend: string, filenames: string[] }>}
 */
export async function prepareComposerAttachmentsForApi(files) {
  /** @type {Array<{ mimeType: string, base64: string }>} */
  const images = [];
  const textPieces = [];

  for (const file of files) {
    const kind = classifyComposerAttachmentKind(file);
    const name = file.name || "attachment";

    if (kind === "image") {
      const img = await readImageFileAsBase64(file);
      if (img) images.push({ mimeType: img.mimeType, base64: img.base64 });
      else textPieces.push(`[Attached image could not be read: ${name}]`);
      continue;
    }

    const ext = extLower(name);
    const asPlainTable =
      kind === "document" &&
      (ext === ".txt" ||
        ext === ".csv" ||
        ext === ".tsv" ||
        mimeLooksPlainTable(file.type));

    const tryText =
      kind === "code" ||
      asPlainTable ||
      (ext === ".md" && String(file.type || "").startsWith("text/")) ||
      file.type === "text/markdown";

    if (tryText && file.size <= MAX_TEXT_READ_BYTES) {
      try {
        const text = await file.text();
        pushTextBlock(textPieces, name, text);
      } catch {
        textPieces.push(`[Attached file could not be read as text: ${name}]`);
      }
    } else if (kind === "document" || kind === "code") {
      textPieces.push(
        `[Attached ${kind === "document" ? "document" : "file"} (binary or too large): ${name}; MIME: ${file.type || "unknown"} — content not inlined.]`,
      );
    } else {
      textPieces.push(
        `[Attached file: ${name}; MIME: ${file.type || "unknown"} — content not inlined.]`,
      );
    }
  }

  const textAppend = textPieces.join("\n\n").trim();
  return {
    images,
    textAppend,
    filenames: files.map((f) => f.name || "file"),
  };
}

function mimeLooksPlainTable(mime) {
  const m = String(mime || "").toLowerCase();
  return m === "text/plain" || m === "text/csv" || m === "text/tab-separated-values";
}
