/**
 * Memory Tree Keeper pipeline — post-turn augmentation.
 *
 * Exports:
 *   - Individual extractor functions (Intro, Chat, Access, Rules) used by the server and tests.
 *   - runKeepersAfterTurn() — full post-turn orchestration, called from the chat submit handler.
 */

import { callLlm } from "./llmGateway.js";
import { dialogueModel } from "./chatApi.js";
import {
  apiHealth,
  fetchMemoryGraphFromApi,
  ingestMemoryGraphPayload,
  fetchTurns,
  fetchAccessExternalServices,
  putAccessExternalServices,
  fetchRulesKeeperBundle,
  mergeRulesKeeperPatch,
} from "./chatPersistence.js";
import {
  mergeAccessExternalServiceEntries,
  rulesKeeperExistingSummaryForExtract,
  mergeRulesKeeperClientPatches,
} from "./accessRulesKeeperHelpers.js";
import { getModelApiKeys } from "./modelEnv.js";
import { getChatAnalysisPriority } from "./chatAnalysisPriority.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const INTRO_GRAPH_EXTRACT_OPENAI_MAX_TOKENS = 12000;
const INTRO_GRAPH_NORMALIZE_OPENAI_MAX_TOKENS = 12000;

/** One-line trivial acknowledgements (EN + common RU replies as Unicode escapes; ASCII-only source). */
const TRIVIAL_ACK_LINE_RE =
  /^(thanks|thank you|thx|ok|okay|yes|no|спасибо|ок|да|нет|понял|поняла|ясно)\b[!.\s]*$/iu;

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

const RULES_KEEPER3_ITEM_MAX = 4000;
const ACCESS_KEEPER_NOTES_MAX = 12000;

// ─── Intro graph helpers ──────────────────────────────────────────────────────

/**
 * @param {unknown} obj
 * @returns {{ category: string, label: string } | null}
 */
function normalizeGraphCommandEndpoint(obj) {
  if (!obj || typeof obj !== "object") return null;
  let category = String(/** @type {any} */ (obj).category ?? "").trim();
  if (!INTRO_GRAPH_ALLOWED.has(category)) category = "Other";
  const label = String(/** @type {any} */ (obj).label ?? "").trim().slice(0, 200);
  if (!label) return null;
  return { category, label };
}

/**
 * Server applies the same subset after validation in api.mjs.
 * @param {unknown} raw
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeGraphCommands(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const c of raw.slice(0, 50)) {
    if (!c || typeof c !== "object") continue;
    const op = String(/** @type {any} */ (c).op ?? "").trim();
    if (!GRAPH_COMMAND_OPS.has(op)) continue;
    if (op === "mergeNodes") {
      const from = normalizeGraphCommandEndpoint(/** @type {any} */ (c).from);
      const into = normalizeGraphCommandEndpoint(/** @type {any} */ (c).into);
      if (!from || !into) continue;
      if (from.category === into.category && from.label === into.label) continue;
      out.push({ op: "mergeNodes", from, into });
    } else if (op === "deleteNode") {
      let category = String(/** @type {any} */ (c).category ?? "").trim();
      if (!INTRO_GRAPH_ALLOWED.has(category)) category = "Other";
      const label = String(/** @type {any} */ (c).label ?? "").trim().slice(0, 200);
      if (!label) continue;
      out.push({ op: "deleteNode", category, label });
    } else if (op === "renameNode") {
      let category = String(/** @type {any} */ (c).category ?? "").trim();
      if (!INTRO_GRAPH_ALLOWED.has(category)) category = "Other";
      const fromLabel = String(/** @type {any} */ (c).fromLabel ?? "").trim().slice(0, 200);
      const toLabel = String(/** @type {any} */ (c).toLabel ?? "").trim().slice(0, 200);
      if (!fromLabel || !toLabel || fromLabel === toLabel) continue;
      out.push({ op: "renameNode", category, fromLabel, toLabel });
    } else if (op === "deleteEdge") {
      const from = normalizeGraphCommandEndpoint(/** @type {any} */ (c).from);
      const to = normalizeGraphCommandEndpoint(/** @type {any} */ (c).to);
      if (!from || !to) continue;
      const relation = /** @type {any} */ (c).relation != null ? String(/** @type {any} */ (c).relation).trim().slice(0, 200) : "";
      out.push({ op: "deleteEdge", from, to, relation });
    } else if (op === "moveEdge") {
      const oldFrom = normalizeGraphCommandEndpoint(/** @type {any} */ (c).oldFrom);
      const oldTo = normalizeGraphCommandEndpoint(/** @type {any} */ (c).oldTo);
      const newFrom = normalizeGraphCommandEndpoint(/** @type {any} */ (c).newFrom);
      const newTo = normalizeGraphCommandEndpoint(/** @type {any} */ (c).newTo);
      if (!oldFrom || !oldTo || !newFrom || !newTo) continue;
      const relation = String(/** @type {any} */ (c).relation ?? "").trim().slice(0, 200) || "related";
      out.push({ op: "moveEdge", oldFrom, oldTo, newFrom, newTo, relation });
    }
  }
  return out;
}

// ─── System prompts ───────────────────────────────────────────────────────────

