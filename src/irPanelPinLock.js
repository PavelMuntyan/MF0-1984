import {
  apiHealth,
  fetchIrPanelLocksAll,
  postIrPanelLockSet,
  postIrPanelLockUnlock,
} from "./chatPersistence.js";

/** @typedef {"intro"|"rules"|"access"} IrPanelId */

const IR_PANEL_IDS = /** @type {const IrPanelId[]} */ (["intro", "rules", "access"]);

const PANEL_LABEL = /** @type {Record<IrPanelId, string>} */ ({
  intro: "Intro",
  rules: "Rules",
  access: "Access",
});

/** @type {Record<IrPanelId, boolean>} */
const locked = {
  intro: false,
  rules: false,
  access: false,
};

/** @type {IrPanelId | null} */
let activePanel = null;

/** @type {(() => void) | null} */
let appendActivityLog = null;

/** @type {(() => Promise<void>) | null} */
let loadIntroThreadIntoUi = null;

/** @type {(() => Promise<void>) | null} */
let loadAccessThreadIntoUi = null;

/** @type {(() => void) | null} */
let syncIrPanelVaultDom = null;

/** @type {(() => void) | null} */
let openSetPinModalImpl = null;

/** @type {(() => void) | null} */
let openUnlockModalImpl = null;

export function notifyIrPanelLayoutSync() {
  syncIrPanelVaultDom?.();
}

/** @param {IrPanelId} panel */
export function getIrPanelLockedSync(panel) {
  return Boolean(locked[panel]);
}

export function syncAllIrPanelChrome() {
  for (const panel of IR_PANEL_IDS) {
    const btn = document.getElementById(`btn-ir-${panel}`);
    const openSvg = btn?.querySelector(".sidebar-ir-lock-svg--open");
    const closedSvg = btn?.querySelector(".sidebar-ir-lock-svg--closed");
    if (!btn || !openSvg || !closedSvg) continue;
    if (locked[panel]) {
      btn.classList.add("sidebar-ir-bubble--ir-locked");
      openSvg.hidden = true;
      closedSvg.hidden = false;
    } else {
      btn.classList.remove("sidebar-ir-bubble--ir-locked");
      openSvg.hidden = false;
      closedSvg.hidden = true;
    }
  }
}

export async function refreshIrPanelLockFromApi() {
  try {
    if (!(await apiHealth())) {
      for (const panel of IR_PANEL_IDS) locked[panel] = false;
      syncAllIrPanelChrome();
      syncIrPanelVaultDom?.();
      return;
    }
    const data = await fetchIrPanelLocksAll();
    for (const panel of IR_PANEL_IDS) {
      locked[panel] = data[panel]?.locked === true;
    }
  } catch {
    for (const panel of IR_PANEL_IDS) locked[panel] = false;
  }
  syncAllIrPanelChrome();
  syncIrPanelVaultDom?.();
}

function readSixDigitPin(inputs) {
  return inputs.map((el) => String(el.value).replace(/\D/g, "").slice(-1) || "").join("");
}

function wirePinGroup(inputs, onComplete) {
  for (let i = 0; i < inputs.length; i++) {
    const el = inputs[i];
    el.addEventListener("input", () => {
      el.value = String(el.value).replace(/\D/g, "").slice(0, 1);
      if (el.value && i < inputs.length - 1) inputs[i + 1].focus();
      const full = readSixDigitPin(inputs);
      if (full.length === 6) onComplete?.(full);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !el.value && i > 0) {
        inputs[i - 1].focus();
        inputs[i - 1].value = "";
      }
    });
  }
  const group = inputs[0]?.closest(".intro-pin-group");
  group?.addEventListener("paste", (e) => {
    const t = e.clipboardData?.getData("text") ?? "";
    const digits = t.replace(/\D/g, "").slice(0, 6);
    if (digits.length < 6) return;
    e.preventDefault();
    for (let j = 0; j < 6; j++) inputs[j].value = digits[j] ?? "";
    inputs[5].focus();
    onComplete?.(digits);
  });
}

function clearInputs(inputs) {
  for (const el of inputs) el.value = "";
}

/** @param {HTMLElement} modal */
function trapModalFocus(modal) {
  const focusables = modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  const list = [...focusables].filter((n) => !n.disabled && n.offsetParent !== null);
  if (list.length) list[0].focus();
}

let escHandler = null;

function openModal(modal) {
  modal.removeAttribute("hidden");
  modal.setAttribute("aria-hidden", "false");
  trapModalFocus(modal);
  escHandler = (e) => {
    if (e.key === "Escape") closeModal(modal);
  };
  document.addEventListener("keydown", escHandler);
}

function closeModal(modal) {
  modal.setAttribute("hidden", "");
  modal.setAttribute("aria-hidden", "true");
  if (escHandler) {
    document.removeEventListener("keydown", escHandler);
    escHandler = null;
  }
}

/** @param {IrPanelId} panel */
function applySetModalCopy(panel) {
  const label = PANEL_LABEL[panel];
  const setTitle = document.getElementById("ir-set-pin-title");
  const setDesc = document.querySelector("#modal-ir-set-pin .intro-pin-modal-desc");
  const unlockTitle = document.getElementById("ir-unlock-pin-title");
  if (setTitle) setTitle.textContent = `Lock ${label}`;
  if (setDesc) {
    setDesc.textContent = `Set a 6-digit PIN for ${label}. You will need it each time you open this section until you unlock.`;
  }
  if (unlockTitle) unlockTitle.textContent = `Unlock ${label}`;
}

/**
 * @param {{ appendActivityLog: (s: string) => void, loadIntroThreadIntoUi: () => Promise<void>, loadAccessThreadIntoUi?: () => Promise<void>, syncIrPanelVaultDom: () => void }} deps
 */
