# PdM Design Implementation Plan

Implements `PdM_Design.docx` (Predictive Maintenance AI System — anomaly detector, per-fault-type detector ensemble, arbitration, human verification, retraining/promotion lifecycle). This supersedes Phases 4-6 of `FAULT_PREDICTION_PLAN.md` (single pooled logistic-regression classifier, blocked on 100 pooled episodes) with the doc's per-fault-type architecture. Source: `PdM_Design.docx` Sections 1-13, 15-17; `FAULT_PREDICTION_PLAN.md` Phases 0-3.5 (done); `server/preprocessing/{historicalFeatures,precapFeatures}.js`, `server/preprocessing/evaluation/{episodes,metrics}.js`, `server/services/processedService.js`, `server/models/processedModel.js`.

Architecture split agreed in review: Node stays the orchestrator (ingestion, DB, API, arbitration's simple decision table, human-verification workflow); a new Python service (`ml-service/`) owns everything statistical — Mahalanobis scoring, per-fault-type logistic regression, training, McNemar's promotion test, drift monitoring. Node computes features and the chronological train/test split (so "no leakage" logic lives in exactly one language) and hands Python pre-split feature/label arrays over HTTP; Python never touches the DB directly.

**Important gating change from `FAULT_PREDICTION_PLAN.md`:** that plan blocks all model work on 100 *pooled* FAULT episodes. This design's Section 4 tiers are *per fault type* (Provisional at 10, Validated at 30), so a well-populated fault type (e.g. THERMAL, if it has 10+ confirmed episodes) can start Provisional-tier work before the pooled count reaches 100. Re-run `node server/scripts/evaluateFaultPrediction.js`, but also break the count down by `faultType` before treating any step below as blocked.

## Step 0 - Verify regime labels exist

Before Section 6's anomaly detector can be built as designed (Mahalanobis distance per regime, standalone, no clustering), confirm whether an existing plant tag or rule (load %, speed reference, valve position, equipment mode) can serve as the "operating condition" label the doc assumes in Section 15. If nothing suitable exists, Section 6 needs a clustering step (GMM, not k-means, since Mahalanobis needs each cluster's own covariance) inserted ahead of scoring — this changes Step 4 below. Do not start Step 4 until this is answered; it is the one assumption the whole anomaly-detector design rests on.

## Step 1 - Channel-role feature restructuring

Restructure `server/preprocessing/historicalFeatures.js` and `server/preprocessing/precapFeatures.js` so engineered features are grouped by channel role (vibration, temperature, flow, pressure, speed) per Section 3.2, rather than keyed directly by raw metric name (`flowRate`, `rpm`, etc.) as they are today. Both the anomaly detector and the fault detector ensemble consume this feature set, so this has to land before Steps 4-5. If Step 0 determines regime labels don't exist yet, add the regime/operating-condition tag as a field alongside each row's features here too, so it's available for per-regime baselining without a second pass over history.

## Step 2 - Per-fault-type episode identification and data tiers

Extend `server/preprocessing/evaluation/episodes.js`'s `identifyEpisodes()` to accept/filter by `faultType`, since Section 4's tiers (Insufficient <10, Provisional 10-29, Validated 30+) are evaluated per fault type, not pooled. Add `server/config/dataTiers.js` holding the configurable per-type thresholds (Section 4 explicitly calls these configurable, not fixed — a fault type where a miss is costlier can require a stricter bar). Add a new route or extend an existing one in `server/routes/index.js` that exposes per-fault-type episode data (already chronologically ordered, already split) for the Python service to pull training data from — this is the one Node/Python boundary, so get its shape right before Step 4.

## Step 3 - Human verification workflow (schema + endpoints)