const INTRO_GRAPH_EXTRACT_SYSTEM =
  'You are the **Keeper** — the Intro step that prepares memory-tree updates. **Only the human user\'s words matter.** Do **not** use, summarize, or infer from any assistant/model text — you will receive **user text only**.\n' +
  'You extract a small knowledge graph from the USER\'s **latest message alone** in the Intro onboarding chat.\n' +
  "**Every** user message counts: whenever the user states a fact, names something, or gives a **graph command** (add/merge/fix/remove/relink — any language), reflect it in entities/links for this turn.\n" +
  "Treat **each** USER turn as important: extract **every** graph-worthy fact from **this** turn (not only generic chit-chat).\n" +
  "**Anti-clones:** never emit two entities that are the same real-world thing under trivial label variants (same country, city, person, or topic twice in one payload). One canonical short label per referent.\n" +
  'Return ONE JSON object with keys "entities", "links", and optional "commands".\n' +
  '"entities": array of { "category": string, "label": string, "notes": string }.\n' +
  '"links": array of { "from": { "label": string, "category": string }, "to": { "label": string, "category": string }, "relation": string }.\n' +
  '"commands" (optional): structural operations the server runs exactly — mergeNodes, deleteNode, renameNode, deleteEdge, moveEdge — same field shapes as in the normalize system message (use exact op names and category+label endpoints).\n' +
  '- "category" must be exactly one of: People, Dates, Cities, Countries, Companies, Projects, Interests, Documents, Data, Other.\n' +
  '- For "People": label = given name and family name if known, or given name only; notes = role/relation in one clause.\n' +
  '- For People/"User" node: label must be exactly "User" (existing anchor for the account holder in any language).\n' +
  '- "label" must be SHORT for other graph nodes: People (other than User) = given name and family name if both known; Dates = ISO date or a very short date-like phrase; Cities = city name only; Countries = country name only; Companies = company name; Projects = project title; otherwise a short noun phrase (max ~48 characters).\n' +
  '- "category" must be exactly one of: People, Dates, Cities, Countries, Companies, Projects, Interests, Documents, Data, Other.\n' +
  "- Extract only facts the USER clearly states or clearly implies; do not invent.\n" +
  '- "notes": one short factual clause grounded in the user message (may echo context).\n' +
  '- "links" only when the user clearly relates two of your entities; "relation": brief verb phrase (e.g. "works at", "lives in", "born on"). Prefer linking new entities to "User" when the fact is about the user.\n' +
  '- **Shows / series / films / games / IPs:** Each **named production** the user cites (animated series, game tie-in show, franchise title in any language) → one **Projects** node with a short canonical **label** (official title or best-known short name) and factual **notes**; link **User** → that project (e.g. "worked on", "contributed to", "conceived format for"). If they name a **studio or employer**, use **Companies** and link User → Company and optionally Company → Project.\n' +
  '- For category "Interests" in Intro, use only BROAD umbrella labels (1–3 words, e.g. "Astronomy" not a minor celestial body name); link them to the hub { "category": "Interests", "label": "Interests" } with relation "under" when such a hub appears in your output.\n' +
  '- If the USER asks to **add, remove, merge, relink, or fix** something in the memory graph, in **any language or writing system**, output entities and links that express that request so it can be applied — do not return empty only because the wording was not in English.\n' +
  '- If nothing graph-worthy in this turn: {"entities":[],"links":[],"commands":[]}.\n' +
  "Output JSON only.";

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

const ACCESS_KEEPER2_EXTRACT_SYSTEM =
  "You are **Keeper 2** for the **Access** section of the app.\n" +
  "You read the **full conversation** (USER and ASSISTANT lines) in the Access thread.\n" +
  "Your job: extract **third-party** services the human is configuring — HTTP APIs, hosted inference or media pipelines, async job/queue endpoints, geocoding, weather, and **their** API keys, tokens, or auth headers the user stated (e.g. `Authorization: Key …`, `Bearer …`).\n" +
  "Put the secret material in `accessKey` when it is a key/token/header value; put base URLs, queue URLs, or doc links in `endpointUrl` when that fits.\n" +
  "**Markdown / bullet inventories:** If the user pastes a **list** of public data APIs (lines with `•`, `-`, em-dash `—`, service name + **domain or URL** + short blurb), treat **each distinct service** as one `entries` row. Use `https://…` in `endpointUrl` when the user gave only a hostname (e.g. `api.example.com/v1` → `https://api.example.com/v1`). `accessKey` may be empty for free/no-key APIs. Put the original line or extra hints in `notes` when helpful.\n" +
  "**Never** extract or invent: OpenAI / Anthropic / Google Gemini / Perplexity keys, this app's `.env` layout, or internal LLM routing — only **external** products the user named.\n" +
  "If the user clearly added or updated one or more third-party services (including a bulk list) in the last turns, you **must** output a non-empty `entries` array with one object per distinct service you can tie to a name and/or URL — do **not** return {\"entries\":[]} out of caution.\n" +
  "If this turn truly adds nothing identifiable (no names, no domains, no URLs), return {\"entries\":[]}.\n" +
  "When updating an existing service (see EXISTING_STORE_SUMMARY_JSON), reuse the same short **name** so records can merge.\n" +
  'Output **one** JSON object: { "entries": [ { "name": string, "description": string, "endpointUrl": string, "accessKey": string, "notes": string } ] }.\n' +
  "- `name`: short unique title for the service (user language).\n" +
  "- `description`: what the service is for (one or two sentences).\n" +
  "- `endpointUrl`: base URL, queue URL, or primary endpoint; empty string only if none given.\n" +
  "- `accessKey`: API key, token, or literal `Authorization: …` line for **that** external service only; empty string only if none mentioned.\n" +
  "- `notes`: optional long text (examples, sample HTTP requests, vendor-specific headers or flags the user mentioned, model lists, warnings) copied or summarized from the conversation — **not** a substitute for putting secrets in `accessKey` when they are explicit.\n" +
  "At most **32** entries per response; if the user pasted many services in one message, include as many distinct rows as fit (up to 32), prioritizing clearly named URLs/keys from the latest user turns.\n" +
  "Output JSON only, no markdown fences.";

const RULES_KEEPER3_EXTRACT_SYSTEM =
  "You are a **background Rules extractor** for this app (not shown to the user).\n" +
  "The user payload has **Section A**: every **USER** message from the Rules thread, oldest first, each in its own block. " +
  "In Rules, **each** of those messages must be **evaluated**: does it add, change, or remove project conduct for assistants? " +
  "If it is **only** thanks, ok, emoji, or empty acknowledgement with **no** new normative content, emit **nothing** from that block. " +
  "Otherwise extract — even one short sentence can yield one or more atomic rules. Do **not** skip a block because it is brief.\n" +
  "**Section B** is the full USER+ASSISTANT thread for disambiguation only; never invent rules from assistant text alone unless the user clearly adopted it in their own words.\n" +
  "Classify each extracted rule into exactly one bucket:\n" +
  "- **core_rules**: universal behavior, tone, honesty, length, language.\n" +
  "- **private_rules**: personal preferences and boundaries (addressing, disclosure, style).\n" +
  "- **forbidden_actions**: explicit prohibitions (must **never** do).\n" +
  "- **workflow_rules**: ordered steps, checklists, or process to follow when answering.\n" +
  "Only extract what the **user** stated or clearly implied; do **not** invent policies.\n" +
  "If the **last** Section A block clearly states new conduct, you should normally output at least one new string (unless it is purely non-normative as above).\n" +
  "If the user wrote a **numbered list, bullet list, or line-by-line** rules (each line a separate rule), you **must** emit **at least one string per substantive line** (map lines to the best bucket); do **not** return all-empty out of caution.\n" +
  "EXISTING_STORE_SUMMARY_JSON lists snippets already stored per bucket — avoid duplicates (same meaning).\n" +
  'Output **one** JSON object only, no markdown fences:\n' +
  '{ "core_rules": string[], "private_rules": string[], "forbidden_actions": string[], "workflow_rules": string[] }\n' +
  "Each string is one atomic rule (one sentence or short phrase). At most **36** new strings **total** across all four arrays for this response.";

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

