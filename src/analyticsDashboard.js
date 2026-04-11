import { PROVIDER_DISPLAY } from "./chatApi.js";
import { apiHealth } from "./chatPersistence.js";
import { escapeHtml } from "./escapeHtml.js";

const PROVIDER_IDS = ["openai", "perplexity", "gemini-flash", "anthropic"];

/** `YYYY-MM-DD` → `MM.DD` for chart axis */
function chartDayLabelMmDd(isoDate) {
  const d = String(isoDate ?? "").trim();
  if (d.length >= 10 && d[4] === "-" && d[7] === "-") {
    return `${d.slice(5, 7)}.${d.slice(8, 10)}`;
  }
  return d;
}

/** @type {boolean} */
let analyticsOpen = false;

/** @type {(() => void) | null} */
let prepareChatSurface = null;

/**
 * @param {HTMLElement} root
 * @param {unknown} raw
 */
function renderAnalytics(root, raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const providers = data.providers && typeof data.providers === "object" ? data.providers : {};
  const dailyUsage = Array.isArray(data.dailyUsage) ? data.dailyUsage : [];
  const themesCount = Number(data.themesCount) || 0;
  const dialogsCount = Number(data.dialogsCount) || 0;
  const mg = data.memoryGraph && typeof data.memoryGraph === "object" ? data.memoryGraph : {};
  const nodes = Number(mg.nodes) || 0;
  const edges = Number(mg.edges) || 0;
  const groups = Number(mg.groups) || 0;

  let maxDay = 1;
  for (const day of dailyUsage) {
    const bp = day?.byProvider && typeof day.byProvider === "object" ? day.byProvider : {};
    let sum = 0;
    for (const id of PROVIDER_IDS) sum += Number(bp[id]) || 0;
    if (sum > maxDay) maxDay = sum;
  }

  const cardsHtml = PROVIDER_IDS.map((id) => {
    const p = providers[id] && typeof providers[id] === "object" ? providers[id] : {};
    const label = escapeHtml(String(PROVIDER_DISPLAY[id] ?? id));
    const rs = Number(p.requestsSent) || 0;
    const ok = Number(p.responsesOk) || 0;
    const im = Number(p.imageRequests) || 0;
    const dr = Number(p.researchRequests) || 0;
    const wb = Number(p.webRequests) || 0;
    const ar = Number(p.accessRequests) || 0;
    return `
      <section class="analytics-model-card" data-provider="${id}">
        <h3 class="analytics-model-title">${label}</h3>
        <dl class="analytics-dl">
          <div class="analytics-dl-row"><dt>Requests sent</dt><dd>${rs}</dd></div>
          <div class="analytics-dl-row"><dt>Responses without error</dt><dd>${ok}</dd></div>
          <div class="analytics-dl-row"><dt>Create image</dt><dd>${im}</dd></div>
          <div class="analytics-dl-row"><dt>Deep research</dt><dd>${dr}</dd></div>
          <div class="analytics-dl-row"><dt>Web search</dt><dd>${wb}</dd></div>
          <div class="analytics-dl-row"><dt>Access requests</dt><dd>${ar}</dd></div>
        </dl>
      </section>`;
  }).join("");

  const barsHtml = dailyUsage
    .map((day) => {
      const d = String(day?.date ?? "").trim();
      const bp = day?.byProvider && typeof day.byProvider === "object" ? day.byProvider : {};
      const short = escapeHtml(chartDayLabelMmDd(d));
      const segs = PROVIDER_IDS.map((id) => {
        const c = Number(bp[id]) || 0;
        const pct = maxDay > 0 ? Math.round((c / maxDay) * 1000) / 10 : 0;
        const title = escapeHtml(`${PROVIDER_DISPLAY[id] ?? id}: ${c}`);
        return `<div class="analytics-bar-seg analytics-bar-seg--${id}" style="height:${pct}%" title="${title}"></div>`;
      }).join("");
      const total = PROVIDER_IDS.reduce((s, id) => s + (Number(bp[id]) || 0), 0);
      return `<div class="analytics-bar-col"><div class="analytics-bar-stack">${segs}</div><span class="analytics-bar-day">${short}</span><span class="analytics-bar-total">${total}</span></div>`;
    })
    .join("");

  root.innerHTML = `
    <div class="analytics-inner">
      <header class="analytics-header">
        <h2 class="analytics-page-title">Analytics</h2>
        <p class="analytics-sub">Usage includes regular chats and archived counts from cleared Intro / Rules / Access threads and from deleted themes (live DB + archive).</p>
      </header>
      <div class="analytics-model-grid">${cardsHtml}</div>
      <section class="analytics-chart-block">
        <h3 class="analytics-section-title">Last 30 days — requests per day</h3>
        <div class="analytics-legend">
          ${PROVIDER_IDS.map(
            (id) =>
              `<span class="analytics-legend-item"><span class="analytics-legend-swatch analytics-bar-seg--${id}"></span>${escapeHtml(String(PROVIDER_DISPLAY[id] ?? id))}</span>`,
          ).join("")}
        </div>
        <div class="analytics-bars-wrap"><div class="analytics-bars">${barsHtml}</div></div>
      </section>
      <section class="analytics-meta-grid">
        <div class="analytics-meta-card"><div class="analytics-meta-label">Themes</div><div class="analytics-meta-value">${themesCount}</div></div>
        <div class="analytics-meta-card"><div class="analytics-meta-label">Dialogs</div><div class="analytics-meta-value">${dialogsCount}</div></div>
        <div class="analytics-meta-card"><div class="analytics-meta-label">Memory nodes</div><div class="analytics-meta-value">${nodes}</div></div>
        <div class="analytics-meta-card"><div class="analytics-meta-label">Memory edges</div><div class="analytics-meta-value">${edges}</div></div>
        <div class="analytics-meta-card"><div class="analytics-meta-label">Memory groups</div><div class="analytics-meta-value">${groups}</div></div>
      </section>
    </div>`;
}

