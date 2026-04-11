/**
 * Draft memory_items from a user/assistant pair (no second LLM call).
 * Strict heuristics — only explicit phrasing; guesses and small talk are dropped.
 */

/**
 * @typedef {Object} MemoryDraft
 * @property {string} scope
 * @property {string|null} thread_id
 * @property {string} memory_type
 * @property {string} title
 * @property {string} content
 * @property {string} priority
 * @property {string} [tags]
 */

/**
 * @param {string} threadId
 * @param {Array<{ role: string, content: string }>} newMessages
 * @returns {MemoryDraft[]}
 */
export function extractMemoryItemsFromMessages(threadId, newMessages) {
  const tid = String(threadId ?? "").trim();
  const u = newMessages.find((m) => m.role === "user")?.content ?? "";
  const a = newMessages.find((m) => m.role === "assistant")?.content ?? "";
  const combined = `${u}\n${a}`;

  if (combined.length < 12) return [];

  if (
    /^(hi|hello|hey|\u043f\u0440\u0438\u0432\u0435\u0442|\u0437\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439|thanks|thank you|\u0441\u043f\u0430\u0441\u0438\u0431\u043e)\b/i.test(
      u.trim(),
    ) &&
    a.length < 80
  ) {
    return [];
  }

  /** @type {MemoryDraft[]} */
  const out = [];

  const pref = u.match(
    /(?:I prefer|I always want|please always|\u043f\u0440\u0435\u0434\u043f\u043e\u0447\u0438\u0442\u0430\u044e|\u0432\u0441\u0435\u0433\u0434\u0430\s+\u0438\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0439|always use)\s*[:\-]?\s*(.+)/i,
  );
  if (pref && pref[1] && pref[1].length > 3) {
    out.push({
      scope: "thread",
      thread_id: tid || null,
      memory_type: "preference",
      title: "User preference",
      content: pref[1].trim().slice(0, 800),
      priority: "medium",
      tags: JSON.stringify(["auto_extract"]),
    });
  }

  const decided = combined.match(
    /(?:we decided|we will|decision:|\u0440\u0435\u0448\u0438\u043b\u0438|\u0434\u043e\u0433\u043e\u0432\u043e\u0440\u0438\u043b\u0438\u0441\u044c|it is decided)\s*[:\-]?\s*(.{8,400})/i,
  );
  if (decided && decided[1]) {
    out.push({
      scope: "thread",
      thread_id: tid || null,
      memory_type: "decision",
      title: "Decision",
      content: decided[1].replace(/\s+/g, " ").trim(),
      priority: "high",
      tags: JSON.stringify(["auto_extract"]),
    });
  }

  const must = combined.match(
    /(?:must not|never do|do not|\u043d\u0435\u043b\u044c\u0437\u044f|\u0437\u0430\u043f\u0440\u0435\u0449\u0435\u043d\u043e|forbidden)\s*[:\-]?\s*(.{6,400})/i,
  );
  if (must && must[1]) {
    out.push({
      scope: "thread",
      thread_id: tid || null,
      memory_type: "constraint",
      title: "Constraint",
      content: must[1].replace(/\s+/g, " ").trim(),
      priority: "critical",
      tags: JSON.stringify(["auto_extract"]),
    });
  }

  const fact = combined.match(
    /(?:confirmed fact|it is true that|\u0444\u0430\u043a\u0442:|\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0430\u044e,?\s*\u0447\u0442\u043e)\s*[:\-]?\s*(.{10,400})/i,
  );
  if (fact && fact[1]) {
    out.push({
      scope: "thread",
      thread_id: tid || null,
      memory_type: "fact",
      title: "Fact",
      content: fact[1].replace(/\s+/g, " ").trim(),
      priority: "medium",
      tags: JSON.stringify(["auto_extract"]),
    });
  }

  const seen = new Set();
  return out.filter((d) => {
    const k = d.title + d.content.slice(0, 40);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