Add the tables Section 9 needs — confirmed-episode log per fault type, and verification records with full window data (not just a label) — to `server/database/schema.sql` and `server/database/db.js` (matching the existing migration pattern). Add `server/models/verificationModel.js` and `server/controllers/verificationController.js` for the three verdicts (confirmed known fault, confirmed new fault type — seeds an Insufficient-tier model with zero effect on existing detectors, false alarm — feeds the normal pool or a detector's negative set). Mount the new endpoints in `server/routes/index.js`, with request validators added to `server/utils/validation.js`. This can be built and tested independently of Steps 4-8 since it only needs the existing `faultType`/window data already being collected.

## Step 4 - Python ML service skeleton

Stand up `ml-service/` with `app.py` (FastAPI, a single `/score` endpoint for now), `config.py` (tier thresholds and fault-type list mirrored from Node's `VALID_FAULT_TYPES` — port, don't import, same convention `server/config/thresholds.js` already uses for client/server), `model_store.py` (load/save versioned model artifacts per fault type and for the anomaly detector), and `requirements.txt`. Add `server/services/mlClient.js` in Node as the HTTP client. No real model logic yet — this step is just proving the two processes can talk, so it can be verified with a stub `/score` response before any statistics are written.

## Step 5 - Anomaly / novelty detector (Section 6)

Implement `ml-service/anomaly_detector.py`: per-regime mean vector + covariance matrix over confirmed-normal data, Mahalanobis distance scoring on every reading. If Step 0 found no usable regime labels, this is where the GMM clustering step gets inserted ahead of the per-cluster Mahalanobis fit — flag this explicitly in the module's own header if so, since it's a deviation from the doc's stated design. Wire scoring into `server/services/processedService.js` (same hook point as `forecastOnNewRecord`/`driftOnNewRecord`/`trendOnNewRecord`) via `mlClient.js`, and store the score on the row via a new column in `server/models/processedModel.js` (same pattern as `precapFeaturesByMetric`).

## Step 6 - Known fault detector ensemble (Section 7)

Implement `ml-service/fault_detector.py`: one independent logistic regression per fault type, trained only on the fault types that have cleared at least Provisional tier per Step 2's per-type counts. Each detector scores every reading in parallel — nothing gated on the anomaly detector's output (Section 1's central argument; do not reintroduce the old single-point-of-failure gate). Start with whichever fault type(s) clear Provisional first rather than waiting for all of them, consistent with Section 4's tiering.

## Step 7 - Arbitration (Section 8)

Implement `server/services/arbitrationService.js` in Node: the fixed decision table (no fault + no anomaly = normal; no fault + anomaly = unknown anomaly, routed to review; exactly one fault type fires = known fault; more than one fires = ambiguous, routed to review with all scores shown). This is plain business logic combining the scores Steps 5-6 already produced, not a model, so it stays in Node rather than crossing the HTTP boundary again. Feed its output into `predictionController.js` (new) for the dashboard, and into Step 3's verification workflow when the outcome routes to review.

## Step 8 - Retraining and promotion (Sections 10, 12)

Implement `ml-service/train_fault_detector.py` and `ml-service/train_anomaly_detector.py` (triggered by: N new confirmed episodes, quarterly schedule, or a monitoring flag from Step 9), and `ml-service/promotion.py` (exact McNemar's test at α = 0.10, comparing candidate vs. currently-deployed detector on held-out episodes, plus the Section 12.3 promotion checklist). A rejected candidate's results and rejection reason get logged via Step 4's `model_store.py`. This step depends on Step 3's verification records existing (they're the source of confirmed episodes) and Step 6's detectors being live (there has to be a "currently deployed" detector to compare against).

## Step 9 - Monitoring for drift (Section 13)

Implement `ml-service/drift_monitor.py`: data drift (feature distribution vs. training, per channel role) and concept drift (feature-to-outcome relationship per fault type, tracked against Step 3's verification outcomes). This only ever raises a flag consumed by Step 8's retraining trigger — it must never modify a deployed detector directly, per Section 13's explicit rejection of unchecked automatic updates. Note this is a distinct concept from the existing `server/services/driftService.js`, which tracks raw sensor-value drift, not model feature/concept drift — leave that file alone.

## Step 10 - Audit and regression coverage

Audit `server/services/processedService.js` and `server/models/processedModel.js` for any assumption inherited from the pre-Steps-1-9 shape (mirrors the audit step in `docs/plan/2026-07-16-pipeline-review-response.md`), and add regression coverage for: per-fault-type episode identification correctness (Step 2), arbitration's decision table against all four branches including the ambiguous multi-fire case (Step 7), and the promotion gate correctly refusing a regressed candidate (Step 8) — this last one is the mechanical enforcement of Section 11's forgetting-prevention argument, so it's worth testing deliberately rather than trusting the design narrative alone.
