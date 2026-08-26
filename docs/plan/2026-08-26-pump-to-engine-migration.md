# Implementation Plan: Pump → Engine Domain Migration

**Date:** 2026-08-26
**Status:** DRAFT — Q1, Q3, Q4 resolved (see §6, §12). Only Q2 (contingency if `Engine_Condition` classes prove statistically indistinguishable) and Q5–Q9 remain open; Q2 cannot be answered until Phase 0 produces its findings. Phase 0 may begin.
**Supersedes (partially):** `docs/plan/2026-08-05-pdm-implementation.md` domain sections, `docs/superpowers/plans/2026-08-23-training-csv-upload.md`

## 1. Overview

The entire application models a **centrifugal pump** with six metrics (`flowRate`, `rpm`, `vibration`, `suctionPressure`, `dischargePressure`, `motorTemp`) that exist nowhere in the project's only real dataset. The real dataset, `data/train.csv` (15,628 rows), is **engine** telemetry with six different columns plus a binary `Engine_Condition` label. Zero code in the repo references those real column names; `data/train.csv` is effectively orphaned, and `pdm/app/training.py`'s `TRAIN_CSV_COLUMN_MAP` maps a *fictional* pump-shaped CSV that does not exist on disk — `fit_model()` against the committed file raises `ValueError` today.

This plan migrates the canonical domain model from pump to engine, in dependency order, and repairs the in-flight training-CSV-upload feature as part of that migration rather than as separate work.

### 1.1 The single most important structural finding

**The metric count stays at exactly six.** This is a large, load-bearing de-risker that should shape the whole approach:

| Structure | Today | After migration |
|---|---|---|
| `pdm/app/features.py` `FEATURE_ORDER` | 6 keys | 6 keys |
| `processed_telemetry` aggregate columns | 6 × {Mean,Median,Min,Max,StdDev,Last} = 36 | 36 |
| `raw_telemetry` metric columns | 6 | 6 |
| `pdm/app/schemas.py` typed metric fields | 62 occurrences | same count |
| Tier 2 model input vector shape | 6 (bootstrap) / 54 (corpus) | unchanged |

Therefore the migration is **overwhelmingly a rename + re-range + re-physics exercise**, not a re-architecture. Vector shapes, aggregation math, window logic, drift/trend algorithms, Hampel filtering, and the model interface are all shape-preserving. The genuinely *new* design work is confined to four places:

1. Cross-variable physics rules (`pdm/app/preprocessing/validator.py`)
2. Fault profiles in the simulator (`node-red/flow.json`)
3. Fault-type taxonomy (`client/src/utils/constants.js` `FAULT_TYPES` + server enum + DB check constraints)
4. `client/src/components/ProcessSchematic.jsx` (a pump P&ID has no direct engine analogue)

Everything else is mechanical.

## 2. Proposed Canonical Metric Set

Naming follows the existing repo convention: camelCase internal keys, quoted camelCase Postgres identifiers, `{metric}{Mean|Median|Min|Max|StdDev|Last}` aggregate suffixes.

| `data/train.csv` column | Proposed internal key | Short | Unit | Notes |
|---|---|---|---|---|
| `Engine_RPM` | `engineRpm` | `RPM` | RPM | Integer-valued in CSV; store DOUBLE PRECISION anyway (consistent with existing schema rationale). Do **not** reuse the bare key `rpm` — see §2.1. |
| `Lub_Oil_Pressure` | `lubOilPressure` | `OIL-P` | bar | Unit **unlabeled in the CSV** — see §2.2. |
| `Fuel_Pressure` | `fuelPressure` | `FUEL-P` | bar | Unit unlabeled — see §2.2. |
| `Coolant_Pressure` | `coolantPressure` | `CLT-P` | bar | Unit unlabeled — see §2.2. |
| `Lub_Oil_Temperature` | `lubOilTemperature` | `OIL-T` | °C | Values ~74–85 in sample rows, consistent with °C. |
| `Coolant_Temperature` | `coolantTemperature` | `CLT-T` | °C | Values ~70–88 in sample rows, consistent with °C. |
| `Engine_Condition` | `engineCondition` (label, not a metric) | — | 0/1 | **Polarity unverified — see §5.** Never enters `FEATURE_ORDER`. |

### 2.1 Why `engineRpm`, not `rpm`

`rpm` is the existing pump key. Reusing it would make every diff invisible to `grep`, would let stale pump-shaped rows and fixtures silently type-check against the new schema, and would leave no way to detect an un-migrated call site. **Rename every one of the six keys, including the one that is conceptually "the same" metric.** A total rename means any surviving pump identifier is a compile/test failure rather than a silent data corruption.

### 2.2 Units are NOT known and must not be guessed in code comments

None of `Lub_Oil_Pressure`, `Fuel_Pressure`, `Coolant_Pressure`, `Lub_Oil_Temperature`, `Coolant_Temperature` carry units in the CSV header or in any repo document. The magnitudes (oil pressure ~2.2–6.0, fuel pressure ~4.0–9.5, coolant pressure ~0.7–4.5) are *plausible* as bar but equally plausible as another unit or as normalized/synthetic values.

**Action:** in `engine-physics.yaml`, write units as `# bar (ASSUMED — unlabeled in data/train.csv, not confirmed against any instrumentation spec)`. Do not propagate a confident unit string into UI labels until §12 Q5 is answered. The existing `pump-physics.yaml` already models this honesty pattern with its `PROVISIONAL` header — extend it, do not drop it.

### 2.3 Physical ranges MUST be derived empirically, not guessed

There is **no source in this repo** for plausible physical bounds on these six engine sensors. `pump-physics.yaml`'s bounds were reasoned from the simulator's own output, which will not exist for the engine domain until Phase 5.

