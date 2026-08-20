# PdM Tier 2 — replace the `training_corpus` pipeline with a static, CSV-trained model

**Status:** planning only — nothing here has been executed yet.

**Supersedes:** §10 (`training_corpus`/corpus materialization), §10.5 (evaluation gate,
walk-forward split, champion/challenger promotion), §11 (Python-owned feature computation
insofar as it feeds Tier 2), §12/§13 (fault taxonomy, synthetic corpus), and all of §14
(Tier 2 Model Ops: fitting, artifact store, admin promotion UI, monitoring) in
`docs/plan/2026-08-05-pdm-implementation.md`. §1–§9 (Tier 1 rule engine, `fault_events`,
HITL review) are **unchanged** — this plan only replaces how Tier 2 gets trained and served.

---

## 1. Why the switch

The project owner supplied a labeled training set (`data/train.csv` — actually delivered as
an uploaded CSV, 15,627 rows): six numeric columns (`Engine_rpm`, `suctionPressure`,
`dischargePressure`, `flowRate`, `motorTemp`, `vibration`) and a binary label
(`Engine_Condition`, 0/1). No timestamp column, no fault-type label, no episode/buffer
structure.

The requirement that drove this plan: **predict whether a fault condition is present right
now, from a single reading — nothing about when a fault will happen.** No onset window, no
lead time, no forecast horizon.

That requirement is satisfiable with a plain static binary classifier trained once on this
CSV. Everything §10–§14 built exists to solve a problem this dataset doesn't have:

- **`training_corpus` and its materialization pipeline** exist to turn HITL-confirmed
  `fault_events` buffers into labeled training rows over time, because the original plan
  assumed labels would only ever come from human review of live flags — there was no
  upfront labeled dataset. That assumption no longer holds: labels already exist, in bulk,
  today.
- **The walk-forward/episode split and the whole evaluation gate (`MIN_ONSET_EPISODES`,
  `check_evaluation_gate`)** exist to prevent leakage across a single continuous time series
  and to stop training before enough distinct fault *episodes* have accumulated. `train.csv`
  has no time axis and no episode structure — rows are i.i.d. observations. A time-series
  split is meaningless here; a plain stratified train/test split is the correct tool, and no
  "wait until enough episodes exist" gate applies because all the data already exists.
- **The champion/challenger promotion gate, admin approve/reject/rollback lifecycle, and
  monitoring page (§14.4, §14.6, §14.7)** exist to supervise a model that keeps being
  *retrained* over time as new HITL-confirmed faults accumulate into `training_corpus`. A
  model trained once on a static CSV isn't being continuously retrained against a moving
  corpus — there's no "champion vs. next candidate" question to arbitrate, because there
  is currently no mechanism generating new candidates. That entire lifecycle is overhead
  with nothing to supervise.
- **The 54-feature vector (`precapFeaturesByMetric` × `metricStats`, §14.2.1)** doesn't
  exist in this CSV at all — it has six raw values, not per-window statistics. Building the
  54-feature transform to train on this data would mean fabricating 48 features that were
  never collected, which is worse than just training on the six real ones.

None of `training_corpus`, `corpusMaterializationService.js`, `promotion.py`'s
champion/challenger gate, `retrain.py`'s orchestration, or §14's admin Model Ops page has any
implemented UI or wired route today — §14.0's own precondition check (item 7) already found
"no admin group concept exists anywhere," and the earlier session's review confirmed the
promotion/monitoring surface was never built past the backend scaffolding. So this is a
replacement of unused, unwired infrastructure, not a rollback of something in production.

**Net effect:** Tier 2 becomes a single fixed artifact, fit once from `train.csv`, loaded at
`pdm` container startup, served inline from `model.py::score()`. Retraining on a *new* CSV
later is a manual "replace the file, rebuild the container" operation, not a live
admin-triggered pipeline — because there is currently no source of new labeled data other
than a human handing over another CSV.

---

## 2. What "predict faults, not timing" means for this model concretely

- Input: one reading — `rpm`, `suctionPressure`, `dischargePressure`, `flowRate`,
  `motorTemp`, `vibration` (already the same six metric names Tier 1's rules and
  `pump-physics.yaml` use — no renaming needed on the live-serving side).
- Output: `faultPredicted: bool` (+ a probability/confidence score) for *that reading*,
  nothing else. No horizon, no "time to failure," no severity-over-time.
