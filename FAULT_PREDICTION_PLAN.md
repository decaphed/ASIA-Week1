# Fault Prediction / Management AI Layer — Plan & Progress

This document tracks the effort to add a management-facing, cost-aware fault-prediction
capability on top of the existing pump-monitoring dashboard. It exists so a future session
(or a teammate) can pick this up without re-deriving the reasoning from scratch.

## Why this exists

Management wants three things from this system: **see faults**, **predict cost**, **predict
faults ahead of time**. Money is the overriding concern, so any output has to be *accurate*,
not just plausible-looking. That constraint shaped everything below — several tempting
shortcuts (training a classifier immediately, using a black-box model) were deliberately
rejected because they wouldn't hold up to scrutiny with the data actually available.

## The core finding that shaped the plan

An early review (data + ML engineering angle) found the obvious approach — train a supervised
classifier on the existing `dominantStatus` (RUNNING/FAULT/STOPPED) history — would produce a
model that looks sophisticated but is untrustworthy, for three concrete reasons:

1. **Label sparsity.** At the time, there were only ~23 real FAULT episodes in the whole
   history. A classifier needs low hundreds of positive examples to be evaluable, not dozens.
2. **Leakage risk.** Adjacent one-minute readings are highly autocorrelated (motorTemp's
   lag-1 autocorrelation is ~0.9 — see `server/services/driftService.js`'s own comments). A
   random or k-fold train/test split would let a model "cheat" by interpolating between
   near-duplicate neighboring minutes, making any reported accuracy fiction.
3. **Signal suppression.** The preprocessing pipeline (`server/preprocessing/pipeline.js`)
   outlier-caps and smooths raw readings before they're stored — which is exactly the kind of
   anomalous precursor signal a fault predictor would want to learn from.

There's also a standing risk of **overfitting to the simulator**: any model trained purely on
`node-red/flow.json`'s fault-injection logic learns that fake generator's quirks, not anything
resembling real pump failure physics.

**Decision:** don't train a model yet. Fix the root causes first, in stages, each one gated
on real evidence before the next begins.

## What's been done (Phases 1-3, all committed)

### Phase 0 — Baseline measurement (ongoing, re-run periodically)

Before/after each phase, count real `RUNNING -> FAULT` onset transitions in
`processed_telemetry` (one contiguous FAULT-labeled run = one episode, not one per minute).
This number is the single metric that decides whether it's time to move to model work.

| Date | Total rows | FAULT episodes |
|---|---|---|
| 2026-07-13 (session start) | 909 | 23 |
| 2026-07-13 (after Phase 1 deploy) | 957 | 24 |
| 2026-07-13 (session end) | ~965 | 25 |

Target before any model training is attempted: **~100-200 episodes.**

Re-run anytime with:
```
node server/scripts/evaluateFaultPrediction.js
```
(it prints the current episode count and will report "BLOCKED" until the gate clears).

### Phase 1 — Fault-type diversity (commit `048b7fe`)

**Problem it fixes:** raw sample-size growth rate, and simulator-overfitting risk (a single
generic fault pattern gives a model nothing to distinguish).

**What changed:**
- `node-red/flow.json` — FAULT episodes now pick one of three failure signatures at onset
  (`THERMAL`, `CAVITATION`, `BEARING`), each biasing a different, physically-sensible subset
  of the 6 metrics (e.g. THERMAL spikes `motorTemp` hard and sags `rpm`; CAVITATION collapses
  `suctionPressure`/`flowRate`/`dischargePressure` together; BEARING spikes `vibration` and
  destabilizes `rpm`).
- `server/utils/validation.js`, `server/database/schema.sql` + `db.js` migration,
  `server/models/sensorModel.js`, `server/services/sensorService.js` — the new `faultType`
  field is validated, persisted on `raw_telemetry`, and exposed through the API.
- `client/src/components/dashboard/HealthStrip.jsx` — the dashboard's Status tile now shows
  e.g. "Auto-trip - Thermal" instead of just "Auto-trip engaged".

**Why this matters for the rate, not just variety:** at the *measured* active-runtime rate
(episodes divided by actual simulator uptime, not wall-clock calendar time — the simulator
wasn't running 24/7 before this), the system produces roughly **1 fault episode per ~40
minutes of continuous runtime**, i.e. ~36/day if left running continuously. At that rate,
reaching ~100-200 episodes takes roughly **3-6 days of continuous uptime** — the main lever
is just leaving both Node-RED and the server running, not further code changes.

### Phase 2 — Pre-cap feature capture (commit `a10dd6e`)

**Problem it fixes:** signal suppression — the exact spike/rapid-change signal a fault
predictor needs is smoothed away by outlier-capping before it's ever stored.

**What changed:**
- New file `server/preprocessing/precapFeatures.js` — computes `rawStdDev`,
  `rawRateOfChange`, and `rawMaxExcursion` per metric from the **same raw array**
  `hampelCap()` consumes, before it gets smoothed.
- `server/preprocessing/pipeline.js` — calls the above inside the existing per-metric loop
  (step 7), right where the raw array already exists.
- `server/database/schema.sql` + `db.js` migration, `server/models/processedModel.js`,
  `server/services/processedService.js` — stored as one new JSON column
  `precapFeaturesByMetric` on `processed_telemetry`, following the exact existing pattern
  used for `outliersByMetric`/`violationsByMetric`.

**Why now, not later:** these features only exist for minutes recorded *after* this code
shipped. Every fault episode collected from this point forward carries the richer feature set
automatically — waiting to add this until after the data-collection run would have meant
losing that signal for everything collected in the meantime.

**Verified:** existing outputs (all capped stats, forecast/drift service outputs) are
byte-for-byte unchanged — confirmed by code review that `hampelCap()`'s inputs/call site are
untouched and that `forecastService.js`/`driftService.js`/`trendService.js` only read named
fields off the record, never spread/serialize the whole object.

### Phase 3 — Evaluation harness (commit `8777c4c`)

**Problem it fixes:** ensures that whenever a real model eventually gets trained, it can't be
evaluated in a way that produces a fake-looking-good result. Built *before* any model exists,
specifically so the discipline is mechanical (a script that refuses to run), not just
documented intent.

**What changed (all new files, nothing existing modified):**
- `server/preprocessing/evaluation/episodes.js` —
  - `MIN_ONSET_EPISODES = 100` — a hard gate, mirroring `forecastService.js`'s existing
    `MIN_READINGS = 12` guard (same failure mode: too few samples lets a fit "explain" noise
    instead of signal).
  - `identifyEpisodes(rows)` — finds contiguous FAULT runs in chronologically-ordered
    `processed_telemetry` rows.
  - `checkEvaluationGate(rows)` — `{ ready, episodeCount, required }`.
  - `walkForwardSplit(rows, opts)` — chronological, **episode-boundary** train/test split
    (never random/k-fold — that would leak via the autocorrelation problem above). The split
    point sits exactly at a test episode's onset, so no single episode is ever divided across
    train and test, and test data is always strictly later in time than train data.
- `server/preprocessing/evaluation/metrics.js` —
  - `precisionRecallAtLeadTime(predictions, episodes, opts)` — greedy-matched TP/FP/FN within
    a lead-time window before real onsets. Generic over any `{timestamp, score}[]` array, so
    it scores today's non-learned baseline and a future real classifier identically.
  - `brierScore(predictions, episodes, opts)` — calibration score (mean squared error between
    predicted probability and actual outcome).
- `server/scripts/evaluateFaultPrediction.js` — runnable via
  `node server/scripts/evaluateFaultPrediction.js`. Loads all `processed_telemetry`, checks
  the gate, and:
  - if not ready: prints the current count vs. the required 100 and **exits immediately** —
    it does not fall through to any split/model logic;
  - if ready: runs a **non-learned** baseline predictor ("did any metric's window mean cross
    its alarm threshold this minute", using the existing `server/config/thresholds.js`
    bands) through the same precision/recall/Brier functions, and prints results per
    lead-time bucket (1-5 / 6-15 / 16-30 minutes). This baseline is the number any future
    real classifier must beat at the same lead time to be worth shipping.

**Reviewed by:** an architecture pass (blueprint), a simplification pass (style
reconciliation, zero behavior change), and a correctness review that traced every edge case
(start/end-of-array episodes, boundary-row split behavior, double-counting risk in the greedy
match, gate fall-through) — zero bugs found, one unreachable-today edge case noted.

## What's next (Phases 4-6, not started — intentionally blocked)

### Phase 4 — Model (blocked on Phase 0's episode count)

Do not start until `node server/scripts/evaluateFaultPrediction.js` reports the gate as
`ready`. When it does:

1. Start with a plain **L2-regularized logistic regression** baseline on the engineered
   features (per-metric means/std/slope from `forecastService.js`, drift z-scores from
   `driftService.js`, and the new pre-cap features from Phase 2) — interpretable, hard to
   overfit, easy to explain to management.
2. Only escalate to a constrained gradient-boosted model (shallow depth, few leaves, early
   stopping) if the logistic baseline clears the promotion bar below.
3. **Promotion bar:** the model must beat `evaluateFaultPrediction.js`'s baseline
   precision/recall at the *same* lead-time bucket, or it doesn't ship. This is not
   optional — it's the whole reason Phase 3 exists.
4. New files (not yet created): `server/services/faultPredictService.js`,
   `server/models/faultPredictModel.js`, `server/controllers/faultPredictController.js`, plus
   an offline training script. Integration mirrors the existing
   `forecastService.js`/`driftService.js` pattern (event-driven via `onNewProcessedRecord`,
   cached prediction, exposed via a new route).

### Phase 5 — Simulator-overfitting mitigation (partially done)

Phase 1's fault-type variety and Phase 3's episode-boundary holdout already cover the
mechanical half of this. What's left:
- Consider randomizing fault-episode duration/severity ranges further (currently
  `randInt(15,40)` seconds for FAULT, fixed regardless of type) so episodes aren't
  timing-uniform within a type.
- Write the explicit **scope-limitation note for management**: this model is validated
  against a *simulated* pump; predictive skill on real hardware is unproven until it's fed
  real fault history. This should ship alongside Phase 4, not as an afterthought.

### Phase 6 — Cost translation + shadow rollout (blocked on Phase 4)

Only after a real model clears Phase 4's promotion bar:

1. **Shadow mode first.** Log predictions vs. realized outcomes into a new table
   (e.g. `fault_predictions(ts, probability, actualFaultWithinH, ...)`). No dollar figures
   shown to anyone yet.
2. **Cost-translation layer** (`server/config/costModel.js` + `server/services/costService.js`):
   fixed, auditable business-rule constants — `DOWNTIME_COST_PER_HOUR`,
   `FALSE_ALARM_COST`, `PLANNED_MAINT_COST`, `AVG_FAULT_DOWNTIME_HOURS` — combined with the
   model's calibrated probability to produce `estimatedRiskUSD` and a money-derived alert
   threshold (alert when the expected cost of acting is less than the expected cost of
   waiting — not an arbitrary 0.5 probability cutoff).
3. **Go-live gate:** only promote out of shadow mode once realized precision/recall and
   calibration (Brier score) over live data confirm the backtested numbers hold up, and only
   then do dollar estimates reach the management-facing dashboard.

## How to pick this back up

1. Re-run `node server/scripts/evaluateFaultPrediction.js` to see the current episode count.
2. If still below 100: no code work needed, just keep both Node-RED and the server running.
   Consider whether the fault-injection frequency in `node-red/flow.json` (currently `0.3%`
   chance per RUNNING second) should be increased if waiting is impractical — this trades
   "realism" for faster data collection and would need to be flagged as a caveat on any
   resulting model.
3. If at or above 100: start Phase 4 as scoped above, using
   `server/preprocessing/evaluation/episodes.js` and `metrics.js` as the evaluation
   foundation — do not rebuild evaluation logic from scratch.