Ranges must be derived from `data/train.csv` itself, per column, via a documented reproducible procedure (Phase 0). Proposed rule:

- **Hard bounds** (`engine-physics.yaml`, for ingest hard-reject and pdm soft-annotation): `min = max(0, p0.1 − 1.5 × IQR)`, `max = p99.9 + 1.5 × IQR`, rounded outward to a human-readable figure.
- **Invariant:** hard bounds must strictly contain the *observed* full min/max of every column in `data/train.csv`. If a hard bound would reject a row that exists in the real training file, the bound is wrong. Assert this in a test.
- **Operating ranges** (`driftService.js` / `trendService.js` `OPERATING_RANGE`): the narrower p1–p99 band. Keep the existing hard-bounds ⊃ operating-range distinction, since `pdm/app/thresholds.yaml`'s `stdDevMax` derivation (15% of operating span) depends on it.
- **Alarm/warn bands** (`client/src/utils/constants.js` `THRESHOLDS`): p5/p1 and p95/p99 as a *seed*, reconciled against `Engine_Condition` in Phase 0. Label PROVISIONAL, same as today.

Do **not** hand-author any number in Phases 1–8 that was not produced by the Phase 0 characterization artifact.

## 3. Structural gaps in `data/train.csv` (must be handled, not ignored)

`data/train.csv` is materially *thinner* than the live pipeline's data model. Verified by inspection of the header and first rows:

| Live pipeline needs | In train.csv? | Consequence |
|---|---|---|
| `timestamp` | **No** | Rows are IID/unordered. train.csv can never feed the windowed Tier 2 corpus pipeline. `pdm/app/training.py`'s docstring already states this correctly — that reasoning survives the migration verbatim. |
| `status` (`RUNNING`/`STOPPED`/`FAULT`) | **No** | `validator.py`'s status-conditional rules and `aggregation.js`'s `dominantStatus` have no ground truth in train.csv. Status can only be synthesized by the simulator. |
| `faultType` | **No** | The multi-class taxonomy has **zero** supervision in the real data. This is the crux of §6. |
| Time ordering / rate of change | **No** | `rateOfChangeMax` in `thresholds.yaml` cannot be derived from train.csv at all — only from Phase 5 simulator output, exactly as the pump values were. |

**Sequencing implication:** `thresholds.yaml`'s `stdDevMax` and `rateOfChangeMax` cannot be finalized in Phase 1. Seed them in Phase 1 with the same 15%/10% heuristic the pump file used, then revisit in **Phase 5.3** once the engine simulator emits a time series. Write this dependency into the file header so the placeholder status is not lost.

## 4. Engine-domain replacements for the pump-physics gaps

### 4.1 `pdm/app/preprocessing/validator.py` cross-variable rules

The two existing rules are irreducibly pump-shaped (verified at lines 49–69):

- `dischargePressure > suctionPressure` — centrifugal head. **No analogue.** Delete.
- `STOPPED ⇒ flow ≈ 0 and rpm ≈ 0` — **has** an analogue. Generalize.

Proposed engine replacements, in decreasing order of confidence:

| Rule | Statement | Confidence | Notes |
|---|---|---|---|
| R1 — stopped-engine consistency | `status == STOPPED ⇒ engineRpm ≈ 0` and all three pressures at/near ambient | High | Direct port of the surviving pump rule; keep the `detect_transition` grace-window mechanism unchanged. |
| R2 — oil pressure vs. speed | Oil pressure is pump-driven off the crank: sustained high `engineRpm` with `lubOilPressure` below a floor is a violation | Medium | **Must verify** the correlation exists in train.csv first. |
| R3 — coolant pressure vs. coolant temp | Sealed pressurized system: high `coolantTemperature` with near-ambient `coolantPressure` implies loss-of-coolant / cap failure | Medium | Same verification gate. |
| R4 — oil temp vs. coolant temp coupling | At steady state the two track within a band; large divergence implies sensor fault or oil-cooler failure | Low | Only implement if Phase 0 shows real correlation. |

**Hard gate:** `data/train.csv` may be synthetic or heavily randomized. The sample rows already look weakly correlated (a 496-RPM row and a 1412-RPM row carry similar oil pressures). If Phase 0 shows the columns are near-independent, **implement R1 only** and ship `validate_physics()` with range checks plus R1. Shipping R2–R4 against uncorrelated data would fire violations on a large fraction of legitimate rows and destroy trust in the annotation. Record the decision and the measured correlations in the Phase 0 artifact.

`PRESSURE_EQUALIZATION_TOLERANCE_BAR` in `server/preprocessing/config.js` (line 66) exists solely to serve the deleted discharge/suction rule. Retire it or repurpose it as an ambient-pressure tolerance for R1; do not leave it dangling.

### 4.2 `node-red/flow.json` FAULT_PROFILES → engine failure modes

Current profiles: `THERMAL`, `CAVITATION`, `BEARING`, `IMPELLER_WEAR`, `SEAL_LEAK`, `MISALIGNMENT`, `DRY_RUN`. Only `THERMAL` survives conceptually. Proposed engine set, each defined by which metrics it perturbs and in which direction:

| Profile | `engineRpm` | `lubOilPressure` | `fuelPressure` | `coolantPressure` | `lubOilTemperature` | `coolantTemperature` |
|---|---|---|---|---|---|---|
| `OIL_PRESSURE_LOSS` | — | ↓↓ decay | — | — | ↑ | — |
| `COOLANT_OVERHEAT` | — | — | — | ↑ then ↓ | ↑ | ↑↑ |
| `COOLANT_LOSS` | — | — | — | ↓↓ | ↑ | ↑↑ |
| `FUEL_STARVATION` | ↓ unstable | — | ↓↓ | — | — | — |
| `OVERSPEED` | ↑↑ | ↑ then ↓ | ↑ | — | ↑ | ↑ |
| `OIL_DEGRADATION` | — | ↓ slow | — | — | ↑↑ | ↑ |
| `THERMOSTAT_STUCK` | — | — | — | ↓ | ↓ | ↓↓ (stuck-open) |

