/**
 * Full replace import for Memory tree (JSON body or gzip+ustar from export).
 * Used by api.mjs — receives normalizers from the main module to avoid duplicating category rules.
 */

import crypto from "node:crypto";
import { gunzipSync } from "node:zlib";

const MAX_IMPORT_NODES = 12000;
const MAX_IMPORT_EDGES = 80000;

/**
 * @param {Buffer} header
 * @param {number} off
 */
function parseTarOct12(header, off) {
  const s = header
    .subarray(off, off + 12)
    .toString("ascii")
    .replace(/\0/g, " ")
    .trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {Buffer} buf
 * @returns {Buffer} JSON file bytes
 */
export function extractMemoryTreeJsonFromUstarTar(buf) {
  let pos = 0;
  while (pos + 512 <= buf.length) {
    const header = buf.subarray(pos, pos + 512);
    if (header.length === 512 && header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").split("\0")[0].trim();
    const size = parseTarOct12(header, 124);
    pos += 512;
    if (size < 0 || pos + size > buf.length) {
      throw new Error("Invalid or truncated tar archive.");
    }
    const content = buf.subarray(pos, pos + size);
    pos += size;
    const pad = (512 - (size % 512)) % 512;
    pos += pad;
    if (name === "memory_tree.json" || name.endsWith(".json")) {
      return content;
    }
  }
  throw new Error("No memory_tree.json (or .json entry) found in the tar archive.");
}

/**
 * @param {Buffer} buffer
 * @returns {unknown}
 */
export function decodeImportBodyFromBuffer(buffer) {
  let b = buffer;
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) {
    try {
      b = gunzipSync(b);
    } catch {
      throw new Error("Could not decompress gzip data.");
    }
  }
  const head = b.subarray(0, Math.min(512, b.length)).toString("utf8");
  if (head.trimStart().startsWith("{")) {
    const text = b.toString("utf8").trim();
    return JSON.parse(text);
  }
  const jsonBuf = extractMemoryTreeJsonFromUstarTar(b);
  return JSON.parse(jsonBuf.toString("utf8"));
}

/**
 * @param {unknown} raw
 * @param {(s: string) => string} normalizeCategory
 * @param {(s: string) => string} normLabel
 * @returns {{ nodes: Array<{ id: string, category: string, label: string, blob: string }>, links: Array<{ id: string, source: string, target: string, relation: string }> }}
 */
export function normalizeImportPayload(raw, normalizeCategory, normLabel) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Import payload must be a JSON object.");
  }
  const j = /** @type {Record<string, unknown>} */ (raw);
  const schema = j.schema != null ? String(j.schema).trim() : "";
  if (schema && schema !== "mf0.memory_tree.v1" && schema !== "mf0.project_export.memory_graph.v1") {
    throw new Error(
      `Unsupported schema: ${schema}. Expected mf0.memory_tree.v1, mf0.project_export.memory_graph.v1, or omit schema.`,
    );
  }
  const nodesIn = Array.isArray(j.nodes) ? j.nodes : null;
  const linksIn = Array.isArray(j.links) ? j.links : null;
  if (!nodesIn || !linksIn) {
    throw new Error("Payload must include non-null \"nodes\" and \"links\" arrays.");
  }
  if (nodesIn.length > MAX_IMPORT_NODES) {
    throw new Error(`Too many nodes (max ${MAX_IMPORT_NODES}).`);
  }
  if (linksIn.length > MAX_IMPORT_EDGES) {
    throw new Error(`Too many links (max ${MAX_IMPORT_EDGES}).`);
  }

  /** @type {Map<string, { id: string, category: string, label: string, blob: string }>} */
  const byId = new Map();
  /** @type {Map<string, string>} */
  const byCatLabel = new Map();

  for (const row of nodesIn) {
    if (!row || typeof row !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (row);
    const id = String(o.id ?? "").trim();
    const category = normalizeCategory(o.category);
    const label = normLabel(o.label);
    const blob = String(o.blob ?? "");
    if (!id) throw new Error("Each node must have a non-empty \"id\".");
    if (!label) throw new Error(`Node ${id}: empty label.`);
    if (byId.has(id)) throw new Error(`Duplicate node id: ${id}.`);
    const ck = `${category}\n${label}`;
    if (byCatLabel.has(ck)) {
      throw new Error(`Duplicate node category/label: ${category} / ${label}.`);
    }
    byId.set(id, { id, category, label, blob: blob.slice(0, 32000) });
    byCatLabel.set(ck, id);
  }

  const nodes = [...byId.values()];
  const idSet = new Set(nodes.map((n) => n.id));
  if (nodes.length === 0 && linksIn.some((row) => row && typeof row === "object")) {
    throw new Error("Links were present but no valid nodes were found.");
  }
  /** @type {Set<string>} */
  const edgeIds = new Set();
  /** @type {Array<{ id: string, source: string, target: string, relation: string }>} */
  const links = [];
  for (const row of linksIn) {
    if (!row || typeof row !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (row);
    const source = String(o.source ?? "").trim();
    const target = String(o.target ?? "").trim();
    const relation = String(o.label ?? o.relation ?? "")
      .trim()
      .slice(0, 200);
    if (!source || !target) continue;
    if (!idSet.has(source) || !idSet.has(target)) {
      throw new Error(`Link references unknown node id (${source} → ${target}).`);
    }
    if (source === target) continue;
    const idRaw = String(o.id ?? "").trim();
    let id = idRaw || crypto.randomUUID();
    if (edgeIds.has(id)) {
      throw new Error(`Duplicate link id: ${id}.`);
    }
    edgeIds.add(id);
    links.push({
      id,
      source,
      target,
      relation: relation || "related",
    });
  }

  return { nodes, links };
}

/**
 * @param {import("better-sqlite3").Database} database
 * @param {{ nodes: Array<{ id: string, category: string, label: string, blob: string }>, links: Array<{ id: string, source: string, target: string, relation: string }> }} payload
 * @param {() => void} ensureHubAnchors
 * @returns {{ nodesImported: number, edgesImported: number }}
 */
export function replaceMemoryGraphInDatabase(database, payload, ensureHubAnchors) {
  const { nodes, links } = payload;
  const now = new Date().toISOString();
  let nodesImported = 0;
  let edgesImported = 0;

  const tx = database.transaction(() => {
    database.prepare(`DELETE FROM memory_graph_edges`).run();
    database.prepare(`DELETE FROM memory_graph_nodes`).run();
    const insN = database.prepare(
      `INSERT INTO memory_graph_nodes (id, category, label, blob, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const n of nodes) {
      insN.run(n.id, n.category, n.label, n.blob, now, now);
      nodesImported += 1;
    }
    const insE = database.prepare(
      `INSERT INTO memory_graph_edges (id, source_node_id, target_node_id, relation, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const e of links) {
      insE.run(e.id, e.source, e.target, e.relation, now);
      edgesImported += 1;
    }
  });
  tx();
  ensureHubAnchors();
  return { nodesImported, edgesImported };
}
