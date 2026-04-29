import crypto from "node:crypto";
import { db } from "../db/migrations.mjs";
import { hasContextTables, listTurns } from "../db/turns.mjs";
import { ensureMemoryGraphHubAnchorsPresent } from "../db/memoryGraph.mjs";
import { readRulesKeeperBundlePayload, keeperBundleToVirtualContextRules } from "./rulesKeeper.mjs";
import { mergeRollingSummary, appendDecisionLogLine, shouldUpdateRollingSummary } from "../../src/contextEngine/rollingSummary.js";
import { extractMemoryItemsFromMessages } from "../../src/contextEngine/memoryExtraction.js";

const USER_PROFILE_CONTEXT_MAX_CHARS = 8000;

export function userTextTriggersAccessDataDumpLockdown(userText) {
  const t = String(userText ?? "").trim();
  if (!t) return false;
  if (t === "#data") return true;
  return /(?:^|\s)#data(?:\s|$)/.test(t);
}

export function clearThreadDerivedData(dialogId) {
  const did = String(dialogId ?? "").trim();
  if (!did) return;
  const tm = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='thread_messages'`).get();
  if (tm) db.prepare(`DELETE FROM thread_messages WHERE thread_id = ?`).run(did);
  const ts = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='thread_summaries'`).get();
  if (ts) db.prepare(`DELETE FROM thread_summaries WHERE thread_id = ?`).run(did);
  const mi = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_items'`).get();
  if (mi) db.prepare(`DELETE FROM memory_items WHERE thread_id = ?`).run(did);
}

async function readMemoryGraphUserProfileForContextPack() {
  try { await ensureMemoryGraphHubAnchorsPresent(); } catch { /* ignore */ }
  try {
    const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_graph_nodes'`).get();
    if (!tbl) return "";
    const row = db.prepare(`SELECT blob FROM memory_graph_nodes WHERE category = ? AND label = ?`).get("People", "User");
    const b = String(row?.blob ?? "").trim();
    if (!b) return "";
    return b.length <= USER_PROFILE_CONTEXT_MAX_CHARS ? b : `${b.slice(0, USER_PROFILE_CONTEXT_MAX_CHARS)}…`;
  } catch {
    return "";
  }
}

