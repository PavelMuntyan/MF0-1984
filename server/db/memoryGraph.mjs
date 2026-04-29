/**
 * Memory graph: category/label normalization, node/edge upsert, hub anchors, command application.
 * Depends on db from migrations.mjs and node:crypto — no HTTP layer.
 */
import crypto from "node:crypto";
import { db } from "../db/migrations.mjs";

const MEMORY_GRAPH_CATEGORIES = new Set([
  "People",
  "Dates",
  "Cities",
  "Countries",
  "Companies",
  "Projects",
  "Interests",
  "Documents",
  "Data",
  "Other",
]);

/** Default graph anchors (empty DB): profile and thematic interests. */
const MEMORY_GRAPH_HUB_USER_LABEL = "User";
const MEMORY_GRAPH_HUB_INTERESTS_LABEL = "Interests";

function normalizeMemoryGraphCategory(raw) {
  const s = String(raw ?? "").trim();
  if (MEMORY_GRAPH_CATEGORIES.has(s)) return s;
  return "Other";
}

/**
 * Ensures two canonical hubs (People/User, Interests/Interests) and an edge between them,
 * even when the graph is non-empty — otherwise chat ingest cannot attach links to Interests.
 */
function ensureMemoryGraphHubAnchorsPresent(database) {
  const tbl = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_graph_nodes'`)
    .get();
  if (!tbl) return;
  const now = new Date().toISOString();
  const userBlob =
    "- Anchor for Intro and self facts: attach profile details here.\n" +
    "- Prefer linking other Intro entities to this node rather than duplicating a separate “self” person node.";
  const interestsBlob =
    "- Hub for themes from regular chats: store broad umbrellas first (e.g. Astronomy, Music).\n" +
    "- Add narrower topics as children linked to these umbrellas and to this hub.";

  let userRow = database
    .prepare(`SELECT id FROM memory_graph_nodes WHERE category = ? AND label = ?`)
    .get("People", MEMORY_GRAPH_HUB_USER_LABEL);
  let userId = userRow?.id;
  if (!userId) {
    userId = crypto.randomUUID();
    database
      .prepare(
        `INSERT INTO memory_graph_nodes (id, category, label, blob, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, "People", MEMORY_GRAPH_HUB_USER_LABEL, userBlob, now, now);
  }

  let intRow = database
    .prepare(`SELECT id FROM memory_graph_nodes WHERE category = ? AND label = ?`)
    .get("Interests", MEMORY_GRAPH_HUB_INTERESTS_LABEL);
  let interestsId = intRow?.id;
  if (!interestsId) {
    interestsId = crypto.randomUUID();
    database
      .prepare(
        `INSERT INTO memory_graph_nodes (id, category, label, blob, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(interestsId, "Interests", MEMORY_GRAPH_HUB_INTERESTS_LABEL, interestsBlob, now, now);
  }

  const edge = database
    .prepare(
      `SELECT id FROM memory_graph_edges WHERE
        (source_node_id = ? AND target_node_id = ?) OR (source_node_id = ? AND target_node_id = ?)`,
    )
    .get(userId, interestsId, interestsId, userId);
  if (!edge) {
    database
      .prepare(
        `INSERT INTO memory_graph_edges (id, source_node_id, target_node_id, relation, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), userId, interestsId, "profile and interests", now);
  }
}

function memoryGraphNodeKey(category, label) {
  return `${category}\n${normGraphLabel(label)}`;
}

/** Single normalization path for node labels in the DB (no domain heuristics). */
function normGraphLabel(raw) {
  return String(raw ?? "")
    .normalize("NFC")
    .trim()
    .slice(0, 200);
}

function appendGraphBlob(blob, notes) {
  const lineRaw = String(notes ?? "").trim();
  if (!lineRaw) return String(blob ?? "").trim();
  const line = lineRaw.startsWith("-") ? lineRaw : `- ${lineRaw}`;
  let b = String(blob ?? "").trim();
  b = b ? `${b}\n${line}` : line;
  if (b.length > 32000) b = `${b.slice(0, 31997)}…`;
  return b;
}

function memoryGraphIsProtectedHubNode(category, label) {
  const c = normalizeMemoryGraphCategory(category);
  const lab = normGraphLabel(label);
  return (
    (c === "People" && lab === MEMORY_GRAPH_HUB_USER_LABEL) ||
    (c === "Interests" && lab === MEMORY_GRAPH_HUB_INTERESTS_LABEL)
  );
}

function memoryGraphGetNodeRow(database, category, label) {
  const c = normalizeMemoryGraphCategory(category);
  const lab = normGraphLabel(label);
  return database.prepare(`SELECT id, blob FROM memory_graph_nodes WHERE category = ? AND label = ?`).get(c, lab) ?? null;
}

function memoryGraphMergeTwoNodes(database, fromCat, fromLab, intoCat, intoLab, now) {
  const fromRow = memoryGraphGetNodeRow(database, fromCat, fromLab);
  const intoRow = memoryGraphGetNodeRow(database, intoCat, intoLab);
  if (!fromRow?.id || !intoRow?.id || fromRow.id === intoRow.id) return false;
  const fromId = fromRow.id;
  const intoId = intoRow.id;
  const ob = String(fromRow.blob ?? "").trim();
  if (ob) {
    const intoBlobRow = database.prepare(`SELECT blob FROM memory_graph_nodes WHERE id = ?`).get(intoId);
    const merged = appendGraphBlob(
      String(intoBlobRow?.blob ?? "").trim(),
      `Merged from “${normGraphLabel(fromLab)}” (${normalizeMemoryGraphCategory(fromCat)}):\n${ob}`,
    );
    const b = merged.length > 32000 ? `${merged.slice(0, 31997)}…` : merged;
    database.prepare(`UPDATE memory_graph_nodes SET blob = ?, updated_at = ? WHERE id = ?`).run(b, now, intoId);
  }
  const edges = database
    .prepare(
      `SELECT id, source_node_id AS src, target_node_id AS tgt, relation FROM memory_graph_edges WHERE source_node_id = ? OR target_node_id = ?`,
    )
    .all(fromId, fromId);
  for (const e of edges) {
    const ns = e.src === fromId ? intoId : e.src;
    const nt = e.tgt === fromId ? intoId : e.tgt;
    if (ns === nt) {
      database.prepare(`DELETE FROM memory_graph_edges WHERE id = ?`).run(e.id);
      continue;
    }
    const dup = database
      .prepare(
        `SELECT id FROM memory_graph_edges WHERE source_node_id = ? AND target_node_id = ? AND relation = ?`,
      )
      .get(ns, nt, e.relation);
    if (dup) {
      database.prepare(`DELETE FROM memory_graph_edges WHERE id = ?`).run(e.id);
    } else {
      database
        .prepare(`UPDATE memory_graph_edges SET source_node_id = ?, target_node_id = ? WHERE id = ?`)
        .run(ns, nt, e.id);
    }
  }
  database.prepare(`DELETE FROM memory_graph_nodes WHERE id = ?`).run(fromId);
  return true;
}

function applyMemoryGraphCommandsFromBody(database, rawCommands, now) {
  const stats = {
    mergeNodes: 0,
    deleteNode: 0,
    renameNode: 0,
    deleteEdge: 0,
    moveEdge: 0,
    skipped: 0,
  };
  if (!Array.isArray(rawCommands) || rawCommands.length === 0) return stats;
  for (const c of rawCommands.slice(0, 50)) {
    if (!c || typeof c !== "object") continue;
    const op = String(c.op ?? "").trim();
    try {
      if (op === "mergeNodes") {
        const fc = normalizeMemoryGraphCategory(c.from?.category);
        const fl = normGraphLabel(c.from?.label);
        const tc = normalizeMemoryGraphCategory(c.into?.category);
        const tl = normGraphLabel(c.into?.label);
        if (!fl || !tl) {
          stats.skipped += 1;
          continue;
        }
        if (memoryGraphMergeTwoNodes(database, fc, fl, tc, tl, now)) stats.mergeNodes += 1;
        else stats.skipped += 1;
      } else if (op === "deleteNode") {
        const cat = normalizeMemoryGraphCategory(c.category);
        const lab = normGraphLabel(c.label);
        if (!lab || memoryGraphIsProtectedHubNode(cat, lab)) {
          stats.skipped += 1;
          continue;
        }
        const row = memoryGraphGetNodeRow(database, cat, lab);
        if (!row?.id) {
          stats.skipped += 1;
          continue;
        }
        database.prepare(`DELETE FROM memory_graph_edges WHERE source_node_id = ? OR target_node_id = ?`).run(
          row.id,
          row.id,
        );
        database.prepare(`DELETE FROM memory_graph_nodes WHERE id = ?`).run(row.id);
        stats.deleteNode += 1;
      } else if (op === "renameNode") {
        const cat = normalizeMemoryGraphCategory(c.category);
        const fromLab = normGraphLabel(c.fromLabel);
        const toLab = normGraphLabel(c.toLabel);
        if (!fromLab || !toLab || fromLab === toLab || memoryGraphIsProtectedHubNode(cat, fromLab)) {
          stats.skipped += 1;
          continue;
        }
        const row = memoryGraphGetNodeRow(database, cat, fromLab);
        if (!row?.id) {
          stats.skipped += 1;
          continue;
        }
        const collision = memoryGraphGetNodeRow(database, cat, toLab);
        if (collision?.id && collision.id !== row.id) {
          if (memoryGraphMergeTwoNodes(database, cat, fromLab, cat, toLab, now)) stats.renameNode += 1;
          else stats.skipped += 1;
          continue;
        }
        database
          .prepare(`UPDATE memory_graph_nodes SET label = ?, updated_at = ? WHERE id = ?`)
          .run(toLab, now, row.id);
        stats.renameNode += 1;
      } else if (op === "deleteEdge") {
        const fc = normalizeMemoryGraphCategory(c.from?.category);
        const fl = normGraphLabel(c.from?.label);
        const tc = normalizeMemoryGraphCategory(c.to?.category);
        const tl = normGraphLabel(c.to?.label);
        const relOpt = c.relation != null ? String(c.relation).trim().slice(0, 200) : "";
        if (!fl || !tl) {
          stats.skipped += 1;
          continue;
        }
        const s = memoryGraphGetNodeRow(database, fc, fl);
        const t = memoryGraphGetNodeRow(database, tc, tl);
        if (!s?.id || !t?.id) {
          stats.skipped += 1;
          continue;
        }
        if (relOpt) {
          const r = database
            .prepare(
              `DELETE FROM memory_graph_edges WHERE source_node_id = ? AND target_node_id = ? AND relation = ?`,
            )
            .run(s.id, t.id, relOpt);
          stats.deleteEdge += r.changes;
        } else {
          const r = database
            .prepare(`DELETE FROM memory_graph_edges WHERE source_node_id = ? AND target_node_id = ?`)
            .run(s.id, t.id);
          stats.deleteEdge += r.changes;
        }
      } else if (op === "moveEdge") {
        const rel = String(c.relation ?? "").trim().slice(0, 200) || "related";
        const ofc = normalizeMemoryGraphCategory(c.oldFrom?.category);
        const ofl = normGraphLabel(c.oldFrom?.label);
        const otc = normalizeMemoryGraphCategory(c.oldTo?.category);
        const otl = normGraphLabel(c.oldTo?.label);
        const nfc = normalizeMemoryGraphCategory(c.newFrom?.category);
        const nfl = normGraphLabel(c.newFrom?.label);
        const ntc = normalizeMemoryGraphCategory(c.newTo?.category);
        const ntl = normGraphLabel(c.newTo?.label);
        if (!ofl || !otl || !nfl || !ntl) {
          stats.skipped += 1;
          continue;
        }
        const os = memoryGraphGetNodeRow(database, ofc, ofl);
        const ot = memoryGraphGetNodeRow(database, otc, otl);
        const ns = memoryGraphGetNodeRow(database, nfc, nfl);
        const nt = memoryGraphGetNodeRow(database, ntc, ntl);
        if (!os?.id || !ot?.id || !ns?.id || !nt?.id) {
          stats.skipped += 1;
          continue;
        }
        database
          .prepare(`DELETE FROM memory_graph_edges WHERE source_node_id = ? AND target_node_id = ? AND relation = ?`)
          .run(os.id, ot.id, rel);
        const dup = database
          .prepare(
            `SELECT id FROM memory_graph_edges WHERE source_node_id = ? AND target_node_id = ? AND relation = ?`,
          )
          .get(ns.id, nt.id, rel);
        if (!dup && ns.id !== nt.id) {
          database
            .prepare(
              `INSERT INTO memory_graph_edges (id, source_node_id, target_node_id, relation, created_at) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(crypto.randomUUID(), ns.id, nt.id, rel, now);
        }
        stats.moveEdge += 1;
      }
    } catch {
      stats.skipped += 1;
    }
  }
  return stats;
}

