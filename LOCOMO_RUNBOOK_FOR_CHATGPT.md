# LoCoMo Runbook for ChatGPT (MF0-1984 v1.9.2)

Use this document as an execution guide.  
Goal: run a LoCoMo-style benchmark safely on a **clean project instance** without touching production memory/history.

---

## 0) Context

- Project: **MF0-1984 (`mf-lab`)**
- Version this runbook targets: **1.9.2**
- Requirement: evaluate long-context behavior (including AI opinion mode) on an isolated dataset.

---

## 1) Safety rules (mandatory)

1. Do **not** run benchmarks against a production SQLite DB.
2. Use a **separate DB file** for benchmark runs.
3. Keep benchmark artifacts in a separate folder (`bench/locomo/runs/...`).
4. Do not modify unrelated app behavior while preparing runner scripts.
5. Before any run, print and confirm active DB path and git commit hash.

---

## 2) Environment setup checklist

From repo root:

```bash
cd /ABSOLUTE/PATH/TO/mf-lab
git rev-parse --short HEAD
npm install
```

Check API health after startup (default API port **35184**):

```bash
npm run dev
```

In another terminal:

```bash
curl -s http://127.0.0.1:35184/api/health
```

Expected JSON includes:

- `"ok": true`
- `"mfLabApi": true`

If the API uses another port (e.g. `API_PORT` in env), substitute that port in the URL.

---

## 3) Isolated DB for benchmark

Create a dedicated benchmark DB path:

```bash
mkdir -p data/bench
export API_SQLITE_PATH="./data/bench/mf-lab-locomo.sqlite"
```

Start the app with this env (API + Vite):

```bash
API_SQLITE_PATH="./data/bench/mf-lab-locomo.sqlite" npm run dev
```

Important: always log the active DB file at run start.

---

## 4) Memory tree (Дерево памяти) when saving turns via API only (v1.9.2+)

Turns posted with `POST /api/dialogs/<dialogId>/turns` do **not** run the browser Keeper. From **1.9.2**, the API can run the same **Keeper (chat)** → memory graph ingest **on the server**, but only when explicitly enabled (so normal UI usage does not double-ingest).

**Enable one of:**

**A — per turn (JSON body)** — add to each `POST …/turns` payload:

```json
"run_memory_graph_keeper": true
```

**B — whole API process** — before starting the API:

```bash
export MF_LAB_MEMORY_GRAPH_ON_API_TURNS=1
```

**OpenAI key** must be available to the **Node API** process (Vite `.env` alone is not enough for this path):

```bash
export OPENAI_API_KEY="sk-…"
```

Optional overrides:

```bash
# optional: separate key only for this keeper step
# export MF_LAB_MEMORY_GRAPH_KEEPER_OPENAI_KEY="sk-…"
# optional: model id (default for this step is gpt-4o-mini if unset)
# export MF_LAB_MEMORY_GRAPH_OPENAI_MODEL="gpt-4o-mini"
```

**Combined example** (isolated DB + memory tree on every API turn in that process):

```bash
mkdir -p data/bench
export API_SQLITE_PATH="./data/bench/mf-lab-locomo.sqlite"
export MF_LAB_MEMORY_GRAPH_ON_API_TURNS=1
export OPENAI_API_KEY="sk-…"
npm run dev
```

If you use **PM2**, put the same variables in `ecosystem.config.cjs` (or export them in the shell) and restart with `npm run pm2:restart` or `pm2 restart mf-lab-api mf-lab-vite --update-env`.

---

## 5) Data layout (recommended)

Create benchmark folders:

```bash
mkdir -p bench/locomo/data
mkdir -p bench/locomo/runs
```

Suggested files:

- `bench/locomo/data/cases.jsonl` — benchmark cases
- `bench/locomo/runner.mjs` — execution harness
- `bench/locomo/runs/<timestamp>/cases.jsonl` — per-case outputs
- `bench/locomo/runs/<timestamp>/summary.json` — aggregated metrics
- `bench/locomo/runs/<timestamp>/config.json` — run config (models/modes/commit)

---

## 6) Minimum runner behavior

Runner should:

1. Read `cases.jsonl`.
2. Replay each case as turn sequence through local MF0 chat flow (same endpoints the app uses: themes, dialogs, `POST …/turns`).
3. Support at least two modes:
   - `default`
   - `ai_opinion`
4. If the benchmark must fill **Дерево памяти** (memory graph), include `run_memory_graph_keeper: true` on each turn **or** run the API with `MF_LAB_MEMORY_GRAPH_ON_API_TURNS=1` and set `OPENAI_API_KEY` for the API process (see §4).
5. Capture per turn:
   - response text
   - latency
   - token usage (if available)
6. Save run artifacts to timestamped folder.
7. Print short summary at the end.

---

## 7) Metrics to compute

At minimum:

- `accuracy` (or rule-based score from expected answer checks)
- `long_context_retention` (facts recalled after many turns)
- `hallucination_rate`
- `median_latency_ms`
- `prompt_tokens`, `completion_tokens`, `total_tokens`

Also compute:

- `cost_per_correct` (if pricing data is available)

---

## 8) Required run metadata

Write to `config.json`:

- app version (`1.9.2`)
- git commit hash
- mode (`default` / `ai_opinion`)
- provider/model mapping
- temperature/max token controls
- db path used for the run
- whether memory graph keeper on API turns was enabled (`run_memory_graph_keeper` / `MF_LAB_MEMORY_GRAPH_ON_API_TURNS`)

---

## 9) AI opinion-specific checks

For `ai_opinion` runs verify:

1. One assistant bubble behavior in final output shaping.
2. Per-model sections are present and separated.
3. Footer has `Replied: ...` provider list.
4. Context path is active (observe activity log debug lines like `AI opinion context: ...`).

---

## 10) Acceptance criteria (first pass)

Benchmark setup is considered working if:

1. At least 30 cases run end-to-end without crashes.
2. Output artifacts are written for all cases.
3. Summary file includes all required metrics.
4. No production DB was touched.

---

## 11) What to report after run

Provide:

1. Commit hash and DB path used.
2. Number of cases executed.
3. Metric table.
4. Top 10 failure examples with case IDs.
5. 3 prioritized improvements for next iteration.

---

## 12) Prompt to ChatGPT (copy/paste)

Use the exact block below when asking ChatGPT to help execute:

```text
You are helping me run a LoCoMo-style benchmark for MF0-1984 v1.9.2.
Follow this runbook strictly:
- keep benchmark isolated from production data
- use a dedicated API_SQLITE_PATH
- if turns are saved only via POST /api/dialogs/.../turns, enable memory graph updates per §4 (run_memory_graph_keeper or MF_LAB_MEMORY_GRAPH_ON_API_TURNS + OPENAI_API_KEY on the API process)
- prepare bench/locomo/{data,runs}
- implement a minimal runner that replays cases and writes cases.jsonl + summary.json + config.json
- support both default and ai_opinion modes
- compute accuracy/retention/hallucination/latency/token metrics
- print exact commands before execution and explain expected outputs
- do not broaden scope beyond benchmark setup and run artifacts

Start by asking me for:
1) repository absolute path
2) location/format of LoCoMo cases
3) which mode to run first (default or ai_opinion)
```
