import { PROVIDER_DISPLAY } from "./chatApi.js";
import { apiHealth } from "./chatPersistence.js";
import { escapeHtml } from "./escapeHtml.js";
import { estimateProviderUsd, formatUsdEstimate } from "./analyticsPricing.js";
import { getChatAnalysisPriority } from "./chatAnalysisPriority.js";

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
/** @type {() => Promise<void>} */
let refreshAnalyticsViewIfOpenImpl = async () => {};

/**
 * @param {HTMLElement} root
 * @param {unknown} raw
 * @param {"all" | "last30d" | "last24h"} activeRange
 */
function renderAnalytics(root, raw, activeRange) {
  const data = raw && typeof raw === "object" ? raw : {};
  const providersByRange =
    data.providersByRange && typeof data.providersByRange === "object" ? data.providersByRange : {};
  const providers =
    providersByRange?.[activeRange] && typeof providersByRange[activeRange] === "object"
      ? providersByRange[activeRange]
      : data.providers && typeof data.providers === "object"
        ? data.providers
        : {};
  const dailyUsage = Array.isArray(data.dailyUsage) ? data.dailyUsage : [];
  const dailyTokens = Array.isArray(data.dailyTokens) ? data.dailyTokens : [];
  const dailyLlmTokensRaw = Array.isArray(data.dailyLlmTokens) ? data.dailyLlmTokens : [];
  const dailyLlmTokens =
    dailyLlmTokensRaw.length > 0
      ? dailyLlmTokensRaw
      : dailyTokens.map((t) => ({
          date: String(t?.date ?? "").trim(),
          byProvider: Object.fromEntries(
            PROVIDER_IDS.map((id) => [id, { prompt: 0, completion: 0, total: 0 }]),
          ),
        }));
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

  let maxTokDay = 1;
  for (const day of dailyTokens) {
    const bp = day?.byProvider && typeof day.byProvider === "object" ? day.byProvider : {};
    let sum = 0;
    for (const id of PROVIDER_IDS) sum += Number(bp[id]) || 0;
    if (sum > maxTokDay) maxTokDay = sum;
  }

  let maxSpendDay = 1e-9;
  for (const day of dailyLlmTokens) {
    const bp = day?.byProvider && typeof day.byProvider === "object" ? day.byProvider : {};
    let sumUsd = 0;
    for (const id of PROVIDER_IDS) {
      const cell = bp[id] && typeof bp[id] === "object" ? bp[id] : {};
      const pr = Number(cell.prompt) || 0;
      const co = Number(cell.completion) || 0;
      const est = estimateProviderUsd(id, pr, co);
      sumUsd += est?.totalUsd ?? 0;
    }
    if (sumUsd > maxSpendDay) maxSpendDay = sumUsd;
  }
  if (maxSpendDay < 1e-9) maxSpendDay = 1;

  let sumInputUsd = 0;
  let sumOutputUsd = 0;
  const analysisPriority = getChatAnalysisPriority();
  const keeperAnalysisProvider = String(analysisPriority[0] ?? "").trim();
  const cardsHtml = PROVIDER_IDS.map((id) => {
    const p = providers[id] && typeof providers[id] === "object" ? providers[id] : {};
    const label = escapeHtml(String(PROVIDER_DISPLAY[id] ?? id));
    const rs = Number(p.requestsSent) || 0;
    const ok = Number(p.responsesOk) || 0;
    const im = Number(p.imageRequests) || 0;
    const dr = Number(p.researchRequests) || 0;
    const wb = Number(p.webRequests) || 0;
    const ar = Number(p.accessRequests) || 0;
    const tp = Number(p.tokensPrompt) || 0;
    const tc = Number(p.tokensCompletion) || 0;
    const tt = Number(p.tokensTotal) || 0;
    const est = estimateProviderUsd(id, tp, tc);
    if (est) {
      sumInputUsd += est.inputUsd;
      sumOutputUsd += est.outputUsd;
    }
    const keeperBadge =
      id === keeperAnalysisProvider
        ? `<span class="analytics-keeper-badge" title="This provider (its lightweight model) handles chat analysis and Memory tree routing." aria-label="This provider (its lightweight model) handles chat analysis and Memory tree routing.">✓</span>`
        : "";
    return `
      <section class="analytics-model-card" data-provider="${id}">
        <h3 class="analytics-model-title">${label}${keeperBadge}</h3>
        <dl class="analytics-dl">
          <div class="analytics-dl-row"><dt>Requests sent</dt><dd>${rs}</dd></div>
          <div class="analytics-dl-row"><dt>Responses without error</dt><dd>${ok}</dd></div>
          <div class="analytics-dl-row"><dt>Create image</dt><dd>${im}</dd></div>
          <div class="analytics-dl-row"><dt>Deep research</dt><dd>${dr}</dd></div>
          <div class="analytics-dl-row"><dt>Web search</dt><dd>${wb}</dd></div>
          <div class="analytics-dl-row"><dt>Access requests</dt><dd>${ar}</dd></div>
          <div class="analytics-dl-row"><dt>Prompt tokens</dt><dd>${tp.toLocaleString()}</dd></div>
          <div class="analytics-dl-row"><dt>Completion tokens</dt><dd>${tc.toLocaleString()}</dd></div>
          <div class="analytics-dl-row"><dt>Total tokens</dt><dd>${tt.toLocaleString()}</dd></div>
          <div class="analytics-dl-row analytics-dl-row--cost"><dt>Est. input cost (USD)</dt><dd>${formatUsdEstimate(est?.inputUsd)}</dd></div>
          <div class="analytics-dl-row analytics-dl-row--cost"><dt>Est. output cost (USD)</dt><dd>${formatUsdEstimate(est?.outputUsd)}</dd></div>
          <div class="analytics-dl-row analytics-dl-row--cost"><dt>Est. total cost (USD)</dt><dd>${formatUsdEstimate(est?.totalUsd)}</dd></div>
        </dl>
      </section>`;
  }).join("");

  const totalUsd = sumInputUsd + sumOutputUsd;
  const spendSummaryRaw = data.spendSummary && typeof data.spendSummary === "object" ? data.spendSummary : {};
  const summaryInput = spendSummaryRaw.inputUsd && typeof spendSummaryRaw.inputUsd === "object" ? spendSummaryRaw.inputUsd : {};
  const summaryOutput =
    spendSummaryRaw.outputUsd && typeof spendSummaryRaw.outputUsd === "object" ? spendSummaryRaw.outputUsd : {};
  const summaryCombined =
    spendSummaryRaw.combinedUsd && typeof spendSummaryRaw.combinedUsd === "object"
      ? spendSummaryRaw.combinedUsd
      : {};
  const spendInput = {
    total: Number(summaryInput.total),
    last30d: Number(summaryInput.last30d),
    last24h: Number(summaryInput.last24h),
  };
  const spendOutput = {
    total: Number(summaryOutput.total),
    last30d: Number(summaryOutput.last30d),
    last24h: Number(summaryOutput.last24h),
  };
  const spendCombined = {
    total: Number(summaryCombined.total),
    last30d: Number(summaryCombined.last30d),
    last24h: Number(summaryCombined.last24h),
  };
  if (!Number.isFinite(spendInput.total)) spendInput.total = sumInputUsd;
  if (!Number.isFinite(spendOutput.total)) spendOutput.total = sumOutputUsd;
  if (!Number.isFinite(spendCombined.total)) spendCombined.total = totalUsd;
  if (!Number.isFinite(spendInput.last30d)) spendInput.last30d = spendInput.total;
  if (!Number.isFinite(spendOutput.last30d)) spendOutput.last30d = spendOutput.total;
  if (!Number.isFinite(spendCombined.last30d)) spendCombined.last30d = spendCombined.total;
  if (!Number.isFinite(spendInput.last24h)) spendInput.last24h = 0;
  if (!Number.isFinite(spendOutput.last24h)) spendOutput.last24h = 0;
  if (!Number.isFinite(spendCombined.last24h)) spendCombined.last24h = 0;
  const pricingFootnote = escapeHtml(
    "Estimated USD is not an invoice: each provider row mixes models (chat, images, background tools). Rates are fixed reference tiers for planning only — OpenAI GPT-4o class ($2.50 / $15 per 1M in/out), Claude Sonnet class ($3 / $15), Gemini Flash ($0.50 / $3), Perplexity midpoint ($2.75 / $9). Your API bill may differ.",
  );
  const costSummaryHtml = `
    <section class="analytics-cost-summary">
      <h3 class="analytics-section-title">Estimated spend (all listed providers)</h3>
      <table class="analytics-spend-table" role="table" aria-label="Estimated spend breakdown by period">
        <thead>
          <tr>
            <th>Metric</th>
            <th>Total</th>
            <th>Last 30 days</th>
            <th>Last 24 hours</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Est. input (USD)</th>
            <td>${formatUsdEstimate(spendInput.total)}</td>
            <td>${formatUsdEstimate(spendInput.last30d)}</td>
            <td>${formatUsdEstimate(spendInput.last24h)}</td>
          </tr>
          <tr>
            <th scope="row">Est. output (USD)</th>
            <td>${formatUsdEstimate(spendOutput.total)}</td>
            <td>${formatUsdEstimate(spendOutput.last30d)}</td>
            <td>${formatUsdEstimate(spendOutput.last24h)}</td>
          </tr>
          <tr>
            <th scope="row">Est. combined (USD)</th>
            <td>${formatUsdEstimate(spendCombined.total)}</td>
            <td>${formatUsdEstimate(spendCombined.last30d)}</td>
            <td>${formatUsdEstimate(spendCombined.last24h)}</td>
          </tr>
        </tbody>
      </table>
      <p class="analytics-pricing-note">${pricingFootnote}</p>
    </section>`;

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
      return `<div class="analytics-bar-col"><div class="analytics-bar-stack-wrap"><div class="analytics-bar-stack">${segs}</div><span class="analytics-bar-total">${total}</span></div><span class="analytics-bar-day">${short}</span></div>`;
    })
    .join("");

  const tokenBarsHtml = dailyTokens
    .map((day) => {
      const d = String(day?.date ?? "").trim();
      const bp = day?.byProvider && typeof day.byProvider === "object" ? day.byProvider : {};
      const short = escapeHtml(chartDayLabelMmDd(d));
      const segs = PROVIDER_IDS.map((id) => {
        const c = Number(bp[id]) || 0;
        const pct = maxTokDay > 0 ? Math.round((c / maxTokDay) * 1000) / 10 : 0;
        const title = escapeHtml(`${PROVIDER_DISPLAY[id] ?? id}: ${c.toLocaleString()}`);
        return `<div class="analytics-bar-seg analytics-bar-seg--${id}" style="height:${pct}%" title="${title}"></div>`;
      }).join("");
      const total = PROVIDER_IDS.reduce((s, id) => s + (Number(bp[id]) || 0), 0);
      const totalLabel = escapeHtml(total.toLocaleString());
      return `<div class="analytics-bar-col"><div class="analytics-bar-stack-wrap"><div class="analytics-bar-stack">${segs}</div><span class="analytics-bar-total">${totalLabel}</span></div><span class="analytics-bar-day">${short}</span></div>`;
    })
    .join("");

  const spendBarsHtml = dailyLlmTokens
    .map((day) => {
      const d = String(day?.date ?? "").trim();
      const bp = day?.byProvider && typeof day.byProvider === "object" ? day.byProvider : {};
      const short = escapeHtml(chartDayLabelMmDd(d));
      let dayUsdSum = 0;
      const segs = PROVIDER_IDS.map((id) => {
        const cell = bp[id] && typeof bp[id] === "object" ? bp[id] : {};
        const pr = Number(cell.prompt) || 0;
        const co = Number(cell.completion) || 0;
        const est = estimateProviderUsd(id, pr, co);
        const usd = est?.totalUsd ?? 0;
        dayUsdSum += usd;
        const pct = maxSpendDay > 0 ? Math.round((usd / maxSpendDay) * 1000) / 10 : 0;
        const title = escapeHtml(`${PROVIDER_DISPLAY[id] ?? id}: ${formatUsdEstimate(usd)}`);
        return `<div class="analytics-bar-seg analytics-bar-seg--${id}" style="height:${pct}%" title="${title}"></div>`;
      }).join("");
      const totalLabel = escapeHtml(formatUsdEstimate(dayUsdSum));
      return `<div class="analytics-bar-col"><div class="analytics-bar-stack-wrap"><div class="analytics-bar-stack">${segs}</div><span class="analytics-bar-total">${totalLabel}</span></div><span class="analytics-bar-day">${short}</span></div>`;
    })
    .join("");

  const rangeButtons = ([
    { id: "all", label: "All time" },
    { id: "last30d", label: "Last 30 days" },
    { id: "last24h", label: "Last 24 hours" },
  ]).map((b) => {
    const isActive = String(activeRange ?? "all") === b.id;
    return `<button type="button" class="badge analytics-range-badge${isActive ? " active" : ""}" data-analytics-range="${b.id}" aria-pressed="${
      isActive ? "true" : "false"
    }">${escapeHtml(b.label)}</button>`;
  }).join("");

  root.innerHTML = `
    <div class="analytics-inner">
      <header class="analytics-header">
        <h2 class="analytics-page-title">Analytics</h2>
        <p class="analytics-sub">Usage includes regular chats and archived counts from cleared Intro / Rules / Access threads and from deleted themes (live DB + archive).</p>
      </header>
      <div class="analytics-range-badges" role="group" aria-label="Analytics time range">
        ${rangeButtons}
      </div>
      <div class="analytics-model-grid">${cardsHtml}</div>
      ${costSummaryHtml}
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
      <section class="analytics-chart-block">
        <h3 class="analytics-section-title">Last 30 days — reported total tokens per day</h3>
        <p class="analytics-tokens-note">Includes chat replies, image generation when reported, plus background calls (Memory tree router, chat interest sketch, graph normalize, Intro graph extract) when the provider returns usage. Days or models with no usage metadata count as zero.</p>
        <div class="analytics-legend">
          ${PROVIDER_IDS.map(
            (id) =>
              `<span class="analytics-legend-item"><span class="analytics-legend-swatch analytics-bar-seg--${id}"></span>${escapeHtml(String(PROVIDER_DISPLAY[id] ?? id))}</span>`,
          ).join("")}
        </div>
        <div class="analytics-bars-wrap"><div class="analytics-bars">${tokenBarsHtml}</div></div>
      </section>
      <section class="analytics-chart-block">
        <h3 class="analytics-section-title">Last 30 days — estimated generation spend (USD) per day</h3>
        <p class="analytics-tokens-note">Uses the same illustrative per-provider rates as the cards: each day’s height compares estimated spend to the busiest day in the window. Not actual billing; days with no prompt/completion metadata count as zero.</p>
        <div class="analytics-legend">
          ${PROVIDER_IDS.map(
            (id) =>
              `<span class="analytics-legend-item"><span class="analytics-legend-swatch analytics-bar-seg--${id}"></span>${escapeHtml(String(PROVIDER_DISPLAY[id] ?? id))}</span>`,
          ).join("")}
        </div>
        <div class="analytics-bars-wrap"><div class="analytics-bars">${spendBarsHtml}</div></div>
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

/** Re-fetch analytics only when the Analytics panel is currently open. */
export async function refreshAnalyticsViewIfOpen() {
  return refreshAnalyticsViewIfOpenImpl();
}

/**
 * @param {{ fetchAnalytics: () => Promise<unknown>, appendActivityLog: (s: string) => void, prepareChatSurface: () => void }} deps
 */
export function initAnalyticsDashboard(deps) {
  const { fetchAnalytics, appendActivityLog, prepareChatSurface: prep } = deps;
  prepareChatSurface = typeof prep === "function" ? prep : () => {};

  const RANGE_STORAGE_KEY = "mf0.analytics.range";
  /** @type {"all" | "last30d" | "last24h"} */
  let activeRange = "all";
  try {
    const r = String(localStorage.getItem(RANGE_STORAGE_KEY) ?? "").trim();
    if (r === "all" || r === "last30d" || r === "last24h") activeRange = r;
  } catch {
    /* ignore */
  }

  /** @type {unknown} */
  let lastRaw = null;

  const btn = document.getElementById("btn-analytics");
  const chat = document.getElementById("main-chat");
  const view = document.getElementById("chat-analytics-view");
  const root = document.getElementById("analytics-dashboard-root");
  if (!btn || !chat || !view || !root) return;

  function wireRangeButtons() {
    root.querySelectorAll("[data-analytics-range]").forEach((b) => {
      const btnEl = b instanceof HTMLElement ? b : null;
      if (!btnEl) return;
      btnEl.addEventListener("click", () => {
        const id = String(btnEl.getAttribute("data-analytics-range") ?? "").trim();
        if (id !== "all" && id !== "last30d" && id !== "last24h") return;
        if (activeRange === id) return;
        activeRange = id;
        try {
          localStorage.setItem(RANGE_STORAGE_KEY, id);
        } catch {
          /* ignore */
        }
        if (lastRaw) {
          renderAnalytics(root, lastRaw, activeRange);
        } else {
          // Fallback: if analytics haven't loaded yet, fetch once.
          void (async () => {
            try {
              lastRaw = await fetchAnalytics();
              renderAnalytics(root, lastRaw, activeRange);
            } catch (e) {
              appendActivityLog(
                `Analytics: could not reload on range change (${e instanceof Error ? e.message : String(e)})`,
              );
            }
          })();
        }
        wireRangeButtons();
      });
    });
  }

  async function refresh() {
    try {
      if (!(await apiHealth())) {
        root.replaceChildren();
        const p = document.createElement("p");
        p.className = "analytics-error";
        p.textContent = "Connect the local API to load analytics (same as chat database).";
        root.append(p);
        return;
      }
      lastRaw = await fetchAnalytics();
      renderAnalytics(root, lastRaw, activeRange);
      wireRangeButtons();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      root.replaceChildren();
      const p = document.createElement("p");
      p.className = "analytics-error";
      p.textContent = `Could not load analytics: ${msg}`;
      root.append(p);
      appendActivityLog(`Analytics: ${msg}`);
    }
  }

  refreshAnalyticsViewIfOpenImpl = async () => {
    if (!analyticsOpen) return;
    await refresh();
  };

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
