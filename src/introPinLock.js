import {
  apiHealth,
  fetchIntroLockState,
  postIntroLockSet,
  postIntroLockUnlock,
} from "./chatPersistence.js";

/** @type {boolean} */
let introLocked = false;

/** @type {(() => void) | null} */
let appendActivityLog = null;

/** @type {(() => Promise<void>) | null} */
let loadIntroThreadIntoUi = null;

/** @type {(() => void) | null} */
let syncIntroVaultDom = null;

/** Call after restoring Intro/Rules/Access UI (e.g. Memory tree close) so vault overlay stays correct. */
export function notifyIntroLayoutSync() {
  syncIntroVaultDom?.();
}

export function getIntroLockedSync() {
  return introLocked;
}

export function syncIntroChrome() {
  const btn = document.getElementById("btn-ir-intro");
  const openSvg = btn?.querySelector(".sidebar-ir-lock-svg--open");
  const closedSvg = btn?.querySelector(".sidebar-ir-lock-svg--closed");
  if (!btn || !openSvg || !closedSvg) return;
  if (introLocked) {
    btn.classList.add("sidebar-ir-bubble--intro-locked");
    openSvg.hidden = true;
    closedSvg.hidden = false;
  } else {
    btn.classList.remove("sidebar-ir-bubble--intro-locked");
    openSvg.hidden = false;
    closedSvg.hidden = true;
  }
}

export async function refreshIntroLockFromApi() {
  try {
    if (!(await apiHealth())) {
      introLocked = false;
      syncIntroChrome();
      syncIntroVaultDom?.();
      return false;
    }
    const { locked } = await fetchIntroLockState();
    introLocked = Boolean(locked);
  } catch {
    introLocked = false;
  }
  syncIntroChrome();
  syncIntroVaultDom?.();
  return introLocked;
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

/** @type {(() => void) | null} */
let openSetPinModalImpl = null;
/** @type {(() => void) | null} */
let openUnlockModalImpl = null;

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

/**
 * @param {{ appendActivityLog: (s: string) => void, loadIntroThreadIntoUi: () => Promise<void>, syncIntroVaultDom: () => void }} deps
 */
export function initIntroPinLock(deps) {
  appendActivityLog = deps.appendActivityLog;
  loadIntroThreadIntoUi = deps.loadIntroThreadIntoUi;
  syncIntroVaultDom = deps.syncIntroVaultDom;

  const setModal = document.getElementById("modal-intro-set-pin");
  const unlockModal = document.getElementById("modal-intro-unlock-pin");
  if (!setModal || !unlockModal) return;

  const setErr = document.getElementById("intro-set-pin-error");
  const unlockErr = document.getElementById("intro-unlock-pin-error");
  const setIn1 = [...document.querySelectorAll("#intro-set-pin-row-a .intro-pin-digit")];
  const setIn2 = [...document.querySelectorAll("#intro-set-pin-row-b .intro-pin-digit")];
  const unlockIn = [...document.querySelectorAll("#intro-unlock-pin-row .intro-pin-digit")];

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
    modal.querySelector("[data-intro-pin-backdrop]")?.addEventListener("click", () => {
      if (modal === setModal) closeSet();
      else closeUnlock();
    });
  }

  document.getElementById("intro-set-pin-cancel")?.addEventListener("click", () => closeSet());
  document.getElementById("intro-unlock-pin-cancel")?.addEventListener("click", () => closeUnlock());

  document.getElementById("intro-set-pin-save")?.addEventListener("click", async () => {
    clearSetErrors();
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
      await postIntroLockSet(a);
      introLocked = true;
      syncIntroChrome();
      syncIntroVaultDom?.();
      appendActivityLog?.("Intro: PIN saved — section is locked until you unlock it.");
      closeSet();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (setErr) {
        setErr.textContent = msg;
        setErr.hidden = false;
      }
      appendActivityLog?.(`Intro PIN: ${msg}`);
    }
  });

  document.getElementById("intro-unlock-pin-open")?.addEventListener("click", async () => {
    clearUnlockErrors();
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
      await postIntroLockUnlock(pin);
      introLocked = false;
      syncIntroChrome();
      syncIntroVaultDom?.();
      closeUnlock();
      const chat = document.getElementById("main-chat");
      if (chat?.classList.contains("chat--intro")) {
        await loadIntroThreadIntoUi?.();
      }
      appendActivityLog?.("Intro: unlocked. Set a new PIN to lock again.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (unlockErr) {
        unlockErr.textContent = msg;
        unlockErr.hidden = false;
      }
      appendActivityLog?.(`Intro unlock: ${msg}`);
    }
  });

  openSetPinModalImpl = () => {
    clearSetErrors();
    clearInputs(setIn1);
    clearInputs(setIn2);
    openModal(setModal);
    setIn1[0]?.focus();
  };
  openUnlockModalImpl = () => {
    clearUnlockErrors();
    clearInputs(unlockIn);
    openModal(unlockModal);
    unlockIn[0]?.focus();
  };

  document.getElementById("intro-vault-open-unlock")?.addEventListener("click", () => {
    openUnlockModalImpl?.();
  });

  wirePinGroup(setIn1, null);
  wirePinGroup(setIn2, null);
  wirePinGroup(unlockIn, null);
}

export function openSetPinModal() {
  openSetPinModalImpl?.();
}

export function openUnlockModal() {
  openUnlockModalImpl?.();
}
