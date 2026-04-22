import {
  fetchIntroSession,
  fetchAccessSession,
  fetchRulesSession,
  fetchTurns,
} from "./chatPersistence.js";

let introSessionDialogId = null;
let accessSessionDialogId = null;
let rulesSessionDialogId = null;

/**
 * @param {() => string | null} getDialogId
 * @param {(id: string) => void} setDialogId
 * @param {() => Promise<{ dialogId: string }>} fetchSession
 */
async function ensureIrPanelSessionDialogId(getDialogId, setDialogId, fetchSession) {
  const cur = getDialogId();
  if (cur) return cur;
  const s = await fetchSession();
  setDialogId(s.dialogId);
  return s.dialogId;
}

export async function ensureIntroSessionClient() {
  return ensureIrPanelSessionDialogId(
    () => introSessionDialogId,
    (id) => {
      introSessionDialogId = id;
    },
    fetchIntroSession,
  );
}

export async function ensureAccessSessionClient() {
  return ensureIrPanelSessionDialogId(
    () => accessSessionDialogId,
    (id) => {
      accessSessionDialogId = id;
    },
    fetchAccessSession,
  );
}

export async function ensureRulesSessionClient() {
  return ensureIrPanelSessionDialogId(
    () => rulesSessionDialogId,
    (id) => {
      rulesSessionDialogId = id;
    },
    fetchRulesSession,
  );
}

/**
 * @param {{
 *   replayDialogTurnsGrouped: (
 *     turns: unknown[],
 *     replayOpts?: { anchorScrollToTurnId?: string; expectedActiveDialogId?: string },
 *   ) => void,
 *   scrollMessagesToEnd: () => void,
 *   appendActivityLog: (text: string) => void,
 *   loadMemoryGraphIntoUi: () => Promise<void>,
 *   revokeSentUserAttachmentBlobUrls: (listEl: HTMLElement | null | undefined) => void,
 * }} deps
 */
export function createIrPanelThreadLoaders(deps) {
  const {
    replayDialogTurnsGrouped,
    scrollMessagesToEnd,
    appendActivityLog,
    loadMemoryGraphIntoUi,
    revokeSentUserAttachmentBlobUrls,
  } = deps;

  /**
   * @param {{
   *   fetchSession: () => Promise<{ dialogId: string }>,
   *   setDialogId: (id: string) => void,
   *   getDialogId: () => string | null,
   *   logLabel: string,
   *   afterReplay?: () => Promise<void>,
   * }} o
   */
  async function loadIrPanelChatThreadIntoUi(o) {
    const { fetchSession, setDialogId, getDialogId, logLabel, afterReplay } = o;
    try {
      const s = await fetchSession();
      setDialogId(s.dialogId);
      const list = document.getElementById("messages-list");
      if (list) revokeSentUserAttachmentBlobUrls(list);
      list?.replaceChildren();
      const turns = await fetchTurns(getDialogId());
      const did = getDialogId();
      replayDialogTurnsGrouped(turns, {
        expectedActiveDialogId: did ? String(did) : undefined,
      });
      scrollMessagesToEnd();
      if (afterReplay) await afterReplay();
    } catch (e) {
      appendActivityLog(`${logLabel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    loadIntroChatThreadIntoUi: () =>
      loadIrPanelChatThreadIntoUi({
        fetchSession: fetchIntroSession,
        setDialogId: (id) => {
          introSessionDialogId = id;
        },
        getDialogId: () => introSessionDialogId,
        logLabel: "Intro",
        afterReplay: loadMemoryGraphIntoUi,
      }),
    loadAccessChatThreadIntoUi: () =>
      loadIrPanelChatThreadIntoUi({
        fetchSession: fetchAccessSession,
        setDialogId: (id) => {
          accessSessionDialogId = id;
        },
        getDialogId: () => accessSessionDialogId,
        logLabel: "Access",
      }),
    loadRulesChatThreadIntoUi: () =>
      loadIrPanelChatThreadIntoUi({
        fetchSession: fetchRulesSession,
        setDialogId: (id) => {
          rulesSessionDialogId = id;
        },
        getDialogId: () => rulesSessionDialogId,
        logLabel: "Rules",
      }),
  };
}
