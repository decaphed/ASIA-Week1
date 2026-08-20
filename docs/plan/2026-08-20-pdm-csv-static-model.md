# PdM Tier 2 — bootstrap from a static CSV, retrain via admin-uploaded, human-approved CSVs

**Status:** planning only — nothing here has been executed yet.

## 0. Revision — §10/§14's corpus, promotion, and admin-upload machinery is KEPT, not deleted

**This reverses §1–§3 below (the original version of this plan), which said to delete
`training_corpus`, `corpusMaterializationService.js`, `promotion.py`, the artifact store, and
§14's admin Model Ops page. That reasoning is stale — left in place below as the record of
what was considered and why it changed, not as the current plan.** Read this section as the
authoritative one; §1–§3 is superseded history.

**What changed:** the original version assumed future retraining would be "swap in a new flat
CSV, refit, redeploy" with no comparison step — under that assumption, `training_corpus`,
promotion, and the artifact store had nothing left to do. The actual requirement is a
**champion/challenger workflow from the dashboard**: an admin uploads a CSV, it gets mapped,
preprocessed, and validated, a candidate model is fit from it, and that candidate is compared
against the currently-deployed model before anything is promoted. That's a real comparison
step with a real need to hold two models and a real human decision point — which is precisely
what `training_corpus` + `promotion.py`'s champion/challenger gate + the `pdm_artifacts` store
+ §14's admin page were already designed for. Deleting them and rebuilding equivalent
machinery under a different name would just be redoing the same work.

**Final architecture:**

1. **Bootstrap (one-time, unchanged from §3.2 below):** the initial Tier 2 model is fit
   directly from `train.csv` — six raw metrics, binary label, no timestamp — via a standalone
   `training.py` fit path, *outside* `training_corpus`. `train.csv`'s shape doesn't fit that
   table (no timestamp, no window structure), so it isn't forced through the corpus
   pipeline; it's a separate, simpler seed step that produces the first deployed artifact.
2. **All retraining after that goes through the existing upload pipeline, kept as originally
   designed (§10.4/§14.8 in the base plan):** admin uploads a CSV from the dashboard →
   Stage A (structural validation) → Stage B (column mapping, unit/range checks) → Stage C
   (physics-aware quality gate, reusing `/process-window`) → materialized into
   `training_corpus` → `retrain.py` fits a candidate → `promotion.py` compares it against the
   current champion → a human approves/rejects/rolls back from the admin-only page (§14.7).
   None of this is deleted; it is exactly §10.4/§10.5/§14 as originally specced, confirmed
   back in scope.
3. **HITL reviews predicted faults** (Tier 1/Tier 2 flags on live windows) — unchanged from
   the base plan, and separate from the retraining pipeline above. Worth restating the open
   point from earlier in this conversation: today only Tier 1 opens a `fault_events` row: if
   you want Tier 2 to be able to independently flag something Tier 1's rules miss for human
   review, that's still an explicit decision to make, not something this reversal changes.

**What stays dropped from the original §1–§3 version:** the `export.csv` idea
(`GET /api/pdm/fault-events/export.csv`, §3.5 below) — that existed to manufacture a
retraining CSV out of `fault_events` for a flow that no longer exists now that retraining is
admin-upload-driven from the dashboard, not derived from HITL review data. `fault_events`
stays exactly what it already was: the HITL triage/confirm log, nothing more.

---

## 1. Why the switch (superseded — see §0)

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

### 3.1 Delete (unused, superseded) — **STALE, see §0. Nothing in this table is actually deleted.**

`training_corpus`, `corpus.py`, `promotion.py`, `retrain.py`, `corpusMaterializationService.js`,
`corpusModel.js`, `trainingRunModel.js`, `recordTrainingRun.js`, and the `training_runs` table
are all **kept** — §0 explains why. `evaluation/episodes.py`'s walk-forward/episode split is
the one piece that genuinely doesn't apply to admin-uploaded CSVs either (they're still
window-mapped rows with a real timestamp per §10.4's Stage A/B, so a time-aware split *could*
apply — but a plain stratified split is simpler and adequate for this project's scale; keep
`check_evaluation_gate`'s minimum-episode-count purpose but decide at implementation time
whether it's still walk-forward-shaped or just a row-count floor). Original table below, left
for the reasoning trail only:

