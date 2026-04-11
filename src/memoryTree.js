import ForceGraph3D from "3d-force-graph";
import SpriteText from "three-spritetext";
import "./memoryTree.css";

let closeMemoryTreeImpl = () => {};

/** Close Memory tree view and return to chat (no-op if already closed). */
export function closeMemoryTree() {
  closeMemoryTreeImpl();
}

/** Memory graph groups (order = legend & filter). */
const GROUP_PALETTE = [
  { key: "People", color: "#a78bfa" },
  { key: "Dates", color: "#f472b6" },
  { key: "Interests", color: "#34d399" },
  { key: "Documents", color: "#fbbf24" },
  { key: "Cities", color: "#fb7185" },
  { key: "Companies", color: "#38bdf8" },
  { key: "Projects", color: "#60a5fa" },
  { key: "Data", color: "#2dd4bf" },
];

function orderedGroupKeysFromNodes(nodes) {
  const present = new Set(nodes.map((n) => n.group));
  const ordered = GROUP_PALETTE.map((g) => g.key).filter((k) => present.has(k));
  const rest = [...present].filter((k) => !GROUP_PALETTE.some((g) => g.key === k)).sort();
  return [...ordered, ...rest];
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Demo data; replace with JSON/API and call `setMemoryGraphData`. */
export function makeFakeData() {
  const nodes = [];
  const links = [];

  const namePools = {
    People: ["Alex", "Mira", "Noah", "Luna", "Victor", "Eva", "Leo", "Ada", "Max", "Iris", "Nora", "Felix"],
    Dates: [
      "2024-01-15",
      "Q2 2026",
      "FY2025 close",
      "March workshop",
      "Sprint week 12",
      "Release day",
      "Board session",
      "Quarterly review",
    ],
    Interests: [
      "Machine learning",
      "Brand strategy",
      "Open data",
      "Go-to-market",
      "UX research",
      "Compliance",
      "Hiring",
      "Infrastructure",
    ],
    Documents: ["Brief", "Contract", "Memo", "Spec", "Report", "Policy", "Deck", "Minutes", "Addendum", "Whitepaper"],
    Cities: ["Berlin", "Tokyo", "Paphos", "London", "Toronto", "Dubai", "Tallinn", "Lisbon", "Seoul", "Austin"],
    Companies: ["Nova", "Quantum", "Blue", "Hyper", "Zenith", "Orbital", "Atlas", "Neon", "Polar", "Vanta", "Prism", "Velvet"],
    Projects: ["Helix", "Pulse", "Vertex", "Signal", "Drift", "Echo", "Fusion", "Core", "Orbit", "Nexus"],
    Data: ["Events", "Embeddings", "Sales", "CRM", "Logs", "Metrics", "Inventory", "Feedback", "Pipeline", "Archive"],
  };

  const docTags = ["Alpha", "Beta", "v3", "2026", "Draft", "Final", "Signed", "Internal"];

  const COUNTS = {
    People: 6,
    Dates: 4,
    Interests: 4,
    Documents: 4,
    Cities: 2,
    Companies: 4,
    Projects: 4,
    Data: 3,
  };

  let idCounter = 1;

  GROUP_PALETTE.forEach((group) => {
    const count = COUNTS[group.key] ?? 3;

    for (let i = 0; i < count; i++) {
      const a = pick(namePools[group.key]);
      const b = pick(namePools[group.key]);
      const name =
        group.key === "People"
          ? `${a} ${["Stone", "Vale", "Cross", "Blake", "Hart", "Snow", "Lane", "Fox"][rand(0, 7)]}`
          : group.key === "Dates" || group.key === "Interests"
            ? a
            : group.key === "Documents"
              ? `${a} · ${pick(docTags)}`
              : group.key === "Cities"
                ? a
                : `${a} ${b}`;

      const size =
        group.key === "Cities"
          ? rand(7, 12)
          : group.key === "Data" || group.key === "Documents"
            ? rand(6, 10)
            : rand(4, 9);

      nodes.push({
        id: `n${idCounter++}`,
        name,
        group: group.key,
        color: group.color,
        size,
        score: rand(10, 100),
        year: rand(2016, 2026),
        description: `Name: ${name}
Group: ${group.key}
Influence index: ${rand(100, 999)}
Activity: ${rand(1, 10)}/10
Updated: ${rand(1, 28)}.${String(rand(1, 12)).padStart(2, "0")}.2026

Fictitious entity for the Memory tree demo.`,
      });
    }
  });

  const byGroup = {};
  GROUP_PALETTE.forEach((g) => {
    byGroup[g.key] = nodes.filter((n) => n.group === g.key);
  });

  function connectMany(sourceGroup, targetGroup, minLinks, maxLinks, labelPool) {
    byGroup[sourceGroup].forEach((source) => {
      const amount = rand(minLinks, maxLinks);
      const used = new Set();

      for (let i = 0; i < amount; i++) {
        const target = pick(byGroup[targetGroup]);
        if (!target || target.id === source.id || used.has(target.id)) continue;

        used.add(target.id);

        links.push({
          source: source.id,
          target: target.id,
          label: pick(labelPool),
          strength: Math.random() * 0.8 + 0.2,
        });
      }
    });
  }

  connectMany("People", "Companies", 1, 2, ["works at", "advises", "founded"]);
  connectMany("People", "Projects", 1, 2, ["leads", "contributes to", "owns"]);
  connectMany("People", "Interests", 1, 3, ["interested in", "focuses on", "tracks"]);
  connectMany("People", "Documents", 1, 2, ["authored", "mentioned in", "signed"]);
  connectMany("People", "Dates", 1, 2, ["milestone", "met on", "scheduled"]);
  connectMany("People", "Cities", 1, 2, ["based in", "visited", "relocated to"]);
  connectMany("Companies", "Cities", 1, 2, ["headquartered in", "operates in", "expanded to"]);
  connectMany("Companies", "Projects", 1, 3, ["sponsors", "runs", "commissions"]);
  connectMany("Projects", "Data", 1, 3, ["uses", "produces", "validated by"]);
  connectMany("Documents", "Projects", 1, 2, ["belongs to", "specifies", "gates"]);
  connectMany("Documents", "Data", 1, 2, ["references", "exports", "derived from"]);
  connectMany("Interests", "Projects", 1, 2, ["related to", "drives", "informs"]);
  connectMany("Dates", "Projects", 1, 2, ["deadline for", "kickoff", "review on"]);
  connectMany("People", "People", 1, 2, ["knows", "reports to", "collaborates with"]);
  connectMany("Companies", "Companies", 1, 2, ["partners with", "supplies", "acquired"]);

  const dedup = new Set();
  const uniqueLinks = links.filter((link) => {
    const a = typeof link.source === "object" ? link.source.id : link.source;
    const b = typeof link.target === "object" ? link.target.id : link.target;
    const key = [a, b, link.label].sort().join("|");
    if (dedup.has(key)) return false;
    dedup.add(key);
    return true;
  });

  return { nodes, links: uniqueLinks };
}

function normalizeLinkEnd(v) {
  if (v && typeof v === "object" && "id" in v) return String(v.id);
  return String(v);
}

function cloneGraphPayload(src) {
  if (!src?.nodes || !src?.links) {
    return { nodes: [], links: [] };
  }
  return {
    nodes: src.nodes.map((n) => ({ ...n })),
    links: src.links.map((l) => {
      const out = { ...l };
      out.source = normalizeLinkEnd(l.source);
      out.target = normalizeLinkEnd(l.target);
      return out;
    }),
  };
}

function colorForGroup(groupKey, seen) {
  const fromPalette = GROUP_PALETTE.find((g) => g.key === groupKey);
  if (fromPalette) return fromPalette.color;
  const node = seen.get(groupKey);
  if (node?.color) return node.color;
  const idx = Math.max(0, [...seen.keys()].indexOf(groupKey));
  const fallback = ["#94a3b8", "#e879f9", "#2dd4bf", "#fbbf24", "#f472b6"];
  return fallback[idx % fallback.length];
}

/** @type {{ nodes: object[], links: object[] } | null} */
let dataBaseline = null;
let graphData = { nodes: [], links: [] };
/** @type {ReturnType<ForceGraph3D> | null} */
let Graph = null;
let autoRotate = true;
let rafId = 0;
let angle = 0;
let resizeObserver = null;
let selectedNode = null;
const highlightedNodes = new Set();
const highlightedLinks = new Set();

/** @type {MutationObserver | null} */
let memoryGraphThemeObserver = null;

function isGraphDarkMode() {
  return document.documentElement.classList.contains("dark");
}

function createNodeThreeObject() {
  return (node) => {
    const sprite = new SpriteText(node.name);
    sprite.color = node.color;
    sprite.textHeight = highlightedNodes.has(node) ? 8 : 5;
    sprite.material.depthWrite = false;
    sprite.backgroundColor = isGraphDarkMode() ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.92)";
    sprite.padding = 2;
    return sprite;
  };
}

