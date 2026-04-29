/**
 * Rules keeper — JSON file storage for structured conduct rules.
 * No database dependency; files live under `rules/` at the repo root.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");

const RULES_KEEPER_DIR = path.join(root, "rules");
export const RULES_KEEPER_SPEC = [
  { key: "core_rules", file: "core_rules.json", rule_type: "keeper3_core", title: "Saved conduct — general" },
  {
    key: "private_rules",
    file: "private_rules.json",
    rule_type: "keeper3_private",
    title: "Saved conduct — personal boundaries",
  },
  {
    key: "forbidden_actions",
    file: "forbidden_actions.json",
    rule_type: "keeper3_forbidden",
    title: "Saved conduct — must not do",
  },
  {
    key: "workflow_rules",
    file: "workflow_rules.json",
    rule_type: "keeper3_workflow",
    title: "Saved conduct — step-by-step habits",
  },
];
const RULES_KEEPER_ITEM_TEXT_MAX = 4000;
const RULES_KEEPER_MAX_ITEMS = 120;

function ensureRulesKeeperDir() {
  if (!fs.existsSync(RULES_KEEPER_DIR)) {
    fs.mkdirSync(RULES_KEEPER_DIR, { recursive: true });
  }
}

function readRulesKeeperItemsFromFile(fileName) {
  ensureRulesKeeperDir();
  const fp = path.join(RULES_KEEPER_DIR, fileName);
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp, `${JSON.stringify({ items: [] }, null, 2)}\n`, "utf8");
    return [];
  }
  let raw;
  try {
    raw = fs.readFileSync(fp, "utf8");
  } catch {
    return [];
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
  /** @type {{ text: string, addedAt: string }[]} */
  const out = [];
  for (const it of arr) {
    const text =
      typeof it === "string"
        ? String(it).trim()
        : String(it?.text ?? it?.content ?? "").trim();
    if (!text) continue;
    const addedAt = typeof it === "object" && it?.addedAt ? String(it.addedAt) : "";
    out.push({
      text: text.slice(0, RULES_KEEPER_ITEM_TEXT_MAX),
      addedAt: addedAt || new Date().toISOString(),
    });
  }
  return out.slice(0, RULES_KEEPER_MAX_ITEMS + 40);
}

function writeRulesKeeperItemsFile(fileName, items) {
  ensureRulesKeeperDir();
  const fp = path.join(RULES_KEEPER_DIR, fileName);
  const trimmed = items.slice(0, RULES_KEEPER_MAX_ITEMS);
  fs.writeFileSync(fp, `${JSON.stringify({ items: trimmed }, null, 2)}\n`, "utf8");
}

export function readRulesKeeperBundlePayload() {
  /** @type {Record<string, { text: string, addedAt: string }[]>} */
  const out = {};
  for (const spec of RULES_KEEPER_SPEC) {
    out[spec.key] = readRulesKeeperItemsFromFile(spec.file);
  }
  return out;
}

function normRulesKeeperDedupeKey(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 600);
}

function mergeRulesKeeperItemLists(existing, incoming) {
  const seen = new Set(existing.map((x) => normRulesKeeperDedupeKey(x.text)));
  const now = new Date().toISOString();
  const merged = [...existing];
  for (const it of incoming) {
    const t = String(it.text ?? it).trim().slice(0, RULES_KEEPER_ITEM_TEXT_MAX);
    if (!t) continue;
    const k = normRulesKeeperDedupeKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push({ text: t, addedAt: now });
    if (merged.length >= RULES_KEEPER_MAX_ITEMS) break;
  }
  return merged.slice(-RULES_KEEPER_MAX_ITEMS);
}

/**
 * @param {unknown} body
 * @returns {{ ok: true, merged_total: number } | { error: string, status: number }}
 */
export function mergeRulesKeeperPatchFromBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "expected JSON object", status: 400 };
  }
  /** @param {unknown} v */
  const toIncoming = (v) => {
    if (!Array.isArray(v)) return [];
    /** @type {{ text: string }[]} */
    const texts = [];
    for (const x of v) {
      if (typeof x === "string" && x.trim()) texts.push({ text: x.trim() });
      else if (x && typeof x === "object") {
        const t = String(x.text ?? x.rule ?? x.content ?? "").trim();
        if (t) texts.push({ text: t });
      }
    }
    return texts;
  };
  let mergedTotal = 0;
  for (const spec of RULES_KEEPER_SPEC) {
    const incoming = toIncoming(/** @type {Record<string, unknown>} */ (body)[spec.key]);
    if (incoming.length === 0) continue;
    const cur = readRulesKeeperItemsFromFile(spec.file);
    const merged = mergeRulesKeeperItemLists(cur, incoming);
    mergedTotal += Math.max(0, merged.length - cur.length);
    writeRulesKeeperItemsFile(spec.file, merged);
  }
  return { ok: true, merged_total: mergedTotal };
}

/**
 * @param {Record<string, { text: string, addedAt: string }[]>} bundle
 * @returns {Array<{ id: string, rule_type: string, title: string, content: string, priority: string, tags: string, is_active: number }>}
 */
export function keeperBundleToVirtualContextRules(bundle) {
  /** @type {Array<{ id: string, rule_type: string, title: string, content: string, priority: string, tags: string, is_active: number }>} */
  const out = [];
  if (!bundle || typeof bundle !== "object") return out;
  for (const spec of RULES_KEEPER_SPEC) {
    const items = Array.isArray(bundle[spec.key]) ? bundle[spec.key] : [];
    if (items.length === 0) continue;
    const lines = items
      .map((it) => {
        const t = String(it.text ?? it).trim();
        return t ? `- ${t}` : "";
      })
      .filter(Boolean);
    if (lines.length === 0) continue;
    const content = lines.join("\n").slice(0, 14000);
    const priority = spec.key === "forbidden_actions" ? "critical" : "high";
    out.push({
      id: `mf0-keeper3-${spec.key}`,
      rule_type: spec.rule_type,
      title: spec.title,
      content,
      priority,
      tags: "[]",
      is_active: 1,
    });
  }
  return out;
}