export function initIrPanelPinLock(deps) {
  appendActivityLog = deps.appendActivityLog;
  loadIntroThreadIntoUi = deps.loadIntroThreadIntoUi;
  loadAccessThreadIntoUi = deps.loadAccessThreadIntoUi ?? null;
  syncIrPanelVaultDom = deps.syncIrPanelVaultDom;

  const setModal = document.getElementById("modal-ir-set-pin");
  const unlockModal = document.getElementById("modal-ir-unlock-pin");
  if (!setModal || !unlockModal) return;

  const setErr = document.getElementById("ir-set-pin-error");
  const unlockErr = document.getElementById("ir-unlock-pin-error");
  const setIn1 = [...document.querySelectorAll("#ir-set-pin-row-a .intro-pin-digit")];
  const setIn2 = [...document.querySelectorAll("#ir-set-pin-row-b .intro-pin-digit")];
  const unlockIn = [...document.querySelectorAll("#ir-unlock-pin-row .intro-pin-digit")];

  function clearSetErrors() {
    if (setErr) {
      setErr.textContent = "";
      setErr.hidden = true;
    }
  }
  function clearUnlockErrors() {
    if (unlockErr) {
      unlockErr.textContent = "";
      unlockErr.hidden = true;
    }
  }

  function closeSet() {
    clearSetErrors();
    clearInputs(setIn1);
    clearInputs(setIn2);
    closeModal(setModal);
  }

  function closeUnlock() {
    clearUnlockErrors();
    clearInputs(unlockIn);
    closeModal(unlockModal);
  }

  for (const modal of [setModal, unlockModal]) {
    modal.querySelector("[data-ir-pin-backdrop]")?.addEventListener("click", () => {
      if (modal === setModal) closeSet();
      else closeUnlock();
    });
  }

  document.getElementById("ir-set-pin-cancel")?.addEventListener("click", () => closeSet());
  document.getElementById("ir-unlock-pin-cancel")?.addEventListener("click", () => closeUnlock());

  document.getElementById("ir-set-pin-save")?.addEventListener("click", async () => {
    clearSetErrors();
    const panel = activePanel;
    if (!panel) return;
    const a = readSixDigitPin(setIn1);
    const b = readSixDigitPin(setIn2);
    if (a.length !== 6 || b.length !== 6) {
      if (setErr) {
        setErr.textContent = "Enter a 6-digit PIN in both fields.";
        setErr.hidden = false;
      }
      return;
    }
    if (a !== b) {
      if (setErr) {
        setErr.textContent = "PINs do not match.";
        setErr.hidden = false;
      }
      return;
    }
    try {
      if (!(await apiHealth())) throw new Error("API offline.");
      await postIrPanelLockSet(panel, a);
      locked[panel] = true;
      syncAllIrPanelChrome();
      syncIrPanelVaultDom?.();
      appendActivityLog?.(`${PANEL_LABEL[panel]}: PIN saved — section is locked until you unlock it.`);
      closeSet();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (setErr) {
        setErr.textContent = msg;
        setErr.hidden = false;
      }
      appendActivityLog?.(`${PANEL_LABEL[panel]} PIN: ${msg}`);
    }
  });

  document.getElementById("ir-unlock-pin-open")?.addEventListener("click", async () => {
    clearUnlockErrors();
    const panel = activePanel;
    if (!panel) return;
    const pin = readSixDigitPin(unlockIn);
    if (pin.length !== 6) {
      if (unlockErr) {
        unlockErr.textContent = "Enter the 6-digit PIN.";
        unlockErr.hidden = false;
      }
      return;
    }
    try {
      if (!(await apiHealth())) throw new Error("API offline.");
      await postIrPanelLockUnlock(panel, pin);
      locked[panel] = false;
      syncAllIrPanelChrome();
      syncIrPanelVaultDom?.();
      closeUnlock();
      const chat = document.getElementById("main-chat");
      if (panel === "intro" && chat?.classList.contains("chat--intro")) {
        await loadIntroThreadIntoUi?.();
      }
      if (panel === "access" && chat?.classList.contains("chat--access")) {
        await loadAccessThreadIntoUi?.();
      }
      appendActivityLog?.(`${PANEL_LABEL[panel]}: unlocked. Set a new PIN to lock again.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (unlockErr) {
        unlockErr.textContent = msg;
        unlockErr.hidden = false;
      }
      appendActivityLog?.(`${PANEL_LABEL[panel]} unlock: ${msg}`);
    }
  });

  openSetPinModalImpl = (panel) => {
    activePanel = panel;
    applySetModalCopy(panel);
    clearSetErrors();
    clearInputs(setIn1);
    clearInputs(setIn2);
    openModal(setModal);
    setIn1[0]?.focus();
  };
  openUnlockModalImpl = (panel) => {
    activePanel = panel;
    applySetModalCopy(panel);
    clearUnlockErrors();
    clearInputs(unlockIn);
    openModal(unlockModal);
    unlockIn[0]?.focus();
  };

  for (const panel of IR_PANEL_IDS) {
    document.getElementById(`${panel}-vault-open-unlock`)?.addEventListener("click", () => {
      openUnlockModalImpl?.(panel);
    });
  }

  wirePinGroup(setIn1, null);
  wirePinGroup(setIn2, null);
  wirePinGroup(unlockIn, null);
}

/** @param {IrPanelId} panel */
export function openSetPinModal(panel) {
  openSetPinModalImpl?.(panel);
}

/** @param {IrPanelId} panel */
export function openUnlockModal(panel) {
  openUnlockModalImpl?.(panel);
}