function getMemoryGraphPayload() {
  ensureMemoryGraphHubAnchorsPresent(db);
  const tbl = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_graph_nodes'`)
    .get();
  if (!tbl) {
    return { nodes: [], links: [] };
  }
  const nodes = db
    .prepare(
      `SELECT id, category, label, blob FROM memory_graph_nodes ORDER BY category ASC, label COLLATE NOCASE ASC`,
    )
    .all();
  const links = db
    .prepare(
      `SELECT id, source_node_id AS source, target_node_id AS target, relation AS label FROM memory_graph_edges`,
    )
    .all();
  return { nodes, links };
}

/**
 * @param {unknown} body
 * @returns {{ ok: true, upsertedEntities: number, insertedLinks: number, commandsApplied: Record<string, number> }}
 */
function ingestMemoryGraphFromBody(body) {
  ensureMemoryGraphHubAnchorsPresent(db);
  const entities = Array.isArray(body?.entities) ? body.entities : [];
  const links = Array.isArray(body?.links) ? body.links : [];
  const commands = Array.isArray(body?.commands) ? body.commands : [];
  const now = new Date().toISOString();
  /** @type {Map<string, string>} */
  const keyToId = new Map();
  let upserted = 0;
  /** @type {Record<string, number>} */
  let commandsApplied = {};

  const tx = db.transaction(() => {
    for (const e of entities) {
      if (!e || typeof e !== "object") continue;
      const category = normalizeMemoryGraphCategory(e.category);
      const label = normGraphLabel(e.label);
      const notes = String(e.notes ?? "").trim().slice(0, 4000);
      if (!label) continue;
      const nk = memoryGraphNodeKey(category, label);
      const existing = db
        .prepare(`SELECT id, blob FROM memory_graph_nodes WHERE category = ? AND label = ?`)
        .get(category, label);
      if (existing) {
        const blob = appendGraphBlob(existing.blob, notes);
        db.prepare(`UPDATE memory_graph_nodes SET blob = ?, updated_at = ? WHERE id = ?`).run(blob, now, existing.id);
        keyToId.set(nk, existing.id);
      } else {
        const id = crypto.randomUUID();
        const blob0 = notes ? (notes.startsWith("-") ? notes : `- ${notes}`) : "";
        db.prepare(
          `INSERT INTO memory_graph_nodes (id, category, label, blob, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, category, label, blob0.slice(0, 32000), now, now);
        keyToId.set(nk, id);
      }
      upserted += 1;
    }

    let insertedLinks = 0;
    for (const ln of links) {
      if (!ln || typeof ln !== "object") continue;
      const from = ln.from;
      const to = ln.to;
      if (!from || !to || typeof from !== "object" || typeof to !== "object") continue;
      const fc = normalizeMemoryGraphCategory(from.category);
      const fl = normGraphLabel(from.label);
      const tc = normalizeMemoryGraphCategory(to.category);
      const tl = normGraphLabel(to.label);
      if (!fl || !tl) continue;
      const kf = memoryGraphNodeKey(fc, fl);
      const kt = memoryGraphNodeKey(tc, tl);
      let sid = keyToId.get(kf);
      let tid = keyToId.get(kt);
      if (!sid) {
        const r = db.prepare(`SELECT id FROM memory_graph_nodes WHERE category = ? AND label = ?`).get(fc, fl);
        sid = r?.id;
      }
      if (!tid) {
        const r = db.prepare(`SELECT id FROM memory_graph_nodes WHERE category = ? AND label = ?`).get(tc, tl);
        tid = r?.id;
      }
      if (!sid || !tid || sid === tid) continue;
      const rel = String(ln.relation ?? "").trim().slice(0, 200) || "related";
      db.prepare(
        `INSERT INTO memory_graph_edges (id, source_node_id, target_node_id, relation, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(crypto.randomUUID(), sid, tid, rel, now);
      insertedLinks += 1;
    }
    commandsApplied = applyMemoryGraphCommandsFromBody(db, commands, now);
    return insertedLinks;
  });

  const insertedLinks = tx();
  return { ok: true, upsertedEntities: upserted, insertedLinks, commandsApplied };
}

export {
  MEMORY_GRAPH_CATEGORIES,
  normalizeMemoryGraphCategory,
  normGraphLabel,
  appendGraphBlob,
  ensureMemoryGraphHubAnchorsPresent,
  memoryGraphIsProtectedHubNode,
  memoryGraphGetNodeRow,
  memoryGraphMergeTwoNodes,
  applyMemoryGraphCommandsFromBody,
  getMemoryGraphPayload,
  ingestMemoryGraphFromBody,
};