| Current | Original (superseded) reasoning |
|---|---|
| `pdm/app/corpus.py` | Reads `training_corpus` from Postgres — was going to be the training source. |
| `pdm/app/promotion.py` | Champion/challenger gate — was going to have nothing to arbitrate with a one-shot static model. |
| `pdm/app/retrain.py` | Orchestrates gate → split → evaluate → promote against `training_corpus`. |
| `pdm/app/evaluation/episodes.py` (`walk_forward_split`, `check_evaluation_gate`) | Time-series/episode-aware splitting — reconsider split strategy per note above, don't delete outright. |
| `server/database/migrations/005_training_corpus.sql` (table + `pdm_corpus_readonly` role) | Was going to be unused. |
| `server/services/corpusMaterializationService.js` | Turns `fault_events` into `training_corpus` rows — **note:** under §0's final design this service's *source* is wrong (it materializes from `fault_events`, but retraining data now comes from admin CSV uploads via `externalUploadService.js`, which already materializes into `training_corpus` directly, per §10.4 D10). Confirm at implementation time whether `corpusMaterializationService.js` is actually exercised by anything in the kept design, or whether `externalUploadService.js`'s own materialization step already covers it and this file is dead code regardless. |
| `server/models/corpusModel.js` | Model layer for `training_corpus` — kept. |
| `server/models/trainingRunModel.js` + the `training_runs` table (part of 005) | Tracks champion/challenger runs — kept, this is exactly what §0's comparison step needs. |
| `server/scripts/recordTrainingRun.js` | Persists `retrain.py`'s output into `training_runs` — kept. |
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
  `{"tier2FaultStatus": 0 | 1, "tier2Confidence": float}` (or `None` if the artifact failed
  to load — Tier 1 stays unaffected, same fallback posture as today).
  **`tier2FaultStatus` is an integer 0/1, not a boolean** — deliberately matching
  `train.csv`'s own `Engine_Condition` encoding (0 = normal, 1 = fault), so there's no
  boolean↔0/1 translation between what the model was trained on, what it emits, and what
  gets persisted (§3.5 below). `tier2Confidence` is the classifier's predicted probability
  for the predicted class, kept separate from `tier2FaultStatus` rather than folded into it.
- **`pdm/app/schemas.py`: `ScoreResponse`** gains the two Tier 2 fields above as optional —
  same fix §14.0 item 6 already identified as mandatory (FastAPI's `response_model` silently
  drops undeclared keys), just against a smaller field set than §14 specced.
- **`preprocessing/pipeline.py`'s `/process-window` path** must call `model.score()` the
  same way `/score` does — §14.0 item 5's finding (the live path stopped calling `/score` and
  never invokes `model.score()` at all) still applies verbatim and must be fixed here,
  regardless of which Tier 2 training approach is used.

### 3.4 Persisting Tier 2's verdict (resolves §5 open question 4)