// ─── Access Keeper helpers ────────────────────────────────────────────────────

/**
 * @param {unknown} raw
 * @returns {Array<{ name: string, description: string, endpointUrl: string, accessKey: string, notes: string }>}
 */
function normalizeAccessKeeperEntriesFromRaw(raw) {
  /** @type {Array<{ name: string, description: string, endpointUrl: string, accessKey: string, notes: string }>} */
  const out = [];
  if (!raw || typeof raw !== "object") return out;
  const arr = Array.isArray(/** @type {any} */ (raw).entries) ? /** @type {any} */ (raw).entries : [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const name = String(/** @type {any} */ (e).name ?? "").trim().slice(0, 200);
    if (!name) continue;
    out.push({
      name,
      description: String(/** @type {any} */ (e).description ?? "").trim().slice(0, 2000),
      endpointUrl: String(/** @type {any} */ (e).endpointUrl ?? /** @type {any} */ (e).endpoint_or_url ?? "").trim().slice(0, 2000),
      accessKey: String(/** @type {any} */ (e).accessKey ?? /** @type {any} */ (e).access_key ?? /** @type {any} */ (e).credential ?? "").trim().slice(0, 2000),
      notes: String(/** @type {any} */ (e).notes ?? "").trim().slice(0, ACCESS_KEEPER_NOTES_MAX),
    });
  }
  return out.slice(0, 32);
}

/** Strip leading bullets / numbering from a list line. */
function stripAccessListLinePrefix(s) {
  return String(s ?? "")
    .replace(/^[\s•‣●◦▪\*—–\-]+(?:\d{1,2}[\.\)])?\s*/u, "")
    .trim();
}

/**
 * When the LLM extractor returns nothing, infer rows from a **bulk paste**: lines like
 * `• Name — host.com/path — description` (em dash) or lines containing `https://…` / a plausible hostname.
 * @param {string} text — usually the latest user message in Access
 * @returns {Array<{ name: string, description: string, endpointUrl: string, accessKey: string, notes: string }>}
 */
