/**
 * Explicit user requests in Intro about the Memory tree — no LLM.
 * Fires only when the text references the graph and an action.
 */

/** Memory tree / graph wording (Russian declensions + Latin). */
const REF_MEMORY =
  /memory\s*tree|memory\s*graph|(\u0434\u0435\u0440\u0435\u0432|\u0433\u0440\u0430\u0444).{0,20}\u043f\u0430\u043c\u044f\u0442|\u043f\u0430\u043c\u044f\u0442.{0,20}(\u0434\u0435\u0440\u0435\u0432|\u0433\u0440\u0430\u0444)|\u0434\u0435\u0440\u0435\u0432\u043e\s+memory|memory\s+\u0434\u0435\u0440\u0435\u0432/i;

const OPEN_VERB =
  /\b(open|show|display|view|see|look|go\s+to|navigate|\u043f\u043e\u043a\u0430\u0436\u0438|\u043f\u043e\u043a\u0430\u0437\u0430\u0442\u044c|\u043e\u0442\u043a\u0440\u043e\u0439|\u043e\u0442\u043a\u0440\u044b\u0442\u044c|\u0437\u0430\u0439\u0434\u0438|\u0437\u0430\u0433\u043b\u044f\u043d\u0438|\u043f\u0435\u0440\u0435\u0439\u0434\u0438|\u043f\u043e\u0441\u043c\u043e\u0442\u0440\u0435\u0442\u044c|\u0443\u0432\u0438\u0434\u0435\u0442\u044c|\u0445\u043e\u0447\u0443\s+(\u0432\u0438\u0434\u0435\u0442\u044c|\u043f\u043e\u0441\u043c\u043e\u0442\u0440\u0435\u0442\u044c|\u043e\u0442\u043a\u0440\u044b\u0442\u044c))\b/i;

const CLOSE_VERB =
  /\b(close|hide|exit|quit|return|back|\u0437\u0430\u043a\u0440\u043e\u0439|\u0437\u0430\u043a\u0440\u044b\u0442\u044c|\u0441\u043a\u0440\u043e\u0439|\u0432\u0435\u0440\u043d\u0438\u0441\u044c|\u043d\u0430\u0437\u0430\u0434|\u0443\u0431\u0435\u0440\u0438)\b/i;

const REFRESH_VERB =
  /\b(refresh|reload|update|sync|\u043e\u0431\u043d\u043e\u0432\u0438|\u043f\u0435\u0440\u0435\u0437\u0430\u0433\u0440\u0443\u0437|\u0430\u043a\u0442\u0443\u0430\u043b\u0438\u0437|\u043f\u0435\u0440\u0435\u0447\u0438\u0442\u0430\u0439)\b/i;

/**
 * @param {string} userText
 * @returns {{ didTouchMemoryTreeTopic: boolean, close: boolean, open: boolean, refresh: boolean }}
 */
export function detectIntroMemoryTreeCommands(userText) {
  const raw = String(userText ?? "").trim();
  if (!raw) {
    return { didTouchMemoryTreeTopic: false, close: false, open: false, refresh: false };
  }
  if (!REF_MEMORY.test(raw)) {
    return { didTouchMemoryTreeTopic: false, close: false, open: false, refresh: false };
  }
  const explicitOpen = OPEN_VERB.test(raw);
  const explicitClose = CLOSE_VERB.test(raw);
  const explicitRefresh = REFRESH_VERB.test(raw);
  /** "Do something with the memory tree" without an explicit open verb — treat as open/show UI. */
  const genericDoOpen =
    !explicitClose &&
    !explicitRefresh &&
    !explicitOpen &&
    /\b(\u0441\u0434\u0435\u043b\u0430\u0439|\u0432\u044b\u043f\u043e\u043b\u043d\u0438)\b/i.test(raw) &&
    /(\u0434\u0435\u0440\u0435\u0432|memory|\u0433\u0440\u0430\u0444|\u043f\u0430\u043c\u044f\u0442)/i.test(raw);
  return {
    didTouchMemoryTreeTopic: true,
    close: explicitClose,
    open: explicitOpen || genericDoOpen,
    refresh: explicitRefresh,
  };
}
