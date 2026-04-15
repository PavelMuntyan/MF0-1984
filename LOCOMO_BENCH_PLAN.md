# LoCoMo Benchmark Plan for MF0-1984 (`mf-lab`)

This plan is a practical checklist to evaluate MF0-1984 on LoCoMo-like long-conversation memory tasks and convert results into product improvements.

---

## 1) Benchmark Goals

Define success before running:

- Measure long-context factual consistency across multi-turn dialogs.
- Measure memory utility (how well persistent context helps later answers).
- Measure cost/latency trade-offs by provider and mode.
- Compare baseline vs. candidate configurations with reproducible settings.

Primary question:
**Does MF0-1984 preserve and use conversation facts correctly over long spans while staying efficient?**

---

## 2) Scope to Evaluate

Run at least these scenarios:

- **Default single-model chat** (current active provider).
- **AI opinion mode** (multi-model panel in one bubble).
- **With Memory tree pipeline enabled** (Keeper chat-interest extraction + ingest).

Optional:

- Intro / Rules / Access scoped chats for domain-specific behavior checks.

---

## 3) Evaluation Dimensions

Track all runs with the same metric schema:

- **Answer correctness**: does the response match expected facts?
- **Consistency over distance**: does the model keep facts introduced many turns earlier?
- **Hallucination rate**: unsupported claims per dialog.
- **Citation/grounding quality** (if applicable).
- **Latency**: time to first token, time to final token.
- **Token usage and cost**: prompt/completion/total and estimated USD.

Recommended headline KPIs:

- `long_context_accuracy`
- `fact_retention_at_k_turns` (e.g., k = 20, 40, 80)
- `cost_per_correct_answer`
- `median_time_to_first_token_ms`

---

## 4) Dataset and Mapping

Prepare a deterministic mapping from LoCoMo samples to MF0 inputs:

1. Convert each benchmark case into:
   - initial prompt/context
   - user turn sequence
   - expected answers / checks
2. Preserve sample IDs for traceability.
3. Keep split metadata (dev/test) separated.

Store mapping artifacts in a dedicated folder, for example:

- `bench/locomo/data/`
- `bench/locomo/cases.jsonl`

---

## 5) Execution Harness (Runner)

Build a small runner script (Node.js) that:

1. Replays each case turn-by-turn against MF0 chat API path.
2. Captures:
   - raw model outputs
   - per-turn usage
   - timestamps
   - final scored metrics
3. Writes one JSONL record per case + one summary JSON per run.

Suggested output structure:

- `bench/locomo/runs/<timestamp>/cases.jsonl`
- `bench/locomo/runs/<timestamp>/summary.json`
- `bench/locomo/runs/<timestamp>/config.json`

---

## 6) Config Matrix

Start with a minimal matrix:

- `baseline_main_default_chat`
- `baseline_main_ai_opinion`
- `candidate_<branch_or_commit>_default_chat`
- `candidate_<branch_or_commit>_ai_opinion`

Pin run metadata:

- git commit SHA
- app version
- selected providers
- model IDs per provider
- temperature and max token settings

---

## 7) Scoring and QA Rules

Use deterministic grading where possible:

- Exact-match for factual slots when available.
- Structured judge rubric for free-form answers (binary + partial credit fields).
- Same judge model/settings for all compared runs.

Add sanity checks:

- Fail run if any sample missing output.
- Flag outliers (very short/empty responses, extreme token spikes).

---

## 8) Reporting Template

For each run, produce:

1. **Executive summary** (5-10 lines):
   - what improved/regressed
2. **Metric table**:
   - accuracy/retention/hallucination/cost/latency
3. **Error taxonomy**:
   - missed recall
   - conflicting facts
   - overgeneralization
   - tool/citation misuse
4. **Top 10 failure examples** with sample IDs.
5. **Action list** ranked by expected impact.

---

## 9) Integration Backlog (after first run)

Based on results, prioritize fixes in this order:

1. Prompt/context assembly issues (highest leverage).
2. Memory ingest/retrieval thresholds.
3. Provider routing/order tuning.
4. UI/flow adjustments that reduce ambiguity for long threads.

Track each fix with:

- expected KPI impact
- implementation complexity
- validation scenario in LoCoMo rerun

---

## 10) Minimal First Milestone (1-2 days)

Ship quickly:

1. Build the runner for one chat mode (default).
2. Run 30-50 representative LoCoMo samples.
3. Generate summary report + top failures.
4. Define next two code changes from evidence.

Then expand to AI opinion mode and full dataset.

---

## Notes for MF0-1984 specifics

- Keep logs compatible with existing analytics and usage tracking.
- Include `request_type`/mode in run outputs so AI opinion vs default can be compared directly.
- Preserve conversation order exactly as rendered to avoid replay/scoring artifacts.
- Ensure interest extraction side effects (Memory tree ingest) are either:
  - intentionally enabled and measured, or
  - explicitly disabled for pure model-only baselines.
