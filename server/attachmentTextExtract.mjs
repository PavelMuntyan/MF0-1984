import JSZip from "jszip";
import { PDFParse } from "pdf-parse";
import XLSX from "xlsx";

const MAX_EXTRACT_CHARS = 120_000;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

const SUPPORTED_EXT = new Set([".pdf", ".xlsx", ".pptx", ".odt", ".ods", ".rtf", ".docx"]);

function extLower(name) {
  const n = String(name ?? "");
  const i = n.lastIndexOf(".");
  return i >= 0 ? n.slice(i).toLowerCase() : "";
}

function decodeXmlEntities(s) {
  return String(s ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function normalizeText(s) {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clipText(s) {
  const txt = normalizeText(s);
  if (txt.length <= MAX_EXTRACT_CHARS) return { text: txt, truncated: false };
  return { text: `${txt.slice(0, MAX_EXTRACT_CHARS)}\n\n[…truncated…]`, truncated: true };
}

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const out = await parser.getText();
    return out?.text ?? "";
  } finally {
    await parser.destroy();
  }
}

function extractXlsxText(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const chunks = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (!csv.trim()) continue;
    chunks.push(`### Sheet: ${sheetName}\n\n${csv}`);
  }
  return chunks.join("\n\n");
}

function extractRtfText(buffer) {
  let s = buffer.toString("utf8");
  s = s
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\line/g, "\n")
    .replace(/\\tab/g, "\t")
    .replace(/\\'[0-9a-fA-F]{2}/g, (m) => {
      const hex = m.slice(2);
      return String.fromCharCode(parseInt(hex, 16));
    })
    .replace(/\\u-?\d+\??/g, "")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "");
  return s;
}

function stripXmlTagsToText(xml) {
  return decodeXmlEntities(
    String(xml ?? "")
      .replace(/<\s*text:h\b[^>]*>/gi, "\n")
      .replace(/<\s*text:p\b[^>]*>/gi, "\n")
      .replace(/<\s*table:table-row\b[^>]*>/gi, "\n")
      .replace(/<\s*table:table-cell\b[^>]*>/gi, "\t")
      .replace(/<[^>]+>/g, ""),
  );
}

async function extractPptxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/i)?.[1] ?? "0");
      const nb = Number(b.match(/slide(\d+)\.xml/i)?.[1] ?? "0");
      return na - nb;
    });
  const chunks = [];
  for (const p of slidePaths) {
    const xml = await zip.file(p)?.async("string");
    if (!xml) continue;
    const texts = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gi))
      .map((m) => decodeXmlEntities(m[1]))
      .map((t) => t.trim())
      .filter(Boolean);
    if (!texts.length) continue;
    const slideNo = Number(p.match(/slide(\d+)\.xml/i)?.[1] ?? "0");
    chunks.push(`### Slide ${slideNo}\n\n${texts.join("\n")}`);
  }
  return chunks.join("\n\n");
}

async function extractOpenDocumentText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const contentXml = await zip.file("content.xml")?.async("string");
  if (!contentXml) return "";
  return stripXmlTagsToText(contentXml);
}

async function extractDocxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) return "";
  return decodeXmlEntities(
    docXml
      .replace(/<\s*w:p\b[^>]*>/gi, "\n")
      .replace(/<\s*w:br\b[^>]*\/?>/gi, "\n")
      .replace(/<\s*w:tab\b[^>]*\/?>/gi, "\t")
      .replace(/<[^>]+>/g, ""),
  );
}

/**
 * @param {{ filename?: string, mimeType?: string, base64?: string }} input
 * @returns {Promise<{ text: string, truncated: boolean, kind: string }>}
 */
export async function extractAttachmentText(input) {
  const filename = String(input?.filename ?? "").trim();
  const mimeType = String(input?.mimeType ?? "").trim().toLowerCase();
  const ext = extLower(filename);
  if (!SUPPORTED_EXT.has(ext)) {
    throw new Error(`Unsupported format: ${ext || "unknown"}`);
  }
  const b64 = String(input?.base64 ?? "").replace(/\s/g, "");
  if (!b64) throw new Error("Empty attachment payload");
  const buffer = Buffer.from(b64, "base64");
  if (!buffer.length) throw new Error("Invalid base64 payload");
  if (buffer.length > MAX_INPUT_BYTES) {
    throw new Error(`Attachment is too large for parsing (max ${MAX_INPUT_BYTES} bytes).`);
  }

  let raw = "";
  if (ext === ".pdf") {
    raw = await extractPdfText(buffer);
  } else if (ext === ".xlsx") {
    raw = extractXlsxText(buffer);
  } else if (ext === ".pptx") {
    raw = await extractPptxText(buffer);
  } else if (ext === ".odt" || ext === ".ods") {
    raw = await extractOpenDocumentText(buffer);
  } else if (ext === ".docx") {
    raw = await extractDocxText(buffer);
  } else if (ext === ".rtf") {
    raw = extractRtfText(buffer);
  }
  const { text, truncated } = clipText(raw);
  return {
    text,
    truncated,
    kind: `${ext}:${mimeType || "application/octet-stream"}`,
  };
}