function refreshMemoryGraphTheme() {
  if (!Graph) return;
  Graph.nodeThreeObject(createNodeThreeObject());
  Graph.linkOpacity(isGraphDarkMode() ? 0.22 : 0.32);
  Graph.refresh();
}

function ensureMemoryGraphThemeObserver() {
  if (memoryGraphThemeObserver || typeof MutationObserver === "undefined") return;
  memoryGraphThemeObserver = new MutationObserver(() => {
    if (!Graph) return;
    refreshMemoryGraphTheme();
  });
  memoryGraphThemeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

let dom = {
  graphHost: null,
  sidePanel: null,
  chat: null,
  sidebar: null,
  dialoguesPanel: null,
  dialoguesHeader: null,
  expandCue: null,
  graphRoot: null,
  graphWrap: null,
  statNodes: null,
  statLinks: null,
  statGroups: null,
  searchInput: null,
  groupFilter: null,
  linkDistanceRange: null,
  chargeRange: null,
  detailsBox: null,
  legend: null,
};

function defaultDetailsHtml() {
  return `<div class="mt-details-title">Node details</div><div class="mt-details-text">Click a node to see details.</div>`;
}

function fillLegendAndGroups() {
  if (!dataBaseline || !dom.legend || !dom.groupFilter) return;

  const seen = new Map();
  for (const n of dataBaseline.nodes) {
    if (!seen.has(n.group)) seen.set(n.group, n);
  }
  const keys = orderedGroupKeysFromNodes(dataBaseline.nodes);

  dom.legend.replaceChildren();
  for (const key of keys) {
    const item = document.createElement("div");
    item.className = "mt-legend-item";
    const dot = document.createElement("span");
    dot.className = "mt-dot";
    dot.style.background = colorForGroup(key, seen);
    const span = document.createElement("span");
    span.textContent = key;
    item.append(dot, span);
    dom.legend.append(item);
  }

  const sel = dom.groupFilter;
  const keep = sel.value;
  sel.replaceChildren();
  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = "All groups";
  sel.append(optAll);
  for (const key of keys) {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = key;
    sel.append(o);
  }
  if (keys.includes(keep)) sel.value = keep;
  else sel.value = "all";
}

function updateStats(data) {
  if (dom.statNodes) dom.statNodes.textContent = String(data.nodes.length);
  if (dom.statLinks) dom.statLinks.textContent = String(data.links.length);
  if (dom.statGroups) dom.statGroups.textContent = String(new Set(data.nodes.map((n) => n.group)).size);
}

function clearHighlight() {
  highlightedNodes.clear();
  highlightedLinks.clear();
}

function setNodeDetails(node) {
  if (!dom.detailsBox) return;
  dom.detailsBox.innerHTML = "";
  const t = document.createElement("div");
  t.className = "mt-details-title";
  t.textContent = node.name ?? "";
  const tx = document.createElement("div");
  tx.className = "mt-details-text";
  tx.textContent = node.description ?? "";
  dom.detailsBox.append(t, tx);
}

function handleNodeHover(node) {
  if (!Graph) return;

  if (!node && !selectedNode) {
    clearHighlight();
    Graph.refresh();
    return;
  }

  const focusNode = node || selectedNode;
  clearHighlight();
  highlightedNodes.add(focusNode);

  graphData.links.forEach((link) => {
    const sourceId = normalizeLinkEnd(link.source);
    const targetId = normalizeLinkEnd(link.target);

    if (sourceId === focusNode.id || targetId === focusNode.id) {
      highlightedLinks.add(link);

      const sourceNode = graphData.nodes.find((n) => n.id === sourceId);
      const targetNode = graphData.nodes.find((n) => n.id === targetId);

      if (sourceNode) highlightedNodes.add(sourceNode);
      if (targetNode) highlightedNodes.add(targetNode);
    }
  });

  Graph.refresh();
}

function handleNodeClick(node) {
  if (!Graph) return;
  selectedNode = node;
  setNodeDetails(node);
  handleNodeHover(node);

  const distance = 110;
  const distRatio = 1 + distance / Math.hypot(node.x || 1, node.y || 1, node.z || 1);

  Graph.cameraPosition(
    {
      x: (node.x || 0) * distRatio,
      y: (node.y || 0) * distRatio,
      z: (node.z || 0) * distRatio,
    },
    node,
    1200,
  );
}

function applyFilters() {
  if (!Graph || !dataBaseline) return;

  const query = (dom.searchInput?.value ?? "").trim().toLowerCase();
  const group = dom.groupFilter?.value ?? "all";

  const filteredNodes = dataBaseline.nodes
    .filter((node) => {
      const okGroup = group === "all" || node.group === group;
      const okQuery = !query || String(node.name).toLowerCase().includes(query);
      return okGroup && okQuery;
    })
    .map((n) => ({ ...n }));

  const allowedIds = new Set(filteredNodes.map((n) => n.id));
  const filteredLinks = dataBaseline.links
    .filter((link) => {
      const sourceId = normalizeLinkEnd(link.source);
      const targetId = normalizeLinkEnd(link.target);
      return allowedIds.has(sourceId) && allowedIds.has(targetId);
    })
    .map((l) => ({ ...l, source: normalizeLinkEnd(l.source), target: normalizeLinkEnd(l.target) }));

  graphData = { nodes: filteredNodes, links: filteredLinks };

  selectedNode = null;
  clearHighlight();

  Graph.graphData(graphData);
  updateStats(graphData);

  if (dom.detailsBox) dom.detailsBox.innerHTML = defaultDetailsHtml();
}

function sizeGraphToContainer() {
  if (!Graph || !dom.graphWrap) return;
  const w = dom.graphWrap.clientWidth;
  const h = dom.graphWrap.clientHeight;
  if (w > 0 && h > 0) {
    Graph.width(w);
    Graph.height(h);
  }
}

function stopSpin() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

function spinLoop() {
  if (!Graph || !dom.graphHost || dom.graphHost.hasAttribute("hidden")) {
    rafId = 0;
    return;
  }

  if (autoRotate) {
    angle += 0.0012;
    const r = 520;
    Graph.cameraPosition({
      x: Math.sin(angle) * r,
      z: Math.cos(angle) * r,
    });
  }

  rafId = requestAnimationFrame(spinLoop);
}

function startSpin() {
  if (rafId) return;
  rafId = requestAnimationFrame(spinLoop);
}

function mountGraph() {
  if (Graph || !dom.graphRoot || !dataBaseline) return;

  graphData = cloneGraphPayload(dataBaseline);

  Graph = ForceGraph3D()(dom.graphRoot)
    .backgroundColor("rgba(0,0,0,0)")
    .graphData(graphData)
    .nodeLabel((node) => `${node.name} (${node.group})`)
    .nodeRelSize(4)
    .nodeVal((node) => node.size)
    .nodeOpacity(0.95)
    .linkOpacity(isGraphDarkMode() ? 0.22 : 0.32)
    .linkWidth((link) => (highlightedLinks.has(link) ? 2.8 : 0.7))
    .linkDirectionalParticles((link) => (highlightedLinks.has(link) ? 4 : 1))
    .linkDirectionalParticleWidth((link) => (highlightedLinks.has(link) ? 2.2 : 0.7))
    .linkDirectionalParticleSpeed((link) => (highlightedLinks.has(link) ? 0.01 : 0.0025))
    .linkColor((link) => {
      const dark = isGraphDarkMode();
      if (highlightedLinks.has(link)) return dark ? "#ffffff" : "#0f172a";
      return dark ? "rgba(255,255,255,0.25)" : "rgba(15, 23, 42, 0.22)";
    })
    .linkDirectionalArrowLength(2.5)
    .linkDirectionalArrowRelPos(1)
    .enableNodeDrag(true)
    .cooldownTicks(160)
    .d3VelocityDecay(0.22)
    .onNodeClick(handleNodeClick)
    .onNodeHover(handleNodeHover)
    .nodeThreeObject(createNodeThreeObject())
    .nodeColor((node) => {
      const dark = isGraphDarkMode();
      if (selectedNode && node.id === selectedNode.id) return dark ? "#ffffff" : "#1e40af";
      if (highlightedNodes.size > 0 && !highlightedNodes.has(node)) {
        return dark ? "rgba(120,120,120,0.35)" : "rgba(148,163,184,0.5)";
      }
      return node.color;
    });

  Graph.d3Force("charge").strength(-140);
  Graph.d3Force("link").distance(110);

  Graph.cameraPosition({ z: 520 });

  Graph.onEngineStop(() => Graph.zoomToFit(500, 60));

  if (dom.linkDistanceRange) {
    Graph.d3Force("link").distance(Number(dom.linkDistanceRange.value));
  }
  if (dom.chargeRange) {
    Graph.d3Force("charge").strength(Number(dom.chargeRange.value));
  }

  sizeGraphToContainer();

  if (dom.graphWrap && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => sizeGraphToContainer());
    resizeObserver.observe(dom.graphWrap);
  }

  window.addEventListener("resize", sizeGraphToContainer);

  fillLegendAndGroups();
  updateStats(graphData);
  if (dom.detailsBox) dom.detailsBox.innerHTML = defaultDetailsHtml();

  dom.searchInput?.addEventListener("input", applyFilters);
  dom.groupFilter?.addEventListener("change", applyFilters);

  dom.linkDistanceRange?.addEventListener("input", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !Graph) return;
    Graph.d3Force("link").distance(Number(t.value));
    Graph.numDimensions(3);
    Graph.refresh();
  });

  dom.chargeRange?.addEventListener("input", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !Graph) return;
    Graph.d3Force("charge").strength(Number(t.value));
    Graph.numDimensions(3);
    Graph.refresh();
  });

  document.getElementById("mt-btn-random")?.addEventListener("click", () => {
    if (!graphData.nodes.length) return;
    handleNodeClick(pick(graphData.nodes));
  });

  document.getElementById("mt-btn-reset")?.addEventListener("click", () => {
    if (!Graph || !dataBaseline) return;
    if (dom.searchInput) dom.searchInput.value = "";
    if (dom.groupFilter) dom.groupFilter.value = "all";
    selectedNode = null;
    clearHighlight();
    graphData = cloneGraphPayload(dataBaseline);
    Graph.graphData(graphData);
    updateStats(graphData);
    if (dom.detailsBox) dom.detailsBox.innerHTML = defaultDetailsHtml();
  });

  document.getElementById("mt-btn-spin")?.addEventListener("click", () => {
    autoRotate = !autoRotate;
  });

  startSpin();

  ensureMemoryGraphThemeObserver();
}