`OTHER` is retained as a catch-all, matching today's `FAULT_TYPES`.

This table is a *design proposal*, not a derivation — unlike the ranges, there is no data source for fault dynamics (train.csv has no fault typing at all). Label it as engineering judgment in the flow's comment node, the same way the pump profiles were.

### 4.3 `client/src/utils/constants.js` `FAULT_TYPES`

Mirror §4.2 one-for-one, with operator-facing labels (`Oil pressure loss`, `Coolant overheat`, `Coolant loss`, `Fuel starvation`, `Engine overspeed`, `Oil degradation`, `Thermostat stuck`, `Other`).

**These values are an enum in three places** — the client constant, the server `PATCH /api/pdm/fault-events/:id` validator, and the DB check constraint/comments on `raw_telemetry."faultType"` and `processed_telemetry."dominantFaultType"` (`001_init.sql` lines 51–54 and 123–126 name the old values in comments). All three must change in the same phase or fault review breaks.

## 5. `Engine_Condition` — polarity and semantics are UNVERIFIED

Two facts, both established by direct inspection of `data/train.csv`:

1. `Engine_Condition` is the **only** column that already matches a name in the codebase (`TRAIN_CSV_LABEL_COLUMN` at `pdm/app/training.py` line 49). That match is coincidental, not evidence that the rest of the mapping was ever correct.
2. **Label polarity is not documented anywhere and is not obvious from the data.** In the first sample rows, a row with entirely mid-range values maps to `0` while an adjacent similar row maps to `1`. Do **not** assume `1 = faulty`. In several widely-circulated versions of this style of engine dataset, `1` denotes *healthy*. Getting this backwards inverts every prediction the product makes while producing a model that still reports plausible accuracy.

**Mandatory Phase 0 verification:** compute, per column, the class means and class-conditional distributions of `Engine_Condition ∈ {0, 1}`, plus the fraction of each class falling outside the p5/p95 band. The class whose rows sit disproportionately at distribution extremes (particularly low `lubOilPressure`, high `coolantTemperature`) is the faulty class. Record the finding and evidence in the Phase 0 artifact, and encode it as a named constant with a comment citing that artifact — never as a bare `== 1`.

If the two classes are statistically indistinguishable across all six columns, that is itself a critical finding: the dataset cannot support a useful supervised model, and §12 Q2 becomes a project-level question. Surface it immediately rather than proceeding.

**RESOLVED (2026-08-26), per `docs/analysis/2026-08-26-train-csv-characterization.md`:** Phase 0 ran. Classes are separable (5-fold CV AUC ≈0.69–0.70, both logistic regression and RandomForest — not the "indistinguishable" failure mode), but **polarity is genuinely ambiguous** — `Engine_RPM` drives ~45% of the separation, with neither direction (higher-RPM/lower-fuel-pressure class 0 vs. lower-RPM/higher-fuel-pressure class 1) reading as an unambiguous fault signature, and no source documentation for the CSV exists in this repo to disambiguate.

**User decision: treat polarity as permanently unresolved; expose both class labels neutrally rather than asserting either is "faulty."** Concrete consequences:
- `pdm/app/training.py`'s label mapping (currently `y = ["FAULT" if int(v) == 1 else "NORMAL" for v in df[TRAIN_CSV_LABEL_COLUMN]]`, line 141) **must not ship this FAULT/NORMAL framing.** Replace with neutral class identifiers tied to the raw label value — e.g. `"CLASS_0"` / `"CLASS_1"`, or `f"ENGINE_CONDITION_{v}"` — so nothing downstream (schemas, UI, `training_runs` persistence) silently inherits an assumed polarity.
- `client/src/pages/TrainModelPage.jsx`'s metrics table (Class/Precision/Recall/Support) must render whatever neutral label the backend returns as-is — do not translate `CLASS_1` to "Faulty" or similar in the UI layer either.
- If/when the user later obtains authoritative source documentation for `data/train.csv` that settles polarity, this decision should be revisited explicitly — do not let a later engineer "helpfully" infer polarity from the class-conditional means in the Phase 0 report, since that finding was explicitly evaluated and judged inconclusive.
- This affects Phase 2 step 5's exit criteria (§7) and §7A item 1 (`predict_proba`-based risk scoring) — the risk score is a probability of the CSV's raw label value (e.g. "P(Engine_Condition = 1)"), not a probability of "fault," until polarity is settled.

## 6. The binary-vs-multiclass collision (OPEN — do not silently decide)

The old system carries a **7-way fault taxonomy** end to end: simulator `FAULT_PROFILES` → `raw_telemetry."faultType"` → `processed_telemetry."dominantFaultType"` → `_dominantFaultType` rollup → `fault_events` → the `ReviewDrawer` HITL loop → client `FAULT_TYPES`.

`data/train.csv` supplies **one binary label**. These are not reconcilable by a rename. Three coherent options:

