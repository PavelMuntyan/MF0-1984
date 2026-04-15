/**
 * Optional server-side **Keeper (chat)** path for turns saved only via POST /api/dialogs/:id/turns
 * (benchmarks, scripts) so the memory graph DB updates like the browser pipeline.
 *
 * Gated by request body `run_memory_graph_keeper` or env `MF_LAB_MEMORY_GRAPH_ON_API_TURNS`
 * — see `scheduleMemoryGraphKeeperIngestForChatApiTurn` callers in `api.mjs`.
 */

const CHAT_INTEREST_SKETCH_EXTRACT_SYSTEM =
  'You are part of the **Keeper** pipeline for normal chats: **Interests only**. **Only the human user\'s latest message matters** — do not use assistant/model text or inferred dialog summaries; you receive **user text only**.\n' +
  'You update a **lightweight interest sketch** for a normal (non-Intro) chat. This is NOT an encyclopedia: only a **small** interest graph.\n' +
  'Return ONE JSON object with keys "entities" and "links" only.\n' +
  '"entities": array of { "category": string, "label": string, "notes": string }.\n' +
  '"links": array of { "from": { "label": string, "category": string }, "to": { "label": string, "category": string }, "relation": string }.\n' +
  "\n" +
  "Rules:\n" +
  '- **Only** category "Interests" for every entity.\n' +
  '- Add **at most two** new interest labels per call (besides using the hub only as a link target), both inferred **only from this USER message**:\n' +
  '  (1) **Global umbrella** — one broad life/domain theme (1–4 words, USER\'s language).\n' +
  '  (2) **Thread topic branch** — one broad headline for what the user is talking about **in this message** (still an umbrella-level label under Interests; not facts, lists, people, places, dates, or episode detail).\n' +
  '- If the turn is pure small talk or nothing thematic: return {"entities":[],"links":[]}.\n' +
  '- Links (all ends category "Interests"): link **thread topic → umbrella** with relation "within scope of"; link **umbrella → hub** { "category": "Interests", "label": "Interests" } with relation "under". If only one level is justified, output a single umbrella entity and link it "under" the hub only.\n' +
  '- Do **not** add entities for trivia, proper nouns of episodes, cast, dates, or anything that would bloat the graph — those belong elsewhere, not here.\n' +
  '- "notes": one short clause for each entity.\n' +
  "Output JSON only.";