/**
 * @param {{ nodes: object[], links: object[] }} data
 */
export function setMemoryGraphData(data) {
  dataBaseline = cloneGraphPayload(data);
  fillLegendAndGroups();

  if (!Graph) return;

  selectedNode = null;
  clearHighlight();
  if (dom.searchInput) dom.searchInput.value = "";
  if (dom.groupFilter) dom.groupFilter.value = "all";
  graphData = cloneGraphPayload(dataBaseline);
  Graph.graphData(graphData);
  updateStats(graphData);
  if (dom.detailsBox) dom.detailsBox.innerHTML = defaultDetailsHtml();
  Graph.zoomToFit?.(400, 60);
}

/**
 * @param {(text: string) => void} appendActivityLog
 */
export function initMemoryTree(appendActivityLog) {
  dom = {
    graphHost: document.getElementById("memory-tree-graph-host"),
    sidePanel: document.getElementById("memory-tree-side-panel"),
    chat: document.getElementById("main-chat"),
    sidebar: document.getElementById("main-sidebar"),
    dialoguesPanel: document.getElementById("dialogues-panel"),
    dialoguesHeader: document.getElementById("dialogues-panel-header"),
    expandCue: document.getElementById("dialogues-mt-expand-cue"),
    graphRoot: document.getElementById("memory-graph-root"),
    graphWrap: document.querySelector("#memory-tree-graph-host .memory-tree-graph-wrap-inner"),
    statNodes: document.getElementById("mt-stat-nodes"),
    statLinks: document.getElementById("mt-stat-links"),
    statGroups: document.getElementById("mt-stat-groups"),
    searchInput: document.getElementById("mt-search"),
    groupFilter: document.getElementById("mt-group-filter"),
    linkDistanceRange: document.getElementById("mt-link-distance"),
    chargeRange: document.getElementById("mt-charge"),
    detailsBox: document.getElementById("mt-details"),
    legend: document.getElementById("mt-legend"),
  };

  if (!dom.graphHost || !dom.graphRoot || !dom.sidePanel || !dom.chat) {
    closeMemoryTreeImpl = () => {};
    return;
  }

  dataBaseline = cloneGraphPayload(makeFakeData());

  const openBtn = document.getElementById("btn-memory-tree");

  function setOpen(open) {
    if (open) {
      const irChat = document.getElementById("main-chat");
      if (irChat) {
        const irPanels = [
          { className: "chat--intro", viewId: "chat-intro-view", btnId: "btn-ir-intro" },
          { className: "chat--rules", viewId: "chat-rules-view", btnId: "btn-ir-rules" },
          { className: "chat--access", viewId: "chat-access-view", btnId: "btn-ir-access" },
        ];
        if (irPanels.some((p) => irChat.classList.contains(p.className))) {
          for (const p of irPanels) {
            irChat.classList.remove(p.className);
            document.getElementById(p.viewId)?.setAttribute("hidden", "");
            document.getElementById(p.viewId)?.setAttribute("aria-hidden", "true");
            document.getElementById(p.btnId)?.setAttribute("aria-expanded", "false");
          }
        }
      }
      dom.chat.classList.add("chat--memory-tree");
      dom.sidebar?.classList.add("sidebar--memory-tree-active");
      dom.dialoguesPanel?.classList.add("dialogues-panel--mt-collapsed");
      dom.graphHost.removeAttribute("hidden");
      dom.graphHost.setAttribute("aria-hidden", "false");
      dom.sidePanel.removeAttribute("hidden");
      dom.sidePanel.setAttribute("aria-hidden", "false");
      dom.expandCue?.removeAttribute("hidden");
      dom.expandCue?.setAttribute("aria-hidden", "false");
      dom.dialoguesHeader?.setAttribute("title", "Back to chat");

      mountGraph();
      requestAnimationFrame(() => {
        sizeGraphToContainer();
        Graph?.zoomToFit?.(400, 60);
      });
      startSpin();
      appendActivityLog("Memory tree: opened");
    } else {
      if (!dom.chat.classList.contains("chat--memory-tree")) return;
      dom.chat.classList.remove("chat--memory-tree");
      dom.sidebar?.classList.remove("sidebar--memory-tree-active");
      dom.dialoguesPanel?.classList.remove("dialogues-panel--mt-collapsed");
      dom.graphHost.setAttribute("hidden", "");
      dom.graphHost.setAttribute("aria-hidden", "true");
      dom.sidePanel.setAttribute("hidden", "");
      dom.sidePanel.setAttribute("aria-hidden", "true");
      dom.expandCue?.setAttribute("hidden", "");
      dom.expandCue?.setAttribute("aria-hidden", "true");
      dom.dialoguesHeader?.removeAttribute("title");

      stopSpin();
      appendActivityLog("Memory tree: closed");
    }
  }

  closeMemoryTreeImpl = () => {
    if (!dom.chat.classList.contains("chat--memory-tree")) return;
    setOpen(false);
    openBtn?.focus();
  };

  function exitFromHeaderCapture(e) {
    if (!dom.chat.classList.contains("chat--memory-tree")) return;
    e.stopPropagation();
    setOpen(false);
    openBtn?.focus();
  }

  dom.dialoguesHeader?.addEventListener("click", exitFromHeaderCapture, true);

  openBtn?.addEventListener("click", () => {
    const next = dom.graphHost.hasAttribute("hidden");
    setOpen(next);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!dom.chat.classList.contains("chat--memory-tree")) return;
    setOpen(false);
    openBtn?.focus();
  });
}
