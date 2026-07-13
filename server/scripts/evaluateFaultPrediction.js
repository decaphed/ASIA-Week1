// ─────────────────────────────────────────────────────────────────────────
// evaluateFaultPrediction.js — evaluates fault-onset prediction quality
// using a walk-forward (chronological, episode-boundary) train/test split,
// gated behind a minimum FAULT-episode count, per the project's evaluation
// requirements (see server/preprocessing/evaluation/episodes.js's module
// comment for the leakage/gating rationale).
//
// The predictor scored here is deliberately NOT a learned model: it's a
// non-learned baseline ("did any metric's window mean cross its alarm
// threshold this minute?") built from the existing THRESHOLDS/SUMMARY_METRICS
// config (server/config/thresholds.js) — the same bands summaryService.js
// already uses for the dashboard. Any future real classifier must beat these
// numbers at the same lead time before it's worth shipping.
//
// Usage:
//   node server/scripts/evaluateFaultPrediction.js
// ─────────────────────────────────────────────────────────────────────────

import db from '../database/db.js';
import { THRESHOLDS, SUMMARY_METRICS } from '../config/thresholds.js';
import { checkEvaluationGate, walkForwardSplit } from '../preprocessing/evaluation/episodes.js';
import { precisionRecallAtLeadTime, brierScore } from '../preprocessing/evaluation/metrics.js';

const LEAD_BUCKETS = [
  { label: '1-5 min', leadMinMinutes: 1, leadMaxMinutes: 5 },
  { label: '6-15 min', leadMinMinutes: 6, leadMaxMinutes: 15 },
  { label: '16-30 min', leadMinMinutes: 16, leadMaxMinutes: 30 },
];
const BRIER_LEAD_MAX_MINUTES = 30;
const BASELINE_THRESHOLD = 1; // score is already binary (0 or 1) for this baseline

const rows = db.prepare('SELECT * FROM processed_telemetry ORDER BY id ASC').all();

if (rows.length === 0) {
  console.log('No processed_telemetry rows yet — nothing to evaluate.');
  process.exit(0);
}

const gate = checkEvaluationGate(rows);

console.log('\nFault-onset prediction evaluation');
console.log('='.repeat(60));
console.log(`FAULT episodes found: ${gate.episodeCount} (need >= ${gate.required})`);

if (!gate.ready) {
  console.log('\nBLOCKED: not enough labeled FAULT episodes to evaluate.');
  console.log('This mirrors server/services/forecastService.js\'s MIN_READINGS');
  console.log('gate: too few episodes would let a split/model "fit" noise in the');
  console.log('small sample and report a spuriously confident result. Evaluation');
  console.log('will unblock automatically once enough real onsets have accumulated.');
  process.exit(0);
}

const { trainRows, testRows, trainEpisodes, testEpisodes } = walkForwardSplit(rows);

console.log(`\nWalk-forward split (chronological, episode-boundary):`);
console.log(`  Train: ${trainRows.length} row(s), ${trainEpisodes.length} episode(s)`);
console.log(`  Test:  ${testRows.length} row(s), ${testEpisodes.length} episode(s)`);

// ── Baseline predictor ──────────────────────────────────────────────────
// Non-learned: score = 1 if ANY metric's window mean is at/beyond its alarm
// band this minute, else 0. Only evaluated on RUNNING rows (the pump isn't
// already in FAULT/STOPPED), matching how an early-warning signal would
// actually be consumed in production — you don't need a "prediction" once
// the fault has already arrived.
function crossesAlarm(row) {
  for (const metric of SUMMARY_METRICS) {
    const band = THRESHOLDS[metric];
    const value = row[`${metric}Mean`];
    if (band.alarmHigh !== undefined && value >= band.alarmHigh) return true;
    if (band.alarmLow !== undefined && value <= band.alarmLow) return true;
  }
  return false;
}

const predictions = testRows
  .filter((row) => row.dominantStatus === 'RUNNING')
  .map((row) => ({ timestamp: row.timestamp, score: crossesAlarm(row) ? 1 : 0 }));

console.log(`\nBaseline predictor: threshold-crossing on ${SUMMARY_METRICS.length} metrics`);
console.log(`  Scored ${predictions.length} RUNNING row(s) in the test set`);

console.log('\nPrecision/recall by lead-time bucket:');
for (const bucket of LEAD_BUCKETS) {
  const result = precisionRecallAtLeadTime(predictions, testEpisodes, {
    leadMinMinutes: bucket.leadMinMinutes,
    leadMaxMinutes: bucket.leadMaxMinutes,
    threshold: BASELINE_THRESHOLD,
  });
  const fmt = (v) => (v === null ? 'n/a' : v.toFixed(3));
  console.log(
    `  ${bucket.label.padEnd(10)} precision=${fmt(result.precision)}  recall=${fmt(result.recall)}  ` +
      `tp=${result.tp} fp=${result.fp} fn=${result.fn}`
  );
}

const brier = brierScore(predictions, testEpisodes, { leadMaxMinutes: BRIER_LEAD_MAX_MINUTES });
console.log(`\nBrier score (${BRIER_LEAD_MAX_MINUTES}-min horizon): ${brier === null ? 'n/a' : brier.toFixed(4)}`);

console.log('\nAny future classifier must beat these baseline numbers at the same lead time before it is worth shipping.\n');