const INTRO_GRAPH_NORMALIZE_SYSTEM =
  "You are the **Keeper** — the only stage that reconciles the memory tree with the database before writes. The **user is authoritative** (any language): when introMode is true, their explicit instructions for the graph override your habits and **must** be reflected in your output.\n" +
  "**Never** base decisions on assistant or model text. When introMode is true, `proposed` was produced from **user-only** extraction; `userTurn` is the same user text — treat it as the sole source of user intent. Do not reinterpret the graph using imagined assistant replies.\n" +
  "You normalize proposed memory-graph data against nodes already stored in the database.\n" +
  "**Duplicate annihilation (mandatory):** Compare existingNodes and proposed together. If several nodes are the **same real-world entity** — identical labels after trim, trivial spelling/script variants (e.g. Morocco / Maroc), or the same country/city/person/topic duplicated under parallel rows — **collapse to one** survivor: prefer an existingNodes label+category when it matches; pick the single best category (e.g. one country → Countries, not parallel Cities+Countries clones). Rewire every link to that survivor. **Never** leave parallel clones that would make the database grow without semantic gain.\n" +
  "The user message is one JSON object with these keys:\n" +
  '- "existingNodes": array of { "id": string, "category": string, "label": string } (may be empty).\n' +
  '- "proposed": { "entities": ..., "links": ..., optional "commands": [...] } — `commands` may already list structural ops from extraction; you may extend or replace them.\n' +
  '- "introMode": boolean. When true, "userTurn" is the latest **human user** message (**any** language or script). When false, ignore "userTurn" if present.\n' +
  "\n" +
  'Output ONE JSON object: { "entities": [...], "links": [...], "commands": [...] }.\n' +
  'Optional "commands" (array, max 50): **structural** edits the server applies **literally** after your JSON is received. Use them whenever userTurn (or proposed) implies merge, delete node, rename node, delete edge, or move edge — do not rely on notes alone for these.\n' +
  '  • mergeNodes: { "op": "mergeNodes", "from": { "category", "label" }, "into": { "category", "label" } } — first node merged into second (blob merged, edges repointed, first removed).\n' +
  '  • deleteNode: { "op": "deleteNode", "category", "label" } — node and incident edges removed (cannot delete People/User or Interests/Interests hub).\n' +
  '  • renameNode: { "op": "renameNode", "category", "fromLabel", "toLabel" }.\n' +
  '  • deleteEdge: { "op": "deleteEdge", "from": { "category", "label" }, "to": { "category", "label" }, "relation" optional }.\n' +
  '  • moveEdge: { "op": "moveEdge", "relation": string, "oldFrom", "oldTo", "newFrom", "newTo" } — each endpoint { "category", "label" }; old edge removed, new edge inserted.\n' +
  "You may return **commands only** with empty entities/links when the user message is purely a structural instruction.\n" +
  "\n" +
  "**Intro (introMode true):** (A) If userTurn clearly asks to **maintain or correct** the memory graph (add, merge, unify duplicates, relink, fix identity, move facts onto People/\"User\", retract redundancy), you **must** output entities/links and/or **commands** that implement that request against existingNodes — this is non-negotiable for the Keeper. Use proposed as material distilled from that same user text when non-empty; **an empty proposed graph does not excuse skipping** edits that userTurn still demands.\n" +
  "(B) **Profile facts:** When userTurn states **substantive facts** about the person (name, place, work, family, dates, preferences, biography — any language) and is **not** only acknowledgements (thanks/ok/emoji), you **must** output a minimal faithful graph from userTurn **even if proposed.entities and proposed.links are both empty**. Merge new facts into the existing People/\"User\" node when present (append to notes); otherwise emit the correct nodes/links. **Never** return {\"entities\":[],\"links\":[],\"commands\":[]} for such a userTurn solely because the extractor returned an empty proposed pack.\n" +
  "If userTurn is only brief acknowledgement with no new factual content, you may return empty when proposed is also empty.\n" +
  "**Not Intro (introMode false):** Use only proposed + existingNodes. `proposed` was built from **user-only** text (interest sketch); do not enrich it from assistant or model sources.\n" +
  "\n" +
  "Rules (general, any language or domain — do not invent facts):\n" +
  "1) Vs database: if a proposed entity is the same real-world referent as an existing node (translation, transliteration, punctuation, spacing, abbreviations, another script, redundant wording), merge into that node: copy its EXACT \"label\" and \"category\" from existingNodes. In \"notes\" keep only genuinely new facts; omit notes that only repeat the name.\n" +
  "2) Deduplicate among proposed entities the same way.\n" +
  "3) Fix clearly wrong categories using general knowledge (allowed: People, Dates, Cities, Countries, Companies, Projects, Interests, Documents, Data, Other).\n" +
  "4) Links must use final label+category for both ends after 1–3. Drop links to removed duplicates.\n" +
  "5) For Intro/self-profile: merge any proposed speaker identity into the existing anchor People / \"User\" when present; keep that exact label+category. The account holder is one person: merge People nodes that clearly denote the same human (any language, nicknames, transliterations) into one entity; prefer the existing People/\"User\" row from existingNodes when it is the same referent.\n" +
  "6) For Interests, prefer fewer broad umbrella nodes; merge near-duplicates (translations, spelling variants) and attach narrow topics under a broad parent when obvious. When the pack is a **light chat sketch** (broad umbrella + one thread headline), do not spawn extra synonyms for the same dialog theme or same umbrella domain.\n" +
  "7) If nothing remains, return {\"entities\":[],\"links\":[],\"commands\":[]}.\n" +
  "\n" +
  "Output JSON only.";