Confirmed: persist Tier 2's prediction, not just serve it in the HTTP response. Add a
`tier2FaultStatus INTEGER` column (values `0`/`1`, nullable — null when no artifact is
loaded or a row's feature vector failed `to_vector()`) plus `tier2Confidence REAL` to
`fault_events` via a new migration, written by `pdmService.js` alongside the existing
Tier 1 fields on every scored window — not just on windows Tier 1 already flagged, since
Tier 2 runs independently and its 0/1 read is a distinct signal worth keeping even when
Tier 1 stays quiet. This is a plain integer column, not a new `eventType` or `status`
value — it does not interact with `fault_events.status`'s existing
`PENDING_REVIEW`/`CONFIRMED`/`REJECTED`/`N/A` lifecycle (§3.3 of the base plan), which stays
HITL-owned and untouched.

### 3.3 Migration housekeeping

- New migration `007_drop_training_corpus.sql`: `DROP TABLE IF EXISTS training_corpus`,
  `DROP TABLE IF EXISTS training_runs`, revoke/drop the `pdm_corpus_readonly` role. Keep
  `fault_events` untouched — Tier 1/HITL review is unaffected by this plan.
- `db/init/03-create-pdm-corpus-readonly-role.sh` — remove; the role it creates no longer
  has anything to read.

### 3.5 ~~Future retraining: export `fault_events` to the same CSV shape~~ — DROPPED, see §0

Superseded: retraining data comes from an admin-uploaded CSV via the dashboard (§10.4/§14.8's
existing upload → map → validate → materialize flow), not from an export generated out of
`fault_events`. `GET /api/pdm/fault-events/export.csv` is **not built** — `fault_events` stays
the HITL triage log only, with no CSV-export responsibility. Left below for the reasoning
trail, not as something to implement:

<details>
<summary>Original (superseded) design</summary>

Starts from a CSV exported from `fault_events`, going through the same `training.py` fit path
built for `train.csv`: six raw metric readings pulled at `triggerWindowEnd`, label derived
from `status = 'CONFIRMED'` → `1` / `eventType = 'NEGATIVE_SAMPLE'` → `0`, `faultType` dropped
to keep the label binary. Abandoned because retraining input is now an admin-uploaded CSV
through the existing Stage A/B/C pipeline instead.

</details>

### 3.6 Untouched

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
corrected there.

Per §0's reversal, §14.3's `pdm_artifacts` volume + hot-reload-on-promotion design is back in
scope as-is — it's what holds both the champion and a candidate during comparison, which the
bootstrap-only static-file approach can't support. The bootstrap artifact (from `train.csv`)
is just the first thing that ever lands in that same volume, not a different mechanism.

---

## 5. Open questions to settle before implementation

1. **Where does `train.csv` live long-term?** Committed into the repo under `data/`, or
   supplied at deploy time as a mounted file/build arg? Committing it is simplest and matches
   "static, manually-replaced artifact"; keeping it out of git avoids repo bloat if it grows.
2. ~~Retraining cadence going forward.~~ **Re-resolved, see §0 (supersedes the note below):**
   retraining is admin-triggered from the dashboard — upload a CSV, it's mapped/validated
   into `training_corpus`, `retrain.py` fits a candidate, `promotion.py` compares it to the
   champion, and a human approves/rejects/rolls back from §14.7's admin page. Not a rebuild
   of the `pdm` image, not export-driven. *(Superseded reasoning, kept for the record: an
   earlier version of this answer assumed retraining meant "export a CSV from `fault_events`,
   refit, rebuild the image" — see the struck-through §3.5 above for why that was dropped.)*
3. **Class balance.** `train.csv` is ~63%/37% (1/0) — not extreme, but worth deciding whether
   `class_weight='balanced'` is used by default (§14.2.2's reasoning for it still applies).
4. ~~Visibility into Tier 2 predictions.~~ **Resolved (§3.5):** persisted as
   `fault_events.tier2FaultStatus` (0/1) + `tier2Confidence`, written on every scored window.
   §14.6's full monitoring *page* is still out of scope — this is storage only, no UI.

---

## 6. Predicted Faults review queue — Tier 2 gets its own HITL path

**Why:** Tier 1 only fires once a hard threshold is actually crossed — it's reactive. Tier 2
is the thing that's actually predictive: it can flag a suspicious multivariate pattern before
any single metric breaches Tier 1's fixed limits. If only Tier 1 can open a review row, Tier
2's entire value — catching it earlier — never reaches a human. §0's "Tier 2 augments, never
replaces, the rule verdict" stays true for the *scoring* response, but it can no longer mean
"Tier 2 has no review path of its own."

**6.1 D — Tier 2 predictions get their own `fault_events` row, not just columns on Tier 1's.**
Reverses §3.4's original design (`tier2FaultStatus`/`tier2Confidence` as columns bolted onto
whatever row Tier 1 already created). Instead:

- `fault_events` gains `predictionSource TEXT NOT NULL DEFAULT 'TIER1_RULE'` —
  `TIER1_RULE` | `TIER2_MODEL` | `BOTH`. A window where only Tier 2 flags
  (`tier2FaultStatus = 1`, Tier 1 silent) opens its own row with `predictionSource =
  'TIER2_MODEL'`, going through the same coalescing logic (§3.3.2 of the base plan) so a
  sustained Tier 2 flag doesn't spam duplicate rows either. A window where both flag opens
  (or extends) one row with `predictionSource = 'BOTH'`.
- `tier2FaultStatus`/`tier2Confidence` (§3.4) stay as columns on the row either way — they're
  still useful context (how confident was Tier 2), just no longer the only way Tier 2's
  output is visible.

**6.2 Dashboard: a "Predicted Faults" tab.** Lists `PENDING_REVIEW` rows where
`predictionSource` includes `TIER2_MODEL`, showing the actual metric readings that drove the
flag (e.g. `motorTemp = 180`) — not a black-box score, the raw numbers a person can eyeball
and judge for themselves. This is a read surface over the existing HITL endpoints (§3.6 of
the base plan), not a new backend concept.

**6.3 Review labels the fault properly, not just confirm/reject.** The reviewer:
- Picks the actual fault type (`faultType` — already a `fault_events` column, no schema
  change needed there).
- Writes a reason (`rootCause` — already exists).
- Writes a resolution (`resolution` — already exists).
- On save, the row's `status` moves from `PENDING_REVIEW` to `CONFIRMED`, and the UI groups
  `CONFIRMED` rows under an **"Escalated"** view/tab — this is what actually notifies
  maintenance to go act on it. No new `status` enum value; "Escalated" is a dashboard-level
  grouping of `CONFIRMED` rows, not a new backend state, to avoid duplicating what `status`
  already encodes.

**6.4 This is what builds toward multi-class Tier 2, not just binary.** Every escalated row
is now a real labeled example with an actual fault-type label, not just 0/1 — this is exactly
what `training_corpus`/materialization (§0) accumulates over time, and exactly the kind of
per-class support `promotion.py`'s existing `min_support_per_class` gate (base plan §10.5) was
built to require before trusting a class. **"IF POSSIBLE," explicitly:** the binary bootstrap
model (§3.2) stays the deployed baseline until there's enough labeled diversity *per fault
type* to train a trustworthy multi-class classifier — not a hard deadline, not assumed to
happen on any timeline. `OTHER` remains the catch-all for anything that doesn't cleanly fit an
existing type (base plan §10.5 D1), same as already designed.

---

## 7. Definition of done (for whenever this is implemented)

**Bootstrap:**
- [ ] `pdm/app/model.py` loads a real artifact fit from `train.csv` and returns a non-None verdict
- [ ] `pdm/app/features.py`'s 6-field `FEATURE_ORDER` matches `train.csv` columns exactly, mapped to this codebase's existing metric names
- [ ] `/process-window` actually calls `model.score()` (§14.0 item 5's gap, fixed)
- [ ] `ScoreResponse` schema extended with `tier2FaultStatus` (int 0/1) and `tier2Confidence`, verified they survive `response_model` filtering
- [ ] `fault_events.tier2FaultStatus`/`tier2Confidence` columns added via migration and populated by `pdmService.js` on every scored window (§3.4)

**Retraining (kept, per §0 — `training_corpus`/promotion/artifact-store/admin-page work items are §10.5/§14's existing ones, not repeated here):**
- [ ] Admin CSV upload (§10.4/§14.8) → `training_corpus` materialization → `retrain.py` → `promotion.py` champion/challenger comparison → admin approve/reject/rollback (§14.4/§14.7) all function end-to-end
- [ ] `corpusMaterializationService.js`'s actual role confirmed against `externalUploadService.js`'s own materialization step (§3.1's open note) — dead code removed if redundant, kept if not
- [ ] Split strategy for admin-uploaded training data decided (walk-forward vs. row-count floor — §3.1's open note)

**Predicted Faults review queue (§6):**
- [ ] `fault_events.predictionSource` column added (`TIER1_RULE`/`TIER2_MODEL`/`BOTH`), populated correctly by `pdmService.js` for Tier-2-only, Tier-1-only, and both-flag windows
- [ ] A Tier-2-only flag opens its own coalescing-aware `fault_events` row, independent of Tier 1
- [ ] Dashboard "Predicted Faults" tab lists Tier-2-sourced `PENDING_REVIEW` rows with the raw metric readings shown
- [ ] Reviewer can set `faultType`/`rootCause`/`resolution` and the row surfaces under an "Escalated" view once `CONFIRMED`
- [ ] Escalated, labeled rows flow into `training_corpus` materialization same as any other confirmed event

**Unaffected:**
- [ ] Tier 1 verdict, `fault_events.status` HITL lifecycle, and the HITL review endpoints are unchanged
- [ ] §1's CT topology note corrected to "one CT, one Docker container per component"