export function closeAnalyticsView() {
  const chat = document.getElementById("main-chat");
  const view = document.getElementById("chat-analytics-view");
  const btn = document.getElementById("btn-analytics");
  if (!chat || !analyticsOpen) return;
  analyticsOpen = false;
  chat.classList.remove("main-chat--analytics");
  if (view) {
    view.hidden = true;
    view.setAttribute("aria-hidden", "true");
  }
  if (btn) {
    btn.setAttribute("aria-pressed", "false");
    btn.classList.remove("btn--active");
  }
}

/**
 * @param {{ fetchAnalytics: () => Promise<unknown>, appendActivityLog: (s: string) => void, prepareChatSurface: () => void }} deps
 */
export function initAnalyticsDashboard(deps) {
  const { fetchAnalytics, appendActivityLog, prepareChatSurface: prep } = deps;
  prepareChatSurface = typeof prep === "function" ? prep : () => {};

  const btn = document.getElementById("btn-analytics");
  const chat = document.getElementById("main-chat");
  const view = document.getElementById("chat-analytics-view");
  const root = document.getElementById("analytics-dashboard-root");
  if (!btn || !chat || !view || !root) return;

  async function refresh() {
    try {
      if (!(await apiHealth())) {
        root.innerHTML =
          '<p class="analytics-error">Connect the local API to load analytics (same as chat database).</p>';
        return;
      }
      const data = await fetchAnalytics();
      renderAnalytics(root, data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      root.innerHTML = `<p class="analytics-error">Could not load analytics: ${escapeHtml(msg)}</p>`;
      appendActivityLog(`Analytics: ${msg}`);
    }
  }

  btn.addEventListener("click", async () => {
    if (analyticsOpen) {
      closeAnalyticsView();
      return;
    }
    prepareChatSurface();
    analyticsOpen = true;
    chat.classList.add("main-chat--analytics");
    view.hidden = false;
    view.setAttribute("aria-hidden", "false");
    btn.setAttribute("aria-pressed", "true");
    btn.classList.add("btn--active");
    await refresh();
  });
}
