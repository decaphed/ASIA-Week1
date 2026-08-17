// ─────────────────────────────────────────────────────────────────────────
// faultClassifier.js — distinguishes invalid data caused by sensor/wiring/
// scaling/configuration/communication failure (SENSOR_FAULT, safe to repair
// in the stats-facing copy) from valid measurements indicating genuine
// abnormal physical operation (NOT_SENSOR_FAULT, must be preserved
// unrepaired as evidence for PdM/fault-diagnosis/alarm analysis).
//
// No ground-truth fault signal exists in this data model (no CRC/comms-error
// bits, no redundant sensors, no stuck-at hardware flag) — this is
// inherently a statistical-signature heuristic, a first-pass triage flag for
// a data engineer / PdM analyst to review, not an oracle. Any run this
// classifier can't confidently attribute to a sensor-fault signature
// defaults to NOT_SENSOR_FAULT (never repaired) rather than guessing —
// consistent with the rest of this pipeline's "never fabricate a value it
// isn't confident about" philosophy (see missing.js's MAX_FILLABLE_GAP_SECONDS).
// ─────────────────────────────────────────────────────────────────────────

import { METRICS } from '../services/forecastService.js';
import { RANGES } from '../utils/validation.js';

const EPSILON = 1e-6;

function violatesRange(sample, metric) {
  if (sample[metric] == null) return false;
  const { min, max } = RANGES[metric];
  return sample[metric] < min || sample[metric] > max;
}

function isFlatlined(run, metric) {
  const values = run.map((s) => s[metric]).filter((v) => v != null);
  if (values.length < 2) return false;
  return values.every((v) => Math.abs(v - values[0]) < EPSILON);
}

function isPinnedAtBoundary(run, metric) {
  const { min, max } = RANGES[metric];
  const values = run.map((s) => s[metric]).filter((v) => v != null);
  if (values.length === 0) return false;
  return values.every((v) => Math.abs(v - min) < EPSILON || Math.abs(v - max) < EPSILON);
}

// Only meaningful when both a `before` and an `after` neighbor exist — a run
// this rule targets is short and returns close to its pre-run baseline right
// after it ends, the classic signature of a comms glitch/EMI spike rather
// than a real physical excursion.
function isSpikeAndReturn(run, before, after, metric) {
  if (!before || !after || run.length > 2) return false;
  if (before[metric] == null || after[metric] == null || run[0][metric] == null) return false;
  const excursion = Math.abs(run[0][metric] - before[metric]);
  if (excursion < EPSILON) return false;
  const residual = Math.abs(after[metric] - before[metric]);
  return residual < excursion * 0.3;
}

/**
 * @param {object} args
 * @param {object[]} args.run the consecutive physics-invalid samples (already known-invalid).
 * @param {object|null} args.before the last known-good sample before the run (may come from a
 *   different, already-closed window via buffer.js::getRecentTail()).
 * @param {object|null} args.after the first known-good sample after the run, or null if the run
 *   extends to the end of the window currently being processed (not yet closed out on that side).
 * @returns {'SENSOR_FAULT'|'NOT_SENSOR_FAULT'}
 */
export function classifyInvalidRun({ run, before, after }) {
  if (!run || run.length === 0) return 'NOT_SENSOR_FAULT';

  // An explicit, upstream-diagnosed fault status is the strongest available
  // signal that this is genuine abnormal operation, not a sensor problem.
  if (run.some((s) => s.status === 'FAULT' && s.faultType)) {
    return 'NOT_SENSOR_FAULT';
  }

  const excursionMetrics = METRICS.filter((metric) => run.some((s) => violatesRange(s, metric)));

  for (const metric of excursionMetrics) {
    // Stuck/flatlined — a classic wiring/ADC-latch signature, not a physical
    // process behavior.
    if (isFlatlined(run, metric)) return 'SENSOR_FAULT';
    // Rail/clip at the exact range boundary — a scaling/calibration signature.
    if (isPinnedAtBoundary(run, metric)) return 'SENSOR_FAULT';
    // Implausible instantaneous jump with a clean return to baseline — no
    // physical process moves this fast and reverses this cleanly.
    if (isSpikeAndReturn(run, before, after, metric)) return 'SENSOR_FAULT';
  }

  // Two or more metrics moving out of range together is far more consistent
  // with a real, physically-coherent process fault (independent sensors
  // failing in a correlated way is much less likely) than with sensor noise.
  if (excursionMetrics.length >= 2) return 'NOT_SENSOR_FAULT';

  // A long run is more consistent with a genuine regime transition than a
  // transient sensor glitch (mirrors outlier.js's own documented reasoning
  // about long runs typically being real regime changes, not noise).
  if (run.length >= 4) return 'NOT_SENSOR_FAULT';

  // Insufficient signal to confidently call this a sensor fault — preserve
  // as abnormal operation rather than guess.
  return 'NOT_SENSOR_FAULT';
}