const INTRO_GRAPH_ALLOWED = new Set([
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

const GRAPH_COMMAND_OPS = new Set(["mergeNodes", "deleteNode", "renameNode", "deleteEdge", "moveEdge"]);

/** @param {unknown} obj */
function normalizeGraphCommandEndpoint(obj) {
  if (!obj || typeof obj !== "object") return null;
  let category = String(obj.category ?? "").trim();
  if (!INTRO_GRAPH_ALLOWED.has(category)) category = "Other";
  const label = String(obj.label ?? "").trim().slice(0, 200);
  if (!label) return null;
  return { category, label };
}

/** @param {unknown} raw */
function normalizeGraphCommands(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const c of raw.slice(0, 50)) {
    if (!c || typeof c !== "object") continue;
    const op = String(c.op ?? "").trim();
    if (!GRAPH_COMMAND_OPS.has(op)) continue;
    if (op === "mergeNodes") {
      const from = normalizeGraphCommandEndpoint(c.from);
      const into = normalizeGraphCommandEndpoint(c.into);
      if (!from || !into) continue;
      if (from.category === into.category && from.label === into.label) continue;
      out.push({ op: "mergeNodes", from, into });
    } else if (op === "deleteNode") {
      let category = String(c.category ?? "").trim();
      if (!INTRO_GRAPH_ALLOWED.has(category)) category = "Other";
      const label = String(c.label ?? "").trim().slice(0, 200);
      if (!label) continue;
      out.push({ op: "deleteNode", category, label });
    } else if (op === "renameNode") {
      let category = String(c.category ?? "").trim();
      if (!INTRO_GRAPH_ALLOWED.has(category)) category = "Other";
      const fromLabel = String(c.fromLabel ?? "").trim().slice(0, 200);
      const toLabel = String(c.toLabel ?? "").trim().slice(0, 200);
      if (!fromLabel || !toLabel || fromLabel === toLabel) continue;
      out.push({ op: "renameNode", category, fromLabel, toLabel });
    } else if (op === "deleteEdge") {
      const from = normalizeGraphCommandEndpoint(c.from);
      const to = normalizeGraphCommandEndpoint(c.to);
      if (!from || !to) continue;
      const relation = c.relation != null ? String(c.relation).trim().slice(0, 200) : "";
      out.push({ op: "deleteEdge", from, to, relation });
    } else if (op === "moveEdge") {
      const oldFrom = normalizeGraphCommandEndpoint(c.oldFrom);
      const oldTo = normalizeGraphCommandEndpoint(c.oldTo);
      const newFrom = normalizeGraphCommandEndpoint(c.newFrom);
      const newTo = normalizeGraphCommandEndpoint(c.newTo);
      if (!oldFrom || !oldTo || !newFrom || !newTo) continue;
      const relation = String(c.relation ?? "").trim().slice(0, 200) || "related";
      out.push({ op: "moveEdge", oldFrom, oldTo, newFrom, newTo, relation });
    }
  }
  return out;
}

/** @param {unknown} raw */
function normalizeIntroGraphExtractPayload(raw) {
  /** @type {{ entities: Array<{ category: string, label: string, notes: string }>, links: Array<{ from: { label: string, category: string }, to: { label: string, category: string }, relation: string }> }} */
  const out = { entities: [], links: [] };
  if (!raw || typeof raw !== "object") return out;
  if (Array.isArray(raw.entities)) {
    for (const e of raw.entities) {
      if (!e || typeof e !== "object") continue;
      let category = String(e.category ?? "").trim();
      if (!INTRO_GRAPH_ALLOWED.has(category)) category = "Other";
      const label = String(e.label ?? "").trim().slice(0, 200);
      const notes = String(e.notes ?? "").trim().slice(0, 4000);
      if (!label) continue;
      out.entities.push({ category, label, notes });
    }
  }
  if (Array.isArray(raw.links)) {
    for (const ln of raw.links) {
      if (!ln || typeof ln !== "object") continue;
      const from = ln.from;
      const to = ln.to;
      if (!from || !to || typeof from !== "object" || typeof to !== "object") continue;
      let fc = String(from.category ?? "").trim();
      if (!INTRO_GRAPH_ALLOWED.has(fc)) fc = "Other";
      const fl = String(from.label ?? "").trim().slice(0, 200);
      let tc = String(to.category ?? "").trim();
      if (!INTRO_GRAPH_ALLOWED.has(tc)) tc = "Other";
      const tl = String(to.label ?? "").trim().slice(0, 200);
      if (!fl || !tl) continue;
      const relation = String(ln.relation ?? "").trim().slice(0, 200) || "related";
      out.links.push({
        from: { label: fl, category: fc },
        to: { label: tl, category: tc },
        relation,
      });
    }
  }
  return out;
}

/** @param {string} text */
function parseIntroGraphJsonFromModelText(text) {
  let s = String(text ?? "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const j = JSON.parse(s);
  const base = normalizeIntroGraphExtractPayload(j);
  const commands = normalizeGraphCommands(j.commands);
  return { ...base, commands };
}

/** @param {string} text @param {string} [logTag] */
function parseIntroGraphJsonFromModelTextSafe(text, logTag = "API-turn graph") {
  try {
    return parseIntroGraphJsonFromModelText(text);
  } catch (e) {
    console.warn(
      `[${logTag}] JSON parse failed:`,
      e instanceof Error ? e.message : String(e),
      String(text ?? "").slice(0, 400),
    );
    return { entities: [], links: [], commands: [] };
  }
}

/**
 * @param {{ entities: Array<{ category: string, label: string, notes: string }>, links: Array<{ from: { label: string, category: string }, to: { label: string, category: string }, relation: string }>, commands?: unknown[] }} pack
 */
function clampGraphPayloadToInterestsOnly(pack) {
  const c = "Interests";
  return {
    entities: pack.entities.map((e) => ({ ...e, category: c })),
    links: pack.links.map((ln) => ({
      relation: ln.relation,
      from: { label: ln.from.label, category: c },
      to: { label: ln.to.label, category: c },
    })),
    commands: [],
  };
}

/** @param {unknown} content */
function openAiChatCompletionMessageContentToString(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const x of content) {
      if (!x || typeof x !== "object") continue;
      if (typeof x.text === "string" && x.text.length > 0) parts.push(x.text);
    }
    return parts.join("\n");
  }
  if (typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function oaMaxCompletionTokens(n) {
  return { max_completion_tokens: Math.max(1, Math.floor(Number(n) || 1)) };
}

function pickOpenAiKey() {
  const a = String(process.env.MF_LAB_MEMORY_GRAPH_KEEPER_OPENAI_KEY ?? "").trim();
  if (a) return a;
  return String(process.env.OPENAI_API_KEY ?? "").trim();
}

function pickOpenAiModel() {
  const m = String(process.env.MF_LAB_MEMORY_GRAPH_OPENAI_MODEL ?? "").trim();
  if (m) return m;
  const m2 = String(process.env.OPENAI_DIALOGUE_MODEL ?? "").trim();
  if (m2) return m2;
  return "gpt-4o-mini";
}

/** @param {import("better-sqlite3").Database} db */
function loadMemoryGraphExistingNodes(db) {
  const rows = db.prepare(`SELECT id, category, label FROM memory_graph_nodes`).all();
  return rows
    .map((r) => ({
      id: String(r?.id ?? ""),
      category: String(r?.category ?? "").trim(),
      label: String(r?.label ?? "").trim().slice(0, 200),
    }))
    .filter((n) => n.id && n.category && n.label)
    .slice(0, 800);
}

/**
 * @param {string} apiKey
 * @param {string} model
 * @param {string} userText
 */
async function openAiInterestExtract(apiKey, model, userText) {
  const u = String(userText ?? "").trim().slice(0, 8000);
  const userBlock = `USER:\n${u}`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.12,
      ...oaMaxCompletionTokens(900),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CHAT_INTEREST_SKETCH_EXTRACT_SYSTEM },
        { role: "user", content: userBlock },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI extract ${res.status}: ${errText.slice(0, 500)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  const rawText = openAiChatCompletionMessageContentToString(content);
  if (!rawText.trim()) throw new Error("Empty OpenAI extract response");
  const parsed = parseIntroGraphJsonFromModelTextSafe(rawText, "interests_sketch");
  return clampGraphPayloadToInterestsOnly(parsed);
}

/**
 * @param {string} apiKey
 * @param {string} model
 * @param {{ entities: unknown[], links: unknown[], commands?: unknown[] }} proposed
 * @param {Array<{ id: string, category: string, label: string }>} existingNodes
 */
async function openAiNormalizeNotIntro(apiKey, model, proposed, existingNodes) {
  const rawProp = proposed && typeof proposed === "object" ? proposed : {};
  const base = normalizeIntroGraphExtractPayload(rawProp);
  const fromExtract = normalizeGraphCommands(rawProp.commands);
  if (base.entities.length === 0 && base.links.length === 0 && fromExtract.length === 0) {
    return { ...base, commands: [] };
  }

  /** @type {{ entities: typeof base.entities, links: typeof base.links, commands?: unknown[] }} */
  const proposedForLlm = { entities: base.entities, links: base.links };
  if (fromExtract.length > 0) proposedForLlm.commands = fromExtract;

  const userJson = JSON.stringify({
    existingNodes: existingNodes,
    proposed: proposedForLlm,
    introMode: false,
  });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      ...oaMaxCompletionTokens(12000),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: INTRO_GRAPH_NORMALIZE_SYSTEM },
        { role: "user", content: userJson },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI normalize ${res.status}: ${errText.slice(0, 500)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  const rawText = openAiChatCompletionMessageContentToString(content);
  if (!rawText.trim()) throw new Error("Empty OpenAI normalize response");
  const normalized = parseIntroGraphJsonFromModelTextSafe(rawText, "memory_graph_normalize");
  const n =
    normalized.entities.length + normalized.links.length + (normalized.commands?.length ?? 0);
  if (n > 0) return normalized;
  return { ...base, commands: fromExtract };
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {(body: { entities: unknown[]; links: unknown[]; commands: unknown[] }) => unknown} ingest
 * @param {string} userText
 */
async function runMemoryGraphKeeperIngestForChatApiTurn(db, ingest, userText) {
  const apiKey = pickOpenAiKey();
  if (!apiKey) {
    console.warn("[mf-lab-api] memory-graph API-turn keeper: set OPENAI_API_KEY or MF_LAB_MEMORY_GRAPH_KEEPER_OPENAI_KEY");
    return;
  }
  const model = pickOpenAiModel();
  const u = String(userText ?? "").trim();
  if (!u) return;

  const extracted = await openAiInterestExtract(apiKey, model, u);
  if (extracted.entities.length === 0 && extracted.links.length === 0) return;

  const existingNodes = loadMemoryGraphExistingNodes(db);
  let pack = extracted;
  try {
    pack = await openAiNormalizeNotIntro(apiKey, model, extracted, existingNodes);
  } catch (normErr) {
    console.warn(
      "[mf-lab-api] memory-graph API-turn keeper: normalize failed, using extract-only pack:",
      normErr instanceof Error ? normErr.message : String(normErr),
    );
    pack = extracted;
  }

  const cmdLen = Array.isArray(pack.commands) ? pack.commands.length : 0;
  if (pack.entities.length === 0 && pack.links.length === 0 && cmdLen === 0) return;

  ingest({
    entities: pack.entities ?? [],
    links: pack.links ?? [],
    commands: pack.commands ?? [],
  });
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {(body: { entities: unknown[]; links: unknown[]; commands: unknown[] }) => unknown} ingest
 * @param {string} userText
 */
export function scheduleMemoryGraphKeeperIngestForChatApiTurn(db, ingest, userText) {
  void runMemoryGraphKeeperIngestForChatApiTurn(db, ingest, userText).catch((e) => {
    console.error("[mf-lab-api] memory-graph API-turn keeper:", e instanceof Error ? e.message : String(e));
  });
}

/**
 * @param {unknown} body
 * @returns {boolean}
 */
export function shouldRunMemoryGraphKeeperForApiTurnBody(body) {
  const v = body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body).run_memory_graph_keeper : null;
  if (v === true || v === 1) return true;
  if (typeof v === "string" && ["1", "true", "yes"].includes(v.trim().toLowerCase())) return true;
  const envRaw = String(process.env.MF_LAB_MEMORY_GRAPH_ON_API_TURNS ?? "").trim().toLowerCase();
  return ["1", "true", "yes"].includes(envRaw);
}