- This is a same-time diagnosis signal, same posture as Tier 1's rule flags — it augments
  Tier 1's verdict per the existing §3.5 rule ("Tier 2 augments, never replaces, the rule
  verdict"), which stays true and doesn't need to change.

---

## 3. What changes, and to what

### 3.1 Delete (unused, superseded)

| Current | Why it goes |
|---|---|
| `pdm/app/corpus.py` | Reads `training_corpus` from Postgres — no longer the training source. |
| `pdm/app/promotion.py` | Champion/challenger gate over repeated retrains — nothing to arbitrate with a one-shot static model. |
| `pdm/app/retrain.py` | Orchestrates gate → split → evaluate → promote against `training_corpus` — replaced by a one-off fit script (§3.2). |
| `pdm/app/evaluation/episodes.py` (`walk_forward_split`, `check_evaluation_gate`) | Time-series/episode-aware splitting — meaningless on i.i.d. rows with no time axis. |
| `server/database/migrations/005_training_corpus.sql` (table + `pdm_corpus_readonly` role) | Nothing populates or reads `training_corpus` anymore. New migration drops the table and role (see §3.3). |
| `server/services/corpusMaterializationService.js` | Turns `fault_events` into `training_corpus` rows — no longer needed. |
| `server/models/corpusModel.js` | Model layer for the now-removed table. |
| `server/models/trainingRunModel.js` + the `training_runs` table (part of 005) | Tracked champion/challenger runs; no longer a concept. |
| `server/scripts/recordTrainingRun.js` | Persisted `retrain.py`'s output into `training_runs` — nothing produces that output anymore. |
| §14 in full (artifact store lifecycle, admin promotion endpoints, `ModelOpsPage`, `PDM_ADMIN_GROUP`, `tier2_predictions` monitoring table) | Built to supervise continuous retraining against a live corpus; doesn't apply to a static, manually-replaced artifact. If you later want visibility into what Tier 2 predicted, that's a much smaller, separate ask than the full admin lifecycle §14 specced — call it out explicitly if wanted. |

### 3.2 Add (the actual training path)

- **`data/train.csv`** — committed to the repo (or mounted into the `pdm` build context;
  decide which — see open question in §5) as the one and only training source.
- **`pdm/app/features.py`** — much smaller than §14.2.1's derived 54-feature version. A
  fixed, hand-written `FEATURE_ORDER = ["rpm", "suctionPressure", "dischargePressure",
  "flowRate", "motorTemp", "vibration"]`, matching `train.csv`'s columns 1:1 (mapping
  `Engine_rpm` → `rpm` to match the rest of the codebase's naming). `to_vector()` raises on
  a missing/non-numeric field, same "no silent zero-fill" principle as before — that part of
  §14.2.1's reasoning still holds and is kept.