export function extractAccessExternalServiceStubsFromBulkListText(text) {
  const raw = String(text ?? "").trim();
  if (raw.length < 24) return [];
  const seen = new Set();
  /** @type {Array<{ name: string, description: string, endpointUrl: string, accessKey: string, notes: string }>} */
  const out = [];
  const dashSplit = /\s*[—–]\s*/;
  /** @param {string} line */
  const splitListLine = (line) => {
    const parts = line.split(dashSplit).map((p) => p.trim()).filter(Boolean);
    return parts.length >= 2 ? parts : null;
  };
  const urlRe = /https?:\/\/[^\s\])"']+/i;
  const domainRe = /\b([a-z0-9][a-z0-9\-]{2,}\.)+(?:com|io|ai|dev|org|net|co|app|cloud|api|run|tech)\b(?:\/[^\s]*)?\/?/i;
  const hostRe = /\b([a-z0-9][a-z0-9\-]{1,}\.(?:com|io|ai|dev|org|net|co|app|cloud|api|run|tech))\b/i;
  const bulletRe = /^[\s•‣●◦▪\*—–\-•]+/;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.length < 8) continue;
    const stripped = line.replace(bulletRe, "").trim();
    if (!stripped) continue;
    const parts = splitListLine(stripped);
    let name = "";
    let description = "";
    let endpointUrl = "";

    if (parts && parts.length >= 2) {
      name = stripAccessListLinePrefix(parts[0]).slice(0, 200);
      const rest = parts.slice(1).join(" — ");
      const urlM = urlRe.exec(rest);
      const domM = !urlM ? domainRe.exec(rest) : null;
      if (urlM) {
        endpointUrl = urlM[0];
        description = rest.replace(urlM[0], "").replace(dashSplit, " ").trim().slice(0, 600);
      } else if (domM) {
        const rawDom = domM[0].replace(/[.,;:'")\]]+$/, "").trim();
        endpointUrl = rawDom.startsWith("http") ? rawDom : `https://${rawDom}`;
        description = rest.replace(domM[0], "").replace(dashSplit, " ").trim().slice(0, 600);
      } else {
        description = rest.trim().slice(0, 600);
      }
    } else {
      const urlM = urlRe.exec(stripped);
      const domM = !urlM ? domainRe.exec(stripped) : null;
      if (urlM) {
        endpointUrl = urlM[0];
        const before = stripped.slice(0, urlM.index).trim();
        const after = stripped.slice(urlM.index + urlM[0].length).trim();
        name = stripAccessListLinePrefix(before || after).slice(0, 200);
        description = (before && after ? `${before} ${after}` : before || after).trim().slice(0, 600);
        if (!name) {
          try {
            name = new URL(endpointUrl).hostname.slice(0, 200);
          } catch {
            name = "API";
          }
        }
      } else if (domM) {
        const rawDom = domM[0].replace(/[.,;:'")\]]+$/, "").trim();
        endpointUrl = rawDom.startsWith("http") ? rawDom : `https://${rawDom}`;
        const before = stripped.slice(0, domM.index).trim();
        const after = stripped.slice(domM.index + domM[0].length).trim();
        name = stripAccessListLinePrefix(before || after).slice(0, 200);
        if (!name) {
          const hostM = hostRe.exec(endpointUrl);
          name = (hostM ? hostM[0] : endpointUrl).slice(0, 200);
        }
        description = (before && after ? `${before} ${after}` : before || after).trim().slice(0, 600);
      } else {
        continue;
      }
    }
    if (!name) continue;
    if (!description) description = line.slice(0, 600).trim().slice(0, 2000);

    out.push({
      name,
      description,
      endpointUrl,
      accessKey: "",
      notes: line.slice(0, Math.min(line.length, ACCESS_KEEPER_NOTES_MAX)),
    });
    if (out.length >= 48) break;
  }

  return out.filter((row) => {
    const key = (row.name + row.endpointUrl).toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 32);
}

/**
 * @param {string} text
 * @returns {{ entries: Array<{ name: string, description: string, endpointUrl: string, accessKey: string }> }}
 */
function parseAccessKeeperJsonFromModelText(text) {
  try {
    let s = String(text ?? "").trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const j = JSON.parse(s);
    return { entries: normalizeAccessKeeperEntriesFromRaw(j) };
  } catch (e) {
    console.warn(
      "[Access Keeper 2] JSON parse failed:",
      e instanceof Error ? e.message : String(e),
      String(text ?? "").slice(0, 240),
    );
    return { entries: [] };
  }
}

// ─── Rules Keeper helpers ─────────────────────────────────────────────────────

/**
 * @param {unknown} raw
 * @returns {{ core_rules: string[], private_rules: string[], forbidden_actions: string[], workflow_rules: string[] }}
 */
function normalizeRulesKeeper3Patch(raw) {
  const empty = { core_rules: [], private_rules: [], forbidden_actions: [], workflow_rules: [] };
  if (!raw || typeof raw !== "object") return empty;
  /** @param {unknown} v */
  const asList = (v) => {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const x of v) {
      const s = typeof x === "string" ? x.trim() : String(/** @type {any} */ (x)?.text ?? "").trim();
      if (s.length >= 2) out.push(s.slice(0, RULES_KEEPER3_ITEM_MAX));
    }
    return out.slice(0, 32);
  };
  const j = /** @type {Record<string, unknown>} */ (raw);
  const patch = {
    core_rules: asList(j.core_rules),
    private_rules: asList(j.private_rules),
    forbidden_actions: asList(j.forbidden_actions),
    workflow_rules: asList(j.workflow_rules),
  };
  let budget = 36;
  /** @param {string[]} arr */
  const capArr = (arr) => {
    const out = [];
    for (const s of arr) {
      if (budget <= 0) break;
      out.push(s);
      budget -= 1;
    }
    return out;
  };
  return {
    core_rules: capArr(patch.core_rules),
    private_rules: capArr(patch.private_rules),
    forbidden_actions: capArr(patch.forbidden_actions),
    workflow_rules: capArr(patch.workflow_rules),
  };
}

/**
 * @param {string} text
 */
function parseRulesKeeper3JsonFromModelText(text) {
  try {
    let s = String(text ?? "").trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const j = JSON.parse(s);
    return normalizeRulesKeeper3Patch(j);
  } catch (e) {
    console.warn(
      "[Rules extract] JSON parse failed:",
      e instanceof Error ? e.message : String(e),
      String(text ?? "").slice(0, 240),
    );
    return { core_rules: [], private_rules: [], forbidden_actions: [], workflow_rules: [] };
  }
}

// ─── Intro graph normalizer helpers ──────────────────────────────────────────

/**
 * @param {unknown} raw
 * @returns {{ entities: Array<{ category: string, label: string, notes: string }>, links: Array<{ from: { label: string, category: string }, to: { label: string, category: string }, relation: string }> }}
 */
function normalizeIntroGraphExtractPayload(raw) {
  /** @type {{ entities: Array<{ category: string, label: string, notes: string }>, links: Array<{ from: { label: string, category: string }, to: { label: string, category: string }, relation: string }> }} */
  const out = { entities: [], links: [] };
  if (!raw || typeof raw !== "object") return out;
  const r = /** @type {any} */ (raw);
  if (Array.isArray(r.entities)) {
    for (const e of r.entities) {
      if (!e || typeof e !== "object") continue;
      let category = String(e.category ?? "").trim();
      if (!INTRO_GRAPH_ALLOWED.has(category)) category = "Other";
      const label = String(e.label ?? "").trim().slice(0, 200);
      const notes = String(e.notes ?? "").trim().slice(0, 4000);
      if (!label) continue;
      out.entities.push({ category, label, notes });
    }
  }
  if (Array.isArray(r.links)) {
    for (const ln of r.links) {
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

/**
 * @param {string} text
 */
function parseIntroGraphJsonFromModelText(text) {
  let s = String(text ?? "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const j = JSON.parse(s);
  const base = normalizeIntroGraphExtractPayload(j);
  const commands = normalizeGraphCommands(/** @type {any} */ (j).commands);
  return { ...base, commands };
}

/**
 * Same as {@link parseIntroGraphJsonFromModelText} but never throws (truncated/invalid JSON from model).
 * @param {string} text
 * @param {string} [logTag]
 */
function parseIntroGraphJsonFromModelTextSafe(text, logTag = "Intro graph") {
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
 * Clamp a graph payload to Interests-only entities/links (for chat keeper).
 * @param {{ entities: Array<{ category: string, label: string, notes: string }>, links: Array<{ from: { label: string, category: string }, to: { label: string, category: string }, relation: string }> }} pack
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

// ─── Exported extractor functions ─────────────────────────────────────────────

/**
 * When the LLM extractor returns nothing: split the **latest** user message into candidate rules
 * (bullets, numbering, one rule per line). Puts probable prohibitions into `forbidden_actions`.
 * @param {string} text — usually the last user message in Rules
 * @returns {{ core_rules: string[], private_rules: string[], forbidden_actions: string[], workflow_rules: string[] }}
 */
export function extractRulesListStubsFromUserText(text) {
  const raw = String(text ?? "").trim();
  const empty = { core_rules: [], private_rules: [], forbidden_actions: [], workflow_rules: [] };
  if (raw.length < 6) return empty;

  /** No bare `don't` — it matches style tips ("don't waffle") that belong in core, not prohibitions. */
  const forbiddenRe =
    /\b(never|must not|mustn't|do not|cannot|can't|forbidden|prohibit|no\s+\w+\s+allowed)\b/i;
  /** @type {string[]} */
  const core = [];
  /** @type {string[]} */
  const forbidden = [];
  const seen = new Set();

  const pushUnique = (arr, line) => {
    const t = line.replace(/\s+/g, " ").trim().slice(0, RULES_KEEPER3_ITEM_MAX);
    if (t.length < 4) return;
    const k = t.toLowerCase().slice(0, 400);
    if (seen.has(k)) return;
    seen.add(k);
    arr.push(t);
  };

  const stripLead = (s) =>
    String(s ?? "")
      .replace(
        /^[\s•‣●◦▪⁃—–\-*]+(?:\d{1,3}[.):）]\s*)?/u,
        "",
      )
      .trim();

  for (const line0 of raw.split(/\r?\n/)) {
    let line = stripLead(line0);
    if (line.length < 6) continue;
    if (TRIVIAL_ACK_LINE_RE.test(line)) continue;
    if (forbiddenRe.test(line)) pushUnique(forbidden, line);
    else pushUnique(core, line);
    if (core.length + forbidden.length >= 36) break;
  }

  if (core.length === 0 && forbidden.length === 0 && raw.length >= 12 && !raw.includes("\n")) {
    const parts = raw.split(/[;；]\s*/).map((p) => stripLead(p)).filter((p) => p.length >= 8);
    for (const p of parts.slice(0, 20)) {
      if (forbiddenRe.test(p)) pushUnique(forbidden, p);
      else pushUnique(core, p);
      if (core.length + forbidden.length >= 36) break;
    }
  }

  if (core.length === 0 && forbidden.length === 0) {
    const one = raw.replace(/\s+/g, " ").trim();
    if (one.length >= 8 && !TRIVIAL_ACK_LINE_RE.test(one)) {
      if (forbiddenRe.test(one)) pushUnique(forbidden, one);
      else pushUnique(core, one);
    }
  }

  return {
    core_rules: core,
    private_rules: [],
    forbidden_actions: forbidden,
    workflow_rules: [],
  };
}

/**
 * Keeper 2: structured external-service rows from the Access thread transcript.
 * @param {string} providerId
 * @param {string} apiKey
 * @param {string} transcript
 * @param {string} existingSummaryJson
 * @param {{ dialog_id?: string, conversation_turn_id?: string }} [analytics]
 */
export async function extractAccessKeeper2EntriesFromTranscript(
  providerId,
  apiKey,
  transcript,
  existingSummaryJson,
  analytics = {},
) {
  const key = String(apiKey ?? "").trim();
  const t = String(transcript ?? "").trim().slice(0, 72000);
  if (!key || !t) return { entries: [] };
  const ex = String(existingSummaryJson ?? "").trim().slice(0, 12000);
  const userBlock = `EXISTING_STORE_SUMMARY_JSON:\n${ex || "[]"}\n\nCONVERSATION:\n${t}`;
  const system = `${ACCESS_KEEPER2_EXTRACT_SYSTEM}\nRespond with a single JSON object only, no markdown fences.`;
  try {
    const { text } = await callLlm({
      provider: providerId,
      key,
      model: dialogueModel(providerId),
      messages: [{ role: "user", content: userBlock }],
      system,
      temperature: 0.1,
      maxTokens: 12000,
      responseFormat: providerId === "openai" ? { type: "json_object" } : undefined,
      requestKind: "access_keeper2_extract",
      analytics,
      promptBasis: userBlock,
    });
    return parseAccessKeeperJsonFromModelText(text);
  } catch (e) {
    console.warn("[Access Keeper 2] extract request failed:", e instanceof Error ? e.message : String(e));
    return { entries: [] };
  }
}

/**
 * Rules thread: classify user-stated rules into four buckets (merged on disk by the API).
 * @param {string} providerId
 * @param {string} apiKey
 * @param {string} transcript
 * @param {string} existingSummaryJson
 * @param {{ dialog_id?: string, conversation_turn_id?: string }} [analytics]
 */
export async function extractRulesKeeper3FromTranscript(
  providerId,
  apiKey,
  transcript,
  existingSummaryJson,
  analytics = {},
) {
  const key = String(apiKey ?? "").trim();
  const t = String(transcript ?? "").trim().slice(0, 72000);
  if (!key || !t) return { core_rules: [], private_rules: [], forbidden_actions: [], workflow_rules: [] };
  const ex = String(existingSummaryJson ?? "").trim().slice(0, 12000);
  const userBlock = `EXISTING_STORE_SUMMARY_JSON:\n${ex || "{}"}\n\nEXTRACTOR_INPUT:\n${t}`;
  const system = `${RULES_KEEPER3_EXTRACT_SYSTEM}\nRespond with a single JSON object only, no markdown fences.`;
  try {
    const { text } = await callLlm({
      provider: providerId,
      key,
      model: dialogueModel(providerId),
      messages: [{ role: "user", content: userBlock }],
      system,
      temperature: 0.1,
      maxTokens: 8000,
      responseFormat: providerId === "openai" ? { type: "json_object" } : undefined,
      requestKind: "rules_keeper_extract",
      analytics,
      promptBasis: userBlock,
    });
    return parseRulesKeeper3JsonFromModelText(text);
  } catch (e) {
    console.warn("[Rules extract] request failed:", e instanceof Error ? e.message : String(e));
    return { core_rules: [], private_rules: [], forbidden_actions: [], workflow_rules: [] };
  }
}

/**
 * From a normal chat: one broad interest umbrella + one thread headline from **one** user message.
 * @param {string} providerId
 * @param {string} apiKey
 * @param {string} userText
 * @param {{ dialog_id?: string, conversation_turn_id?: string }} [analytics]
 */
export async function extractChatInterestSketchForIngest(providerId, apiKey, userText, analytics = {}) {
  const key = String(apiKey ?? "").trim();
  const u = String(userText ?? "").trim().slice(0, 8000);
  if (!key || !u) return { entities: [], links: [], commands: [] };
  const userBlock = `USER:\n${u}`;
  const system = `${CHAT_INTEREST_SKETCH_EXTRACT_SYSTEM}\nRespond with a single JSON object only, no markdown fences.`;
  const { text } = await callLlm({
    provider: providerId,
    key,
    model: dialogueModel(providerId),
    messages: [{ role: "user", content: userBlock }],
    system,
    temperature: 0.12,
    maxTokens: 900,
    responseFormat: providerId === "openai" ? { type: "json_object" } : undefined,
    requestKind: "interests_sketch",
    analytics,
    promptBasis: userBlock,
  });
  return clampGraphPayloadToInterestsOnly(parseIntroGraphJsonFromModelText(text));
}

/**
 * Reconcile new nodes/edges with the stored graph (duplicates, categories) — Keeper step 2, one LLM call.
 * @param {string} providerId
 * @param {string} apiKey
 * @param {{ entities?: unknown[], links?: unknown[], commands?: unknown[] }} proposed
 * @param {Array<{ id?: string, category?: string, label?: string }>} existingNodes
 * @param {{ introMode?: boolean, userText?: string }} [turnContext]
 * @param {{ dialog_id?: string, conversation_turn_id?: string }} [analytics]
 */
export async function normalizeIntroMemoryGraphForDb(
  providerId,
  apiKey,
  proposed,
  existingNodes,
  turnContext = {},
  analytics = {},
) {
  const key = String(apiKey ?? "").trim();
  const rawProp = proposed && typeof proposed === "object" ? proposed : {};
  const base = normalizeIntroGraphExtractPayload(rawProp);
  const fromExtract = normalizeGraphCommands(/** @type {any} */ (rawProp).commands);
  const introMode = Boolean(turnContext.introMode);
  const uTurn = introMode ? String(turnContext.userText ?? "").trim().slice(0, 8000) : "";
  if (!key) return { ...base, commands: fromExtract };
  if (!introMode && base.entities.length === 0 && base.links.length === 0 && fromExtract.length === 0) {
    return { ...base, commands: [] };
  }
  if (introMode && base.entities.length === 0 && base.links.length === 0 && !uTurn && fromExtract.length === 0) {
    return { ...base, commands: [] };
  }

  const existing = Array.isArray(existingNodes)
    ? existingNodes
        .map((n) => ({
          id: String(n?.id ?? ""),
          category: String(n?.category ?? "").trim(),
          label: String(n?.label ?? "").trim().slice(0, 200),
        }))
        .filter((n) => n.id && n.category && n.label)
        .slice(0, 800)
    : [];

  /** @type {{ entities: typeof base.entities, links: typeof base.links, commands?: unknown[] }} */
  const proposedForLlm = { entities: base.entities, links: base.links };
  if (fromExtract.length > 0) proposedForLlm.commands = fromExtract;

  const userJson = introMode
    ? JSON.stringify({
        existingNodes: existing,
        proposed: proposedForLlm,
        introMode: true,
        userTurn: uTurn,
      })
    : JSON.stringify({ existingNodes: existing, proposed: proposedForLlm, introMode: false });

  const system = `${INTRO_GRAPH_NORMALIZE_SYSTEM}\nRespond with one JSON object only, no markdown fences.`;
  const { text } = await callLlm({
    provider: providerId,
    key,
    model: dialogueModel(providerId),
    messages: [{ role: "user", content: userJson }],
    system,
    temperature: 0,
    maxTokens: INTRO_GRAPH_NORMALIZE_OPENAI_MAX_TOKENS,
    responseFormat: providerId === "openai" ? { type: "json_object" } : undefined,
    requestKind: "memory_graph_normalize",
    analytics,
    promptBasis: userJson,
  });
  const normalized = parseIntroGraphJsonFromModelTextSafe(text, "Intro normalize");
  const n = normalized.entities.length + normalized.links.length + (normalized.commands?.length ?? 0);
  if (n > 0) return normalized;
  return { ...base, commands: fromExtract };
}

/** Last-resort Intro ingest when both extract and normalize return nothing (saves facts onto People/User). */
export function introUserNotesFallbackPack(userText) {
  const raw = String(userText ?? "").trim();
  if (raw.length < 6) return { entities: [], links: [], commands: [] };
  if (TRIVIAL_ACK_LINE_RE.test(raw)) return { entities: [], links: [], commands: [] };
  return {
    entities: [{ category: "People", label: "User", notes: raw.slice(0, 4000) }],
    links: [],
    commands: [],
  };
}

/**
 * Extract graph structure from **only** the latest Intro user message. Keeper step 1.
 * @param {string} providerId
 * @param {string} apiKey
 * @param {string} userText
 * @param {{ dialog_id?: string, conversation_turn_id?: string }} [analytics]
 */
export async function extractIntroMemoryGraphForIngest(providerId, apiKey, userText, analytics = {}) {
  const key = String(apiKey ?? "").trim();
  const u = String(userText ?? "").trim().slice(0, 8000);
  if (!key || !u) return { entities: [], links: [], commands: [] };
  const userBlock = `USER:\n${u}`;
  const system = `${INTRO_GRAPH_EXTRACT_SYSTEM}\nRespond with a single JSON object only, no markdown fences.`;
  const { text } = await callLlm({
    provider: providerId,
    key,
    model: dialogueModel(providerId),
    messages: [{ role: "user", content: userBlock }],
    system,
    temperature: 0.1,
    maxTokens: INTRO_GRAPH_EXTRACT_OPENAI_MAX_TOKENS,
    responseFormat: providerId === "openai" ? { type: "json_object" } : undefined,
    requestKind: "intro_graph_extract",
    analytics,
    promptBasis: userBlock,
  });
  return parseIntroGraphJsonFromModelTextSafe(text, "Intro extract");
}

// ─── Orchestration utilities ──────────────────────────────────────────────────

/** Human-readable summary of a keeper pack for the activity log. */
export function keeperPayloadSummary(pack, maxEntities = 8) {
  const entities = Array.isArray(pack?.entities) ? pack.entities : [];
  const links = Array.isArray(pack?.links) ? pack.links : [];
  const parts = entities.slice(0, maxEntities).map((e) => {
    const lab = String(e?.label ?? "").trim().slice(0, 40);
    const cat = String(e?.category ?? "").trim().slice(0, 24);
    return lab ? `${cat}/${lab}` : cat || "?";
  });
  const extra = entities.length > maxEntities ? ` (+more ${entities.length - maxEntities})` : "";
  const cmds = Array.isArray(pack?.commands) ? pack.commands.length : 0;
  const cmdPart = cmds ? `; cmds: ${cmds}` : "";
  const core = `${entities.length} nodes, ${links.length} edges${cmdPart}${parts.length ? ` — ${parts.join("; ")}${extra}` : ""}`;
  return core.length > 480 ? `${core.slice(0, 477)}...` : core;
}

/** Summary line from ingest response `commandsApplied` for the activity log. */
export function keeperIngestCommandsLine(ing) {
  const ca = ing?.commandsApplied;
  if (!ca || typeof ca !== "object") return "";
  const bits = ["mergeNodes", "deleteNode", "renameNode", "deleteEdge", "moveEdge", "skipped"]
    .map((k) => {
      const n = Number(ca[k]);
      return Number.isFinite(n) && n > 0 ? `${k}: ${n}` : "";
    })
    .filter(Boolean);
  return bits.length ? ` Commands: ${bits.join(", ")}.` : "";
}

/** Picks the highest-priority provider that has an API key configured. */
export function pickKeeperProviderWithKey() {
  const keys = getModelApiKeys();
  for (const id of getChatAnalysisPriority()) {
    const key = String(keys[id] ?? "").trim();
    if (key) return { providerId: id, apiKey: key };
  }
  return { providerId: "", apiKey: "" };
}

// ─── Post-turn keeper orchestration ──────────────────────────────────────────

/**
 * Run the appropriate Memory Tree Keeper after a chat turn is saved.
 *
 * Each section (Intro / Access / Rules / Chat) has its own logic; exactly one
 * branch fires per turn. The caller passes a `log` callback (appendActivityLog)
 * and an `onGraphUpdate` callback (loadMemoryGraphIntoUi) to keep UI coupling
 * out of this module.
 *
 * @param {{
 *   introContextActive: boolean,
 *   accessChatOpen: boolean,
 *   rulesChatOpen: boolean,
 *   modeForSend: string,
 *   accessDataDumpMode: boolean,
 *   hadAssistantError: boolean,
 *   persistUserText: string,
 *   persistDialogId: string | null,
 *   tid: string,
 *   providerId: string,
 *   key: string,
 *   log: (msg: string) => void,
 *   onGraphUpdate: () => Promise<void>,
 * }} params
 */
export async function runKeepersAfterTurn({
  introContextActive,
  accessChatOpen,
  rulesChatOpen,
  modeForSend,
  accessDataDumpMode,
  hadAssistantError,
  persistUserText,
  persistDialogId,
  tid,
  providerId,
  key,
  log,
  onGraphUpdate,
}) {
  if (!persistDialogId || !tid) return;

  // ── Intro Keeper ────────────────────────────────────────────────────────────
  if (!accessDataDumpMode && introContextActive && modeForSend !== "image" && !hadAssistantError) {
    try {
      log("Keeper (Intro): start — extracting from user text…");
      const keeperPick = pickKeeperProviderWithKey();
      const keeperProviderId = String(keeperPick.providerId ?? "").trim();
      const keeperApiKey = String(keeperPick.apiKey ?? "").trim();
      if (!keeperProviderId || !keeperApiKey) {
        log("Keeper (Intro): skipped — no API key for analysis provider (OpenAI/Anthropic/Gemini/Perplexity).");
      } else {
        /** @type {{ entities: unknown[], links: unknown[], commands?: unknown[] }} */
        let extracted = { entities: [], links: [], commands: [] };
        try {
          extracted = await extractIntroMemoryGraphForIngest(keeperProviderId, keeperApiKey, persistUserText, {
            dialog_id: persistDialogId,
            conversation_turn_id: tid,
          });
        } catch (exErr) {
          log(`Keeper (Intro): extract request failed — ${exErr instanceof Error ? exErr.message : String(exErr)}. Continuing with empty extract (normalize + fallback can still run).`);
        }
        log(`Keeper (Intro): extract — ${keeperPayloadSummary(extracted)}`);
        let pack = extracted;
        if (await apiHealth()) {
          try {
            const existing = await fetchMemoryGraphFromApi();
            log(`Keeper (Intro): normalize to DB (${(existing.nodes ?? []).length} nodes in graph)…`);
            pack = await normalizeIntroMemoryGraphForDb(
              keeperProviderId,
              keeperApiKey,
              extracted,
              existing.nodes ?? [],
              { introMode: true, userText: persistUserText },
              { dialog_id: persistDialogId, conversation_turn_id: tid },
            );
            log(`Keeper (Intro): normalize — ${keeperPayloadSummary(pack)}`);
          } catch (normErr) {
            log(`Keeper (Intro): normalize — error: ${normErr instanceof Error ? normErr.message : String(normErr)}`);
            log(`Keeper (Intro): pack without normalize — ${keeperPayloadSummary(pack)}`);
          }
        } else {
          log("Keeper (Intro): normalize skipped — local API unavailable; pack is extract-only.");
        }
        let entN = Array.isArray(pack.entities) ? pack.entities.length : 0;
        let linkN = Array.isArray(pack.links) ? pack.links.length : 0;
        let cmdLen = Array.isArray(pack.commands) ? pack.commands.length : 0;
        if (entN === 0 && linkN === 0 && cmdLen === 0) {
          const fb = introUserNotesFallbackPack(persistUserText);
          const fbe = Array.isArray(fb.entities) ? fb.entities.length : 0;
          if (fbe > 0) {
            pack = fb;
            entN = fbe;
            linkN = Array.isArray(fb.links) ? fb.links.length : 0;
            cmdLen = Array.isArray(fb.commands) ? fb.commands.length : 0;
            log("Keeper (Intro): empty extract/normalize — applied People/User notes fallback so the turn still reaches the Memory tree.");
          }
        }
        if (entN > 0 || linkN > 0 || cmdLen > 0) {
          const ing = await ingestMemoryGraphPayload({
            entities: pack.entities ?? [],
            links: pack.links ?? [],
            commands: pack.commands ?? [],
          });
          const u = Number(ing?.upsertedEntities);
          const l = Number(ing?.insertedLinks);
          log(`Keeper (Intro): ingest — upserted nodes: ${Number.isFinite(u) ? u : "?"}, inserted edges: ${Number.isFinite(l) ? l : "?"}.${keeperIngestCommandsLine(ing)}`);
        } else {
          log("Keeper (Intro): ingest skipped — empty pack after extract/normalize. The model returned no entities/links/commands for this message (or the API did not respond).");
        }
      }
    } catch (ingErr) {
      log(`Keeper (Intro): failure — ${ingErr instanceof Error ? ingErr.message : String(ingErr)}`);
    }
    try {
      await onGraphUpdate();
    } catch {
      /* caller logs */
    }

  // ── Access Keeper 2 ─────────────────────────────────────────────────────────
  } else if (accessChatOpen && modeForSend !== "image" && !hadAssistantError) {
    try {
      log("Keeper 2 (Access): start — scanning conversation…");
      const turnsAcc = await fetchTurns(persistDialogId);
      const accParts = [];
      for (const row of turnsAcc.slice(-40)) {
        const u = String(row.user_text ?? "").trim();
        const a = String(row.assistant_text ?? "").trim();
        if (u) accParts.push(`USER:\n${u}`);
        if (a) accParts.push(`ASSISTANT:\n${a}`);
      }
      const transcript = accParts.join("\n\n").slice(0, 72000);
      const store = await fetchAccessExternalServices();
      const existingAcc = Array.isArray(store.entries) ? store.entries : [];
      const existingSummary = JSON.stringify(
        existingAcc.map((e) => ({
          name: e.name,
          description: String(e.description ?? "").slice(0, 160),
        })),
      ).slice(0, 12000);
      const extractedAcc = await extractAccessKeeper2EntriesFromTranscript(
        providerId,
        key,
        transcript,
        existingSummary,
        { dialog_id: persistDialogId, conversation_turn_id: tid },
      );
      let patchAcc = Array.isArray(extractedAcc.entries) ? extractedAcc.entries : [];
      if (patchAcc.length === 0) {
        const stubs = extractAccessExternalServiceStubsFromBulkListText(persistUserText);
        if (stubs.length > 0) {
          patchAcc = stubs;
          log(`Keeper 2 (Access): model returned no rows — applied list parser (${stubs.length} stub row(s) from your last message).`);
        }
      }
      if (patchAcc.length === 0) {
        log("Keeper 2 (Access): no new external-service rows for this turn.");
      } else {
        const mergedAcc = mergeAccessExternalServiceEntries(existingAcc, patchAcc);
        await putAccessExternalServices({ entries: mergedAcc });
        log(`Keeper 2 (Access): merged ${patchAcc.length} update(s); ${mergedAcc.length} service row(s) in store.`);
      }
    } catch (k2Err) {
      log(`Keeper 2 (Access): failure — ${k2Err instanceof Error ? k2Err.message : String(k2Err)}`);
    }

  // ── Rules Keeper 3 ──────────────────────────────────────────────────────────
  } else if (rulesChatOpen && modeForSend !== "image" && !hadAssistantError) {
    try {
      log("Rules: updating saved conduct from the thread…");
      const turnsR = await fetchTurns(persistDialogId);
      const slice = turnsR.slice(-40);
      const rParts = [];
      /** @type {string[]} */
      const userOnlyChronological = [];
      for (const row of slice) {
        const u = String(row.user_text ?? "").trim();
        const a = String(row.assistant_text ?? "").trim();
        if (u) {
          userOnlyChronological.push(u);
          rParts.push(`USER:\n${u}`);
        }
        if (a) rParts.push(`ASSISTANT:\n${a}`);
      }
      const nUser = userOnlyChronological.length;
      const sectionA =
        nUser === 0
          ? "(no user messages in window)\n"
          : userOnlyChronological
              .map((text, i) => `--- USER message ${i + 1} of ${nUser} ---\n${text}`)
              .join("\n\n");
      const sectionB = rParts.join("\n\n");
      const transcriptR = (
        "SECTION A — EVERY USER MESSAGE IN THIS RULES THREAD (oldest first). " +
        "Evaluate **each** block: should it add or change saved project conduct? " +
        "If it is only thanks/ok/emoji with no new rule content, skip that block only.\n\n" +
        `${sectionA}\n\n` +
        "SECTION B — FULL THREAD (USER and ASSISTANT; context for disambiguation only):\n\n" +
        `${sectionB}`
      ).slice(0, 72000);
      const bundle = await fetchRulesKeeperBundle();
      const existingSummaryR = rulesKeeperExistingSummaryForExtract(bundle);
      const stubPatch = extractRulesListStubsFromUserText(persistUserText);
      let patchR = await extractRulesKeeper3FromTranscript(
        providerId,
        key,
        transcriptR,
        existingSummaryR,
        { dialog_id: persistDialogId, conversation_turn_id: tid },
      );
      const countPatch = (p) =>
        p.core_rules.length + p.private_rules.length + p.forbidden_actions.length + p.workflow_rules.length;
      let nAdd = countPatch(patchR);
      const nStub = countPatch(stubPatch);
      const userNonEmptyLines = persistUserText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0).length;
      if (nAdd === 0 && nStub > 0) {
        patchR = stubPatch;
        nAdd = nStub;
        log(`Rules: model returned no rows — used message-text fallback (${nStub} candidate line(s) from your last message).`);
      } else if (nAdd > 0 && userNonEmptyLines >= 3 && nStub > nAdd) {
        patchR = mergeRulesKeeperClientPatches(patchR, stubPatch);
        nAdd = countPatch(patchR);
        log(`Rules: merged message-text fallback (${nStub} line(s)) with model output (${nAdd} total candidate line(s)).`);
      }
      if (nAdd === 0) {
        log("Rules: no new rule lines for this turn.");
      } else {
        const { merged_total: mergedTotal } = await mergeRulesKeeperPatch(patchR);
        log(`Rules: merged ${nAdd} candidate line(s); ${mergedTotal} new unique line(s) in the saved rules store.`);
      }
    } catch (k3Err) {
      log(`Rules: saved-rules update failed — ${k3Err instanceof Error ? k3Err.message : String(k3Err)}`);
    }

  // ── Chat Keeper (interest sketch) ───────────────────────────────────────────
  } else if (
    !accessDataDumpMode &&
    !introContextActive &&
    !accessChatOpen &&
    !rulesChatOpen &&
    modeForSend !== "image" &&
    !hadAssistantError
  ) {
    try {
      log("Keeper (chat): start — interest sketch from user text…");
      const keeperPick = pickKeeperProviderWithKey();
      const keeperProviderId = String(keeperPick.providerId ?? "").trim();
      const keeperApiKey = String(keeperPick.apiKey ?? "").trim();
      if (!keeperProviderId || !keeperApiKey) {
        log("Keeper (chat): skipped — no API key for analysis provider (OpenAI/Anthropic/Gemini/Perplexity).");
      } else {
        const extracted = await extractChatInterestSketchForIngest(
          keeperProviderId,
          keeperApiKey,
          persistUserText,
          { dialog_id: persistDialogId, conversation_turn_id: tid },
        );
        log(`Keeper (chat): extract — ${keeperPayloadSummary(extracted)}`);
        let pack = extracted;
        if ((extracted.entities.length > 0 || extracted.links.length > 0) && (await apiHealth())) {
          try {
            const existing = await fetchMemoryGraphFromApi();
            log(`Keeper (chat): normalize to DB (${(existing.nodes ?? []).length} nodes in graph)…`);
            pack = await normalizeIntroMemoryGraphForDb(
              keeperProviderId,
              keeperApiKey,
              extracted,
              existing.nodes ?? [],
              {},
              { dialog_id: persistDialogId, conversation_turn_id: tid },
            );
            log(`Keeper (chat): normalize — ${keeperPayloadSummary(pack)}`);
          } catch (normErr) {
            log(`Keeper (chat): normalize — error: ${normErr instanceof Error ? normErr.message : String(normErr)}`);
            log(`Keeper (chat): pack without normalize — ${keeperPayloadSummary(pack)}`);
          }
        } else if (extracted.entities.length > 0 || extracted.links.length > 0) {
          log("Keeper (chat): normalize skipped — local API unavailable.");
        }
        const chatCmdLen = Array.isArray(pack.commands) ? pack.commands.length : 0;
        if (pack.entities.length > 0 || pack.links.length > 0 || chatCmdLen > 0) {
          const ing = await ingestMemoryGraphPayload({
            entities: pack.entities ?? [],
            links: pack.links ?? [],
            commands: pack.commands ?? [],
          });
          const u = Number(ing?.upsertedEntities);
          const l = Number(ing?.insertedLinks);
          log(`Keeper (chat): ingest — upserted nodes: ${Number.isFinite(u) ? u : "?"}, inserted edges: ${Number.isFinite(l) ? l : "?"}.${keeperIngestCommandsLine(ing)}`);
          try {
            await onGraphUpdate();
          } catch {
            /* caller logs */
          }
        } else {
          log("Keeper (chat): ingest skipped — empty interest sketch for this message.");
        }
      }
    } catch (skErr) {
      log(`Keeper (chat): failure — ${skErr instanceof Error ? skErr.message : String(skErr)}`);
    }
  }
}
