/**
 * Извлечение черновиков memory_items из пары сообщений (без второго вызова LLM).
 * Жёсткие эвристики — только явные формулировки; догадки и small talk отбрасываются.
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
    /^(hi|hello|hey|привет|здравствуй|thanks|thank you|спасибо)\b/i.test(u.trim()) &&
    a.length < 80
  ) {
    return [];
  }

  /** @type {MemoryDraft[]} */
  const out = [];

  const pref = u.match(
    /(?:I prefer|I always want|please always|предпочитаю|всегда используй|always use)\s*[:\-]?\s*(.+)/i,
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
    /(?:we decided|we will|decision:|решили|договорились|it is decided)\s*[:\-]?\s*(.{8,400})/i,
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
    /(?:must not|never do|do not|нельзя|запрещено|forbidden)\s*[:\-]?\s*(.{6,400})/i,
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
    /(?:confirmed fact|it is true that|факт:|подтверждаю,?\s*что)\s*[:\-]?\s*(.{10,400})/i,
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