- **`pdm/app/training.py`** — `fit_model(train_csv_path, *, config) -> FittedModel`. Loads
  the CSV directly (`pandas.read_csv` or plain `csv`), does a stratified train/test split
  (not walk-forward — there's no time axis to respect), fits
  `sklearn.ensemble.RandomForestClassifier` (or XGBoost, config-gated — §14.2.2's
  family choice/reasoning is unaffected by this change and carries over unchanged), reports
  accuracy/precision/recall on the held-out split, and writes `model.joblib` +
  `metadata.json` (feature order, training data hash, metrics, timestamp) to a fixed path
  inside the `pdm` image/volume.
- **`pdm/app/training_config.yaml`** — same versioned-YAML pattern as `thresholds.yaml`
  (§14.2.4's reasoning carries over): hyperparameters, seed, model family.
- **A one-off fit script/CLI** (replaces `retrain.py`'s orchestration role) — run manually
  (`python -m pdm.app.training`) at image build time or by an operator before deploying a
  new artifact. Not exposed over HTTP, not admin-triggered — there's no live retrain loop to
  trigger.
- **`pdm/app/model.py`** — no longer a permanent stub. Loads `model.joblib` once at module
  import (same "load once at startup" pattern `thresholds.yaml` already uses), and
  `score(record)` builds the 6-value vector via `features.to_vector()` and returns
  `{"tier2Flagged": bool, "tier2Confidence": float}` (or `None` if the artifact failed to
  load — Tier 1 stays unaffected, same fallback posture as today).
- **`pdm/app/schemas.py`: `ScoreResponse`** gains the two Tier 2 fields above as optional —
  same fix §14.0 item 6 already identified as mandatory (FastAPI's `response_model` silently
  drops undeclared keys), just against a smaller field set than §14 specced.
- **`preprocessing/pipeline.py`'s `/process-window` path** must call `model.score()` the
  same way `/score` does — §14.0 item 5's finding (the live path stopped calling `/score` and
  never invokes `model.score()` at all) still applies verbatim and must be fixed here,
  regardless of which Tier 2 training approach is used.

### 3.3 Migration housekeeping

- New migration `007_drop_training_corpus.sql`: `DROP TABLE IF EXISTS training_corpus`,
  `DROP TABLE IF EXISTS training_runs`, revoke/drop the `pdm_corpus_readonly` role. Keep
  `fault_events` untouched — Tier 1/HITL review is unaffected by this plan.
- `db/init/03-create-pdm-corpus-readonly-role.sh` — remove; the role it creates no longer
  has anything to read.

### 3.4 Untouched

- Tier 1 rule engine (`rules.py`, `thresholds.yaml`), `fault_events`, HITL review endpoints,
  `pdmService.js`, the fire-and-forget POST contract, `pump-physics.yaml` — none of this
  plan's reasoning touches any of it. Tier 2 still only ever *augments* a Tier 1 verdict,
  never replaces it, per the existing §3.5 rule.
- External upload endpoints (`externalUploadController.js`/`externalUploadService.js`) —
  these ingest fault *buffers* into `fault_events` for HITL review, a separate concern from
  training-corpus materialization. Confirm at implementation time whether
  `corpusMaterializationService.js`'s removal (§3.1) breaks anything these depend on; from
  the code read so far it doesn't — the upload flow writes `fault_events`/raw buffers, and
  materialization only ever *read* from `fault_events` outward into `training_corpus`.

---

## 4. Deployment topology correction

§1's "dedicated `pdm-python` CT" language is stale. Actual topology: **one Proxmox CT
running the whole application, with one Docker container per component** (server, client,
pdm, node-red, db, etc.) inside that single CT, presumably on a shared Docker network. `pdm`
stays its own container/service — nothing about how it's built or how Node reaches it over
HTTP changes — only the "separate CT per service" framing in §1 is wrong and should be
corrected there. The static-artifact approach in this plan is actually a better fit for that
topology than the artifact-volume/hot-reload design in §14.3: a model file baked into the
`pdm` image (or mounted read-only) at container build/start is simpler than a shared
`pdm_artifacts` volume designed for a live promotion pipeline that no longer exists.

---

## 5. Open questions to settle before implementation

1. **Where does `train.csv` live long-term?** Committed into the repo under `data/`, or
   supplied at deploy time as a mounted file/build arg? Committing it is simplest and matches
   "static, manually-replaced artifact"; keeping it out of git avoids repo bloat if it grows.
2. **Retraining cadence going forward.** If a new/larger CSV shows up later, is the process
   "rebuild the `pdm` image with the new file and redeploy," or should there be a minimal
   manual trigger (e.g. a CLI script an operator runs by hand) that doesn't require a rebuild?
   Either is far simpler than §14's admin lifecycle — just needs a decision.
3. **Class balance.** `train.csv` is ~63%/37% (1/0) — not extreme, but worth deciding whether
   `class_weight='balanced'` is used by default (§14.2.2's reasoning for it still applies).
4. **Visibility into Tier 2 predictions.** §14.6's full monitoring page is out of scope per
   §3.1, but "log/expose what Tier 2 said per window" is a much smaller ask if wanted at all
   — flag explicitly if so, otherwise this plan assumes none.

---

## 6. Definition of done (for whenever this is implemented)

- [ ] `training_corpus`, `training_runs` tables and `pdm_corpus_readonly` role dropped via migration
- [ ] `corpus.py`, `promotion.py`, `retrain.py`, `evaluation/episodes.py`, `corpusMaterializationService.js`, `corpusModel.js`, `trainingRunModel.js`, `recordTrainingRun.js` removed
- [ ] `pdm/app/model.py` loads a real artifact fit from `train.csv` and returns a non-None verdict
- [ ] `pdm/app/features.py`'s 6-field `FEATURE_ORDER` matches `train.csv` columns exactly, mapped to this codebase's existing metric names
- [ ] `/process-window` actually calls `model.score()` (§14.0 item 5's gap, fixed)
- [ ] `ScoreResponse` schema extended with the two Tier 2 fields, verified they survive `response_model` filtering
- [ ] Tier 1 verdict is unchanged/unaffected by any of the above
- [ ] §1's CT topology note corrected to "one CT, one Docker container per component"