- **Option A — Two-level model (recommended for discussion).** Keep the multi-class taxonomy for the *simulator + rule engine + HITL review* path (which generates its own supervision and never needed train.csv), and scope the train.csv-fitted Tier 2 bootstrap model to **binary healthy/faulty only**. Rationale: closest to what the code already does — the bootstrap model is explicitly a separate path from the corpus model (see `training.py`'s docstring), so a different label space there is architecturally consistent rather than a hack. Cost: two label spaces to keep straight; the UI must not present a binary bootstrap prediction as a typed fault.
- **Option B — Collapse to binary everywhere.** Delete `faultType`, `dominantFaultType`, `FAULT_TYPES`, and the typed portion of the review drawer. Simplest and most honest to the data. Cost: destroys the HITL fault-typing feature and fault attribution in drift/trend that were deliberately built; large deletion blast radius across DB, server, and client.
- **Option C — Synthesize multi-class supervision.** Keep the taxonomy and derive fault types for train.csv rows heuristically from which metric is out-of-band. **Not recommended** — it launders engineering guesses into an ML training set, and every downstream metric becomes self-fulfilling.

**RESOLVED (2026-08-26): Option A.** User decision: "the faults can be kept as long as they match the machinery. the binary label is only to know whether it is faulty or not." This confirms:
- The multi-class fault taxonomy (§4.2's `OIL_PRESSURE_LOSS`, `COOLANT_OVERHEAT`, `COOLANT_LOSS`, `FUEL_STARVATION`, `OVERSPEED`, `OIL_DEGRADATION`, `THERMOSTAT_STUCK`, `OTHER`) is kept end-to-end — simulator, rule engine, DB, HITL review, client `FAULT_TYPES` — rewritten to match engine failure modes rather than pump ones. It is **not** collapsed to binary.
- `Engine_Condition` is confirmed scoped to exactly what it is: a binary healthy/faulty signal for the `data/train.csv`-fitted bootstrap model (§8's Tier 2 bootstrap path). It is not expected to carry or infer a fault *type* — that supervision doesn't exist in the CSV (§3) and must keep coming from the simulator/HITL path.
- No code should ever try to derive a `faultType` from `Engine_Condition`; the two are different signals on different paths, matching the plan's original recommendation.

Phases 4, 5, and 7 proceed at full scope as planned (fault taxonomy fully implemented, not shrunk).

## 7. Phased Implementation

Risk key: **[HIGH]** = destructive/wide blast radius, **[MED]** = broad but mechanical, **[LOW]** = additive or cosmetic.

### Phase 0 — Empirical characterization of `data/train.csv` [LOW risk, BLOCKING]

Nothing else may start. Produces one committed artifact every later phase cites as the source for its numbers.

Deliverable: `docs/analysis/2026-08-26-train-csv-characterization.md` plus the generating script (`scripts/characterize_train_csv.py`).

1. Per column: count, nulls, min, max, mean, median, std, p0.1/p1/p5/p25/p50/p75/p95/p99/p99.9, IQR. Confirm the 15,628 row count; check for duplicate rows.
2. Emit the proposed `engine-physics.yaml` hard bounds and `OPERATING_RANGE` p1–p99 bands directly from those stats (§2.3), so no human transcribes a number.
3. Pairwise correlation matrix across the six metrics. **This is the gate for validator rules R2–R4** (§4.1). Record each correlation explicitly.
4. Class-conditional analysis of `Engine_Condition` (§5): class balance, per-column class means, per-column separation (e.g. single-column AUC). **Resolve label polarity here and state the evidence.**
5. Sample a stratified ~200-row slice for the new test fixture (Phase 9), preserving class balance.

Risk: none to production code. High *value* — every subsequent phase depends on its outputs.

### Phase 1 — Canonical config replacement [MED risk — everything derives from this]

| File | Action |
|---|---|
| `pump-physics.yaml` → `engine-physics.yaml` (repo root) | Replace six metric blocks with §2 keys and Phase 0 bounds. Keep the PROVISIONAL header; add the §2.2 units caveat. Rename the file — a stale `pump-physics.yaml` on disk is a loaded gun. |
| `pdm/app/physics.py` | `PUMP_PHYSICS_PATH` → `ENGINE_PHYSICS_PATH`; update the path literal. `load_ranges()` signature unchanged. |
| `server/utils/validation.js` | Update the YAML path only — `NUMERIC_FIELDS = Object.keys(RANGES)` is already derived, so it follows automatically. Verify no hardcoded pump key remains. |
| `pdm/app/thresholds.yaml` | Six new metric blocks. `min`/`max` copied from `engine-physics.yaml`. `stdDevMax` = 15% of the Phase 0 p1–p99 span. `rateOfChangeMax` = **placeholder, flagged for Phase 5.3** (§3). Bump `version` to `"2"`. |

Exit criteria: `load_ranges()` returns the six engine keys in both languages; every reference to `pump-physics.yaml` in the repo is gone (grep clean).

Dependencies: Phase 0 steps 1–2.

### Phase 2 — `pdm/` Python core [MED risk]

Order within phase matters (each item consumes the previous):

1. `pdm/app/rules.py` — `METRICS` list (line 15) → six engine keys. Rule engine logic unchanged.
2. `pdm/app/features.py` — `FEATURE_ORDER` → six engine keys. **Fix the order deliberately and comment it**; `to_vector()` positional semantics mean any later reordering silently invalidates every persisted model artifact.
3. `pdm/app/schemas.py` — all 62 pump-named Pydantic fields → engine equivalents, preserving the `{metric}{Min|Max|Mean|…}` suffix pattern.
4. `pdm/app/preprocessing/validator.py` — delete the discharge>suction block (lines 49–60), rewrite the status block (lines 62–69) as R1, add R2–R4 **only if Phase 0 step 3 justified them** (§4.1).
5. `pdm/app/training.py` — `TRAIN_CSV_COLUMN_MAP` (lines 41–48) → the real §2 mapping. This is the line that makes `data/train.csv` load for the first time. `TRAIN_CSV_LABEL_COLUMN` stays `"Engine_Condition"` but gains a comment citing the Phase 0 polarity finding. **Label values (line 141) must also change from `"FAULT"/"NORMAL"` to neutral class identifiers** (e.g. `"CLASS_0"`/`"CLASS_1"`) per §5's resolved polarity decision — do not carry the FAULT/NORMAL framing forward.
6. `pdm/app/model.py` — verify only; it depends on `features.py`'s shape, which is unchanged. Re-fit and re-stamp any committed artifact, since feature *meaning* changed even though shape did not. **Any pre-existing `model.joblib` must be invalidated, not silently reused.**

Exit criteria: `fit_model()` against the real `data/train.csv` completes and produces metrics — the concrete, demonstrable end of the "train.csv is orphaned" bug.

Dependencies: Phase 1.

### Phase 3 — `server/` Node, non-DB [MED risk]

| File | Action |
|---|---|
| `server/preprocessing/config.js` | `MAX_FILLABLE_GAP_SECONDS_BY_METRIC` (lines 40–47) and `MAX_RAMP_RATE_PER_SECOND` (lines 56–62) rekeyed. Re-reason per-metric ceilings: temperatures slow (long fillable gap), pressures faster, RPM fastest — the existing physical reasoning transfers cleanly. Note `motorTemp` had no ramp entry by design; give **both** engine temperatures the same treatment. Retire/repurpose `PRESSURE_EQUALIZATION_TOLERANCE_BAR` (§4.1). |
| `server/services/driftService.js` | `OPERATING_RANGE` (lines 72–78) ← Phase 0 p1–p99 bands. Update unit strings per §2.2 caveat. |
| `server/services/trendService.js` | Same, and **verify** whether it truly maintains its own duplicate `OPERATING_RANGE` (the `driftService.js` comment claims so). If duplicated, this is the right moment to extract one shared constant rather than propagate the duplication. |
| `server/middleware/validateReading.js` | Verify-only; thin wrapper over `validation.js`. |
| `server/models/sensorModel.js`, `processedModel.js` | **Direct verification required** — these likely embed literal pump column names in SQL. Blocked on Phase 4's column names being final. |
| `server/scripts/recordBootstrapRun.js`, `recordTrainingRun.js` | Verify the persisted metrics dict is metric-name-agnostic; adjust if it enumerates pump keys. |
| `server/controllers/trainingController.js`, `server/services/trainingService.js` | Proxy layer only. Verify no pump-shaped column validation leaked in. |

Dependencies: Phase 1 (config); Phase 4 for the model-layer items.

### Phase 4 — Database schema [HIGH RISK — most destructive phase]

Two viable strategies. **The user must pick one (§12 Q6).**

- **Strategy A — Drop and recreate** (recommended if all existing telemetry is simulator-generated and disposable). Amend `001_init.sql` in place to the engine columns and wipe the Postgres volume. Clean, no dead migration cruft, and the schema reads as if the engine domain were always intended. Cost: **all existing data is destroyed**, including any HITL-reviewed `fault_events` labels, which are genuinely expensive human output. Audit `fault_events` and `training_corpus` row counts *before* choosing.
- **Strategy B — Forward migration (`006_engine_domain.sql`).** `ALTER TABLE … RENAME COLUMN` × 6 on `raw_telemetry`, × 36 on `processed_telemetry`, plus fault-type enum/constraint updates. Preserves history, but the renamed *pump* data is now mislabeled engine data — physically meaningless rows (a flow rate sitting in an `engineRpm` column). If you choose B you must also delete/quarantine pre-migration rows, which yields most of A's data loss anyway with more complexity.

Regardless of strategy, in scope:
- `raw_telemetry` metric columns (`001_init.sql` lines 41–46) **including the per-column unit comments**, which are currently accurate pump documentation and would become actively misleading if renamed without updating.
- `processed_telemetry` 36 aggregate columns (lines 114–119).
- `raw_telemetry."faultType"` comment (lines 51–54) and `processed_telemetry."dominantFaultType"` comment (lines 123–126) — both enumerate the old pump fault values; update to §4.2 (or drop, under §6 Option B).
- Hypertable/index definitions referencing any renamed column.
- `005_training_corpus.sql` — `featureSnapshot` is JSONB and schema-agnostic, but **existing rows contain pump-shaped payloads**. Decide: purge, or version-tag the snapshot schema so a future reader can tell the two apart. Silently mixing them poisons any future corpus retrain.

Mitigations: `pg_dump` before either strategy; run against a scratch database first; verify `server/models/*.js` queries against the migrated schema before touching a shared environment.

Dependencies: Phase 1 (final key names); §6 decision (whether `faultType` survives at all).

### Phase 5 — `node-red/flow.json` simulator rewrite [HIGH RISK — largest single artifact]

This is the only thing that populates `raw_telemetry` today, and the ~100-line embedded JS in the "generate reading" function node is the largest single block of pump physics in the repo. It cannot be renamed — the *relationships* between metrics (flow vs. head vs. speed) are pump physics with no engine analogue.

1. **5.1 — Rewrite the base physical model.** New driver: engine load/throttle as the latent variable (analogous to the existing Ornstein-Uhlenbeck load term). `engineRpm` follows load directly; `lubOilPressure` rises with RPM then plateaus; `fuelPressure` tracks demand; coolant/oil temperatures integrate load with large thermal time constants (first-order lag, not instantaneous). Target the Phase 0 distributions so simulated output is statistically compatible with `data/train.csv` — this is the concrete acceptance test for the rewrite.
2. **5.2 — Implement §4.2 fault profiles**, replacing the seven pump profiles; update the POST payload to `{engineRpm, lubOilPressure, fuelPressure, coolantPressure, lubOilTemperature, coolantTemperature, status, timestamp}` (+ `faultType` if retained).
3. **5.3 — Back-fill `thresholds.yaml`'s deferred `rateOfChangeMax`** (§3) from real simulator output. Bump `thresholds.yaml` `version` again.

Mitigations: per §12 Q3 (resolved — no legacy pump mode kept on disk), rely on git history for rollback rather than a retained `node-red/legacy/flow.pump.json`; replace `flow.json` in place once Phase 5 is signed off. Validate the payload against the Phase 3 `validateReading` before wiring it to the live ingest endpoint.

Dependencies: Phases 1, 3, 4.

### Phase 6 — `scripts/` synthetic corpus generator [LOW/MED risk — isolated]

`scripts/generate_pump_telemetry.py` and `scripts/validate_pump_telemetry.py` are standalone and unrelated to `data/train.csv`. The generator's docstring states its physical model deliberately mirrors `node-red/flow.json` — so it must be rewritten *after* Phase 5 and mirror the new model, or the two synthetic sources silently diverge.

Decide (§12 Q7): rewrite as `generate_engine_telemetry.py` / `validate_engine_telemetry.py`, or retire. Retirement is defensible if the generator's only consumer was corpus bootstrapping that `data/train.csv` now partially serves — but note train.csv **cannot** replace it (no timestamps, no window structure, §3). Recommend rewrite.

`validate_pump_telemetry.py` mirrors `pump-physics.yaml` verbatim; the rewrite should **load** `engine-physics.yaml` rather than re-mirror it, removing a long-standing duplication.

Dependencies: Phase 5.

### Phase 7 — `client/src` [LOW risk, HIGH visibility]

| File | Action |
|---|---|
| `client/src/utils/constants.js` | `METRICS` (lines 8–15): six engine entries with labels, `short` codes (§2), units (§2.2 caveat), decimals (RPM 0; pressures 2; temperatures 1). `THRESHOLDS` (lines 20–27): Phase 0 seeded bands. `FAULT_TYPES` (lines 77–86): §4.2 values, **in lockstep with the server enum**. `statusOf`, `isExcursion`, `pillFor`, `fmt`, `SC` are metric-agnostic — no change. |
| `OverviewPage.jsx`, `AnalyticsPage.jsx`, `ReportsPage.jsx`, `PredictionsPage.jsx` | Consume `constants.js`; expect no change. **Verify** each for hardcoded pump strings in headings/tooltips/empty states. |
| `ProcessSchematic.jsx` | **Design decision required (§12 Q8).** A pump P&ID (suction→impeller→discharge) has no engine analogue this component's geometry supports. Options: (a) redesign as an engine schematic (block with oil circuit, coolant circuit, fuel rail, each sensor rendered at its physical location) — most valuable, most work; (b) replace with a plain sensor grid; (c) remove. |
| `ReviewDrawer.jsx`, `utils/faultEvents.js` | Follow `FAULT_TYPES`; verify no hardcoded pump fault strings. |
| `TrainModelPage.jsx` | Generic (Class/Precision/Recall/Support). Should begin working correctly as a side effect of Phase 2 step 5. Under §6 Option A, add copy distinguishing the binary bootstrap model from typed faults. |
| `Sidebar.jsx`, `TopBar.jsx`, `App.jsx` | "Pump" branding → engine. Shallow. |

Dependencies: Phases 1–4.

### Phase 8 — Database / service naming [MED risk, LOW value — consider deferring]

`db/init/01-init-pump-telemetry.sql` creates `pump_telemetry`. Renaming touches `docker-compose.yml`, `.env`, `server/database/db.js` connection strings, the migrations runner, and `db/init/03-create-pdm-corpus-readonly-role.sh`.

This is pure nomenclature with **zero functional benefit** and a real chance of breaking local/CI environments via a stale `.env`. **Recommend deferring to a separate standalone change** after the functional migration is green (§12 Q9). If the residual "pump" name is unacceptable, do it here — but do it alone, never bundled with Phase 4's schema work, so a connection failure is unambiguously attributable.

### Phase 9 — Tests and fixtures [MED risk — must interleave, not trail]

Tests are the migration's only safety net; treat each item as part of its corresponding phase's exit criteria, not as cleanup.

- `pdm/tests/fixtures/train_fixture.csv` — **replace with the real stratified sample from Phase 0 step 5.** The current fixture is fabricated and pump-shaped; a fixture derived from the real file is the whole point. Add a test asserting the fixture's columns exactly equal `data/train.csv`'s header, so the two can never drift again.
- `pdm/tests/test_training.py` — rewrite against the real column map; assert `fit_model()` succeeds on the real file (regression test for today's `ValueError`).
- `pdm/tests/test_rules.py`, `test_validator.py` — new metric names; **new** assertions for R1 (and R2–R4 if adopted); **delete** discharge>suction cases.
- `pdm/tests/test_features.py` — assert `FEATURE_ORDER` exactly, by value, to lock positional semantics (Phase 2 step 2).
- `pdm/tests/test_model.py`, `test_process_window_tier2.py` — rekey fixtures.
- `server/scripts/tests/pdmService.test.mjs`, `pipelineProcessWindow.test.mjs`, `unitConversion.test.mjs`, `_dominantFaultType.integration.mjs` — rekey; `unitConversion.test.mjs` needs real scrutiny given §2.2's unit uncertainty, and `_dominantFaultType.integration.mjs` is directly affected by §6.
- **New:** an `engine-physics.yaml` guard test asserting every hard bound strictly contains `data/train.csv`'s observed per-column min/max (§2.3).
- **New:** a repo-wide grep test failing on any surviving pump metric identifier. This is what makes §2.1's total-rename strategy pay off.

### Phase 10 — Documentation [LOW risk]

- `docs/plan/2026-08-05-pdm-implementation.md` — do **not** delete; it is the design-of-record for architecture that survives intact (tiering, windowing, HITL, artifact lifecycle). Add a header banner marking §11.5/§11.6.1 (pump-physics sourcing), §11.6.5 (golden-value parity suite, tied to pump ranges), and §15.1 (bootstrap description) as **superseded by this document**, with pointers.
- `docs/superpowers/specs/2026-07-15-pump-schematic-analytics-enhancement-design.md` and its plan — mark historical/superseded pending §12 Q8.
- This file becomes the domain design-of-record.
- Reference the Phase 0 artifact from the design-of-record so the provenance of every number is one hop away.

## 7A. Predictive scoping — the bootstrap model must output risk, not current-state (ADDED 2026-08-26)

User requirement: "i want the PdM model to predict faults not to tell me if they are happening right now, excluding timestamps... keep in mind the data is not sequential."

**Hard constraint:** `data/train.csv` has no timestamp, no sequence, no time-to-failure label — it is 15,628 IID snapshots. Genuine remaining-useful-life or trend-based early-warning **cannot** be trained from this file; there is nothing in it that encodes "before" vs. "at" failure. Any such claim would be fabricated. This does not block a predictive-feeling product — it changes what the bootstrap model's job is.

**Design decision:** the `data/train.csv`-fitted bootstrap model (§8, `pdm/app/training.py`) is scoped to produce a **calibrated continuous fault-risk score** (`predict_proba`, 0–100%), not a binary current-state verdict. This is training-approach only — no schema/column change beyond what §2/§7 Phase 2 already specifies.

1. **`pdm/app/model.py` / `training.py`** — expose `predict_proba()`-based scoring as the primary inference output; the binary label is used only for fitting, not surfaced as the sole prediction. Add to Phase 2 step 6's exit criteria.
2. **New engineered features, computed from the Phase 0 characterization, snapshot-only (no time needed) — add to `pdm/app/features.py` / a new `pdm/app/derived_features.py`, feeding the bootstrap model in addition to the 6 raw engine metrics:**
   - Per-sensor z-score relative to the healthy-class (`Engine_Condition`-conditional) distribution from Phase 0.
   - Cross-sensor ratios with physical grounding (e.g. `lubOilPressure / engineRpm`) — flagged for Phase 0 correlation verification the same way §4.1's R2–R4 rules are, so no ratio is added without evidence it separates the classes.
   - A composite stress index (e.g. Mahalanobis distance from the healthy centroid) as a single continuous "how unusual is this reading combination" feature.
   - Count of metrics within N% of their alarm band simultaneously (multi-sensor near-miss signal), using `engine-physics.yaml`'s operating range from §2.3.
3. **Where true temporal early-warning lives:** the live Node-RED → Tier 1/Tier 2 pipeline has real timestamps and already computes windowed drift/rate-of-change (`driftService.js`, `trendService.js`, per §7 Phase 3/5). The correct integration is to feed the bootstrap model's continuous risk score into that windowed pipeline and track *the score's trend over time* there — not to claim the snapshot model itself predicts forward in time. Add this integration point to Phase 5/Phase 3 scope: `driftService.js`/`trendService.js` should be able to ingest a `faultRiskScore` alongside the 6 raw metrics and compute its trend the same way it does for raw metrics today.
4. **Exit criteria addition (§11):** bootstrap model exposes calibrated `predict_proba` risk score; at least one derived feature from item 2 is included only if Phase 0 correlation evidence supports it (same evidentiary bar as §4.1); `driftService.js`/`trendService.js` can track the risk score's trend, giving genuine lead time from the live sequential pipeline rather than the non-sequential CSV alone.

## 8. The in-flight training-CSV-upload feature (2026-08-23)

`docs/superpowers/specs/2026-08-23-training-csv-upload-design.md` and `docs/superpowers/plans/2026-08-23-training-csv-upload.md` are **not separable work**. Both were written against a fictional pump-shaped `train.csv`; the plan's own fixtures use pump column names plus a fake `Engine_rpm` column — the same mismatch baked into `TRAIN_CSV_COLUMN_MAP` today. The plan is **unexecutable as written** against the committed file.

Disposition:
- Do **not** implement the plan as-is, and do not create `pdm/app/training_quality.py` from its current fixtures.
- Fold its corrections into **Phase 2 step 5** (column map) and **Phase 9** (fixtures): rewrite the spec's column map and every code sample against the §2 keys, and re-source its quality gate from `engine-physics.yaml` instead of `pump-physics.yaml`.
- Its **architecture is sound and should be preserved** — upload proxy, quality gate, `training_runs` persistence, `TrainModelPage.jsx`. Only the domain vocabulary is wrong.
- Its quality-gate thresholds must be re-derived from Phase 0, not translated.
- Re-issue as `docs/superpowers/specs/2026-08-26-training-csv-upload-design.md` (revised) and mark the 2026-08-23 pair superseded, so no one implements the stale version from a branch.

**Sequencing note:** the upload feature must not be completed before Phase 2, or it ships a second consumer of the broken column map.

## 9. Risk Register

| Risk | Phase | Severity | Mitigation |
|---|---|---|---|
| `Engine_Condition` polarity assumed backwards | 0/2 | **Critical** — inverts every prediction while reporting plausible accuracy | §5 empirical verification, encoded as a named constant citing the Phase 0 artifact |
| Ranges guessed instead of derived; ingest hard-rejects real training rows | 1 | High | §2.3 containment invariant + Phase 9 guard test |
| DB migration destroys human-reviewed `fault_events` labels | 4 | High | Audit row counts before choosing strategy; `pg_dump` first |
| Partial rename leaves pump/engine keys coexisting → silent data corruption | 2/3/4 | High | §2.1 total rename + Phase 9 repo-wide grep test |
| Validator rules R2–R4 fire constantly on uncorrelated data | 2 | Medium | §4.1 hard gate on Phase 0 step 3 correlations |
| `FEATURE_ORDER` reordered later, invalidating persisted artifacts | 2 | Medium | Exact-value assertion test; invalidate existing `model.joblib` |
| Simulator output statistically unlike `data/train.csv` → live and trained domains diverge | 5 | Medium | Statistical acceptance test against Phase 0 stats |
| `scripts/` generator diverges from the rewritten simulator | 6 | Medium | Sequence after Phase 5; load `engine-physics.yaml` rather than mirror it |
| `pump_telemetry` DB rename breaks environments via stale `.env` | 8 | Medium | Defer to a standalone change; never bundle with Phase 4 |
| Stale `training_corpus` JSONB rows mix pump and engine payloads | 4 | Medium | Purge or schema-version the `featureSnapshot` |
| Stale 2026-08-23 plan implemented from a branch | 8/10 | Low | Mark superseded early, in Phase 0 if possible |

## 10. Recommended Execution Order

`0 → 1 → 2 → 3 (non-DB) → 4 → 3 (models) → 5 → 6 → 7 → 9 → 10 → 8 (deferred)`

Phase 9 items attach to their originating phase's exit criteria; the row above is the residual sweep.

## 11. Success Criteria

- [ ] Phase 0 artifact committed; every numeric constant in Phases 1–8 traces to it
- [ ] `Engine_Condition` polarity determined empirically and documented with evidence
- [ ] `fit_model()` runs against the real `data/train.csv` and produces metrics (today: `ValueError`)
- [ ] `engine-physics.yaml` hard bounds provably contain every row in `data/train.csv` (guard test)
- [ ] Repo-wide grep for `flowRate|suctionPressure|dischargePressure|motorTemp|vibration|"rpm"` returns only intentional legacy/historical paths
- [ ] Node-RED simulator emits engine payloads that pass `validateReading` and are statistically compatible with `data/train.csv`
- [ ] Live pipeline end-to-end: simulator → ingest → `raw_telemetry` → windowing → `processed_telemetry` → Tier 1 → Tier 2 → dashboard, in engine vocabulary
- [ ] `pdm/tests` and `server/scripts/tests` green, with fixtures derived from the real file
- [ ] Training-CSV-upload spec re-issued against real columns; 2026-08-23 pair marked superseded
- [ ] `docs/plan/2026-08-05-pdm-implementation.md` carries an accurate supersession banner

## 12. OPEN QUESTIONS — required before Phase 1

**Q1. Binary or multi-class fault taxonomy?** — **RESOLVED 2026-08-26, Option A** (§6). Typed faults (rewritten to match engine machinery) are kept on the simulator/HITL path; `Engine_Condition` stays a separate binary healthy/faulty signal for the bootstrap model only.

**Q2. If Phase 0 shows the two `Engine_Condition` classes are statistically indistinguishable across all six columns, what then?** (§5) Proceed with a knowingly weak model, seek a better dataset, or re-scope? Worth pre-agreeing.

**Q3. Keep the pump domain as a legacy/demo mode?** — **RESOLVED 2026-08-26: No.** User: "drop the old pump things." No dual-domain abstraction; no `node-red/legacy/flow.pump.json` retained on disk (git history is sufficient). Every phase's disposition of pump artifacts (§7 Phase 1's `pump-physics.yaml`, Phase 5's `flow.json`, Phase 6's `generate_pump_telemetry.py`/`validate_pump_telemetry.py`, Phase 7's `ProcessSchematic.jsx` pump variant) is a straight replace/delete, not a fork-and-keep.

**Q4. Confirm the six-metric mapping and key names in §2.** — **RESOLVED 2026-08-26.** Internal/DB key `engineRpm` (§2's proposal) is confirmed as-is — user: "idc if you make it engineRpm" — so §2's full key set (`engineRpm`, `lubOilPressure`, `fuelPressure`, `coolantPressure`, `lubOilTemperature`, `coolantTemperature`) stands unchanged for schema, code, and API use. **Frontend display label is separately specified:** user wants `Rpm` or `Engine Rpm` shown in the UI, not `Engine RPM` (all-caps) or a generic `Pump Speed`-style label. Phase 7's `client/src/utils/constants.js` `METRICS` entry for this metric should set `label: "Engine Rpm"` (title-case, not all-caps "RPM") — the internal key stays `engineRpm` and only the display `label` string differs. The other five metrics' display labels (§2 table's plain-English names — "Lube Oil Pressure", "Fuel Pressure", "Coolant Pressure", "Lube Oil Temperature", "Coolant Temperature") are unopposed and stand as proposed.

**Q5. Are the units in §2.2 confirmable from any source outside the repo?** If the dataset has documented provenance, that settles bar-vs-other and lets UI labels state units confidently instead of hedging.

**Q6. Phase 4 strategy: drop-and-recreate (A) or forward migration (B)?** — **RESOLVED 2026-08-26: Strategy A, drop and recreate.** User confirmed the current database contains no data worth preserving (disposable simulator/test data). Amend the schema files in place to engine columns and wipe the Postgres volume rather than writing a forward `ALTER TABLE` migration.

**Q7. `scripts/generate_pump_telemetry.py` — rewrite for engine, or retire?** Note `data/train.csv` cannot substitute for it: no timestamps, no window structure.

**Q8. `ProcessSchematic.jsx` — redesign as an engine schematic, replace with a sensor grid, or remove?** This also determines the fate of the 2026-07-15 pump-schematic spec/plan.

**Q9. Rename the `pump_telemetry` database and repo-wide "Pump" branding?** Recommend yes eventually, but as a standalone change after the functional migration is green.