export async function listContextPack(dialogId, userQuery) {
  const drow = db.prepare(
    `SELECT d.id, d.title AS dialog_title, t.title AS theme_title
     FROM dialogs d JOIN themes t ON t.id = d.theme_id WHERE d.id = ?`,
  ).get(dialogId);
  if (!drow) return null;
  const turns = await listTurns(dialogId);
  const userAddressingProfile = await readMemoryGraphUserProfileForContextPack();
  if (!await hasContextTables()) {
    let rulesKeeperVirtual = [];
    try { rulesKeeperVirtual = keeperBundleToVirtualContextRules(readRulesKeeperBundlePayload()); }
    catch (e) { console.warn("[mf-lab-api] rules keeper (no context tables):", e); }
    return {
      threadId: dialogId, dialogTitle: drow.dialog_title, themeTitle: drow.theme_title,
      rules: rulesKeeperVirtual, memoryItems: [], summaries: [], threadMessages: [],
      turns, userQuery: userQuery || "", userAddressingProfile,
    };
  }
  const rulesDb = db.prepare(
    `SELECT id, rule_type, title, content, priority, tags, is_active FROM rules WHERE is_active = 1`,
  ).all();
  let rules = [...rulesDb];
  try { rules = [...rules, ...keeperBundleToVirtualContextRules(readRulesKeeperBundlePayload())]; }
  catch (e) { console.warn("[mf-lab-api] rules keeper bundle:", e); }
  const memoryItems = db.prepare(
    `SELECT id, scope, thread_id, memory_type, title, content, priority, tags, is_active
     FROM memory_items WHERE is_active = 1 AND (
       scope = 'global'
       OR (scope = 'project' AND (thread_id IS NULL OR thread_id = ?))
       OR (scope = 'thread' AND thread_id = ?)
     )
     ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
  ).all(dialogId, dialogId);
  const summaries = db.prepare(
    `SELECT id, thread_id, summary_text, summary_type, covered_until_message_id FROM thread_summaries WHERE thread_id = ?`,
  ).all(dialogId);
  const threadMessages = db.prepare(
    `SELECT id, role, content, created_at FROM thread_messages WHERE thread_id = ? ORDER BY datetime(created_at) ASC, id ASC`,
  ).all(dialogId);
  return {
    threadId: dialogId, dialogTitle: drow.dialog_title, themeTitle: drow.theme_title,
    rules, memoryItems, summaries, threadMessages, turns,
    userQuery: userQuery || "", userAddressingProfile,
  };
}

export async function runAfterTurnPipeline(dialogId, turnId, userText, assistantText, userMessageAt, assistantMessageAt) {
  if (!await hasContextTables()) return;
  const now = new Date().toISOString();
  const uid = crypto.randomUUID();
  const aid = crypto.randomUUID();
  const estU = Math.max(1, Math.ceil(String(userText).length / 4));
  const estA = Math.max(0, Math.ceil(String(assistantText ?? "").length / 4));
  db.prepare(
    `INSERT INTO thread_messages (id, thread_id, role, content, created_at, tokens_estimate, embedding, metadata, source_turn_id)
     VALUES (?, ?, 'user', ?, ?, ?, NULL, NULL, ?)`,
  ).run(uid, dialogId, userText, userMessageAt, estU, turnId);
  db.prepare(
    `INSERT INTO thread_messages (id, thread_id, role, content, created_at, tokens_estimate, embedding, metadata, source_turn_id)
     VALUES (?, ?, 'assistant', ?, ?, ?, NULL, NULL, ?)`,
  ).run(aid, dialogId, String(assistantText ?? ""), assistantMessageAt || now, estA, turnId);

  const cnt = db.prepare(`SELECT COUNT(*) AS c FROM thread_messages WHERE thread_id = ?`).get(dialogId).c;
  if (shouldUpdateRollingSummary(cnt)) {
    const rolling = db.prepare(
      `SELECT summary_text FROM thread_summaries WHERE thread_id = ? AND summary_type = 'rolling'`,
    ).get(dialogId);
    const nextRolling = mergeRollingSummary(rolling?.summary_text, userText, assistantText || "");
    db.prepare(`DELETE FROM thread_summaries WHERE thread_id = ? AND summary_type = 'rolling'`).run(dialogId);
    db.prepare(
      `INSERT INTO thread_summaries (id, thread_id, summary_text, summary_type, covered_until_message_id, created_at, updated_at)
       VALUES (?, ?, ?, 'rolling', ?, ?, ?)`,
    ).run(crypto.randomUUID(), dialogId, nextRolling, turnId, now, now);

    const dlog = db.prepare(
      `SELECT summary_text FROM thread_summaries WHERE thread_id = ? AND summary_type = 'decision_log'`,
    ).get(dialogId);
    const nextDec = appendDecisionLogLine(dlog?.summary_text, userText, assistantText || "");
    if (nextDec && nextDec !== String(dlog?.summary_text ?? "").trim()) {
      db.prepare(`DELETE FROM thread_summaries WHERE thread_id = ? AND summary_type = 'decision_log'`).run(dialogId);
      db.prepare(
        `INSERT INTO thread_summaries (id, thread_id, summary_text, summary_type, covered_until_message_id, created_at, updated_at)
         VALUES (?, ?, ?, 'decision_log', ?, ?, ?)`,
      ).run(crypto.randomUUID(), dialogId, nextDec, turnId, now, now);
    }
  }

  const drafts = extractMemoryItemsFromMessages(dialogId, [
    { role: "user", content: userText },
    { role: "assistant", content: String(assistantText ?? "") },
  ]);
  const ins = db.prepare(
    `INSERT INTO memory_items (id, scope, thread_id, memory_type, title, content, priority, tags, source_message_id, created_at, updated_at, embedding, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
  );
  for (const d of drafts) {
    ins.run(crypto.randomUUID(), d.scope, d.thread_id, d.memory_type, d.title, d.content,
      d.priority, d.tags ?? "[]", turnId, now, now);
  }
}
