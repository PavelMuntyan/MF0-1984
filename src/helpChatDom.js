/** DOM-only Help panel toggles (avoids import cycles with main.js / memoryTree.js). */

export function closeHelpChatPanel() {
  const chat = document.getElementById("main-chat");
  const view = document.getElementById("chat-help-view");
  const btn = document.getElementById("btn-help");
  if (!chat?.classList.contains("chat--help")) return;
  chat.classList.remove("chat--help");
  view?.setAttribute("hidden", "");
  view?.setAttribute("aria-hidden", "true");
  btn?.classList.remove("btn--active");
  btn?.setAttribute("aria-pressed", "false");
}

export function openHelpChatPanelDom() {
  const chat = document.getElementById("main-chat");
  const view = document.getElementById("chat-help-view");
  const btn = document.getElementById("btn-help");
  if (!chat || !view || !btn) return;
  chat.classList.add("chat--help");
  view.removeAttribute("hidden");
  view.setAttribute("aria-hidden", "false");
  btn.classList.add("btn--active");
  btn.setAttribute("aria-pressed", "true");
}

export function isHelpChatOpen() {
  return Boolean(document.getElementById("main-chat")?.classList.contains("chat--help"));
}
