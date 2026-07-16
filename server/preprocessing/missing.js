// ─────────────────────────────────────────────────────────────────────────
// missing.js — missing-sample detection AND gap-filling.
//
// detectMissing() walks a completed window's timestamps and counts gaps —
// this now only ever finds RESIDUAL gaps, i.e. ones too large to trust an
// interpolated guess for (see generateFillSamples below), since fillable
// gaps are reconstructed proactively, per incoming sample, in pipeline.js —
// before a window is ever assembled. It also accounts for LEADING/TRAILING
// boundary gaps now that windows are event-time-bounded rather than
// count-bounded (a window can have real time before its first sample or
// after its last one).
//
// generateFillSamples() is the actual gap-filling: for a gap up to each
// metric's own MAX_FILLABLE_GAP_SECONDS_BY_METRIC ceiling, linearly
// interpolate that metric's missing ticks between the last known-good
// sample and the newly-arrived one; a metric whose gap exceeds ITS ceiling
// is left `null` on the fill row and listed in `unfilledMetrics`, rather than
// forcing every metric to share one uniform ceiling. The categorical
// `status` field is carried forward (it can't be interpolated), UNLESS a
// transition is suspected between the two endpoints, in which case nothing
// is fabricated at all for that gap — see transition.js.
//
// imputeInvalidRuns() replaces runs of physics-invalid samples with
// interpolated values, but ONLY when faultClassifier.js determines the run
// is a SENSOR_FAULT (safe to repair). A run classified NOT_SENSOR_FAULT
// (genuine abnormal operation) is left raw and tagged `abnormalOperation:
// true` instead, so outlier.js can exempt it from Hampel capping too — see
// outlier.js's excludeMask.
// ─────────────────────────────────────────────────────────────────────────

import { classifyInvalidRun } from './faultClassifier.js';
import { detectTransition } from './transition.js';
import { MAX_FILLABLE_GAP_SECONDS_BY_METRIC, MAX_FILLABLE_GAP_SECONDS } from './config.js';

const GAP_THRESHOLD_SECONDS = 1.5;

export { MAX_FILLABLE_GAP_SECONDS };

/**
 * Linearly interpolate each of `metrics` between `from` and `to` at position
 * `t` (0..1). A metric that's null on either endpoint can't be interpolated
 * with any confidence (it was itself an unfilled/uncertain value) — it's
 * left null and reported in `unfilled` rather than treating the missing
 * side as if it were exactly 0.
 */
function interpolateMetrics(from, to, t, metrics) {
  const values = {};
  const unfilled = [];
  for (const metric of metrics) {
    if (from[metric] == null || to[metric] == null) {
      values[metric] = null;
      unfilled.push(metric);
      continue;
    }
    values[metric] = from[metric] + t * (to[metric] - from[metric]);
  }
  return { values, unfilled };
}

/**
 * @param {object|object[]} window a completed window — either a WindowState
 *   (buffer.js) with .samples/.windowStart/.windowEnd, or a plain array
 *   (kept for direct-array callers).
 * @returns {number} missingSampleCount — estimated number of ticks that never arrived.
 */
export function detectMissing(window) {
  const samples = Array.isArray(window) ? window : window.samples;
  let missingCount = 0;

  for (let i = 1; i < samples.length; i++) {
    const dtSec = (Date.parse(samples[i].timestamp) - Date.parse(samples[i - 1].timestamp)) / 1000;
    if (dtSec > GAP_THRESHOLD_SECONDS) {
      missingCount += Math.round(dtSec) - 1;
    }
  }

  if (!Array.isArray(window) && samples.length > 0 && window.windowStart && window.windowEnd) {
    const leadingGapSec = (Date.parse(samples[0].timestamp) - Date.parse(window.windowStart)) / 1000;
    if (leadingGapSec > GAP_THRESHOLD_SECONDS) missingCount += Math.round(leadingGapSec);

    const trailingGapSec = (Date.parse(window.windowEnd) - Date.parse(samples[samples.length - 1].timestamp)) / 1000;
    if (trailingGapSec > GAP_THRESHOLD_SECONDS) missingCount += Math.round(trailingGapSec);
  }

  return missingCount;
}

/**
 * @param {object|null} lastSample the last sample actually accepted/merged (any provenance), or null if this is the first ever.
 * @param {object} newSample the just-arrived real sample.
 * @param {string[]} metrics numeric metric names to interpolate.
 * @returns {object[]} zero or more synthesized samples to insert (in order) between lastSample and newSample.
 */
export function generateFillSamples(lastSample, newSample, metrics) {
  if (!lastSample) return [];

  const lastMs = new Date(lastSample.timestamp).getTime();
  const newMs = new Date(newSample.timestamp).getTime();
  const dtSec = (newMs - lastMs) / 1000;

  // Too large for even the most tolerant metric, arrived out of order, or
  // not actually a gap (normal cadence) — nothing to fill.
  if (dtSec > MAX_FILLABLE_GAP_SECONDS) return [];
  const missingTicks = Math.round(dtSec) - 1;
  if (missingTicks <= 0) return [];

  // A suspected transition (status change, or either endpoint already
  // physics-invalid) invalidates the "nothing eventful happened" assumption
  // for the WHOLE gap, categorically — these are whole-row signals, not
  // per-metric, so nothing is fabricated at all rather than guessing which
  // parts might still be trustworthy.
  const transition = detectTransition({ from: lastSample, to: newSample, dtSec });
  if (transition.statusChanged || transition.eitherInvalid) return [];

  const fills = [];
  for (let i = 1; i <= missingTicks; i++) {
    const t = i / (missingTicks + 1); // evenly spaced across the gap
    const row = {
      timestamp: new Date(lastMs + t * (newMs - lastMs)).toISOString(),
      status: lastSample.status, // categorical — carry forward, can't interpolate
      provenance: 'IMPUTED',
    };

    const unfilledMetrics = [];
    for (const metric of metrics) {
      const ceiling = MAX_FILLABLE_GAP_SECONDS_BY_METRIC[metric] ?? MAX_FILLABLE_GAP_SECONDS;
      if (dtSec > ceiling || transition.rampExceeded[metric]) {
        row[metric] = null;
        unfilledMetrics.push(metric);
        continue;
      }
      row[metric] = lastSample[metric] + t * (newSample[metric] - lastSample[metric]);
    }
    if (unfilledMetrics.length) row.unfilledMetrics = unfilledMetrics;

    fills.push(row);
  }
  return fills;
}

/**
 * Replace runs of physics-invalid samples inside a completed window with
 * linearly-interpolated values — but ONLY when faultClassifier.js verdicts
 * the run SENSOR_FAULT. A NOT_SENSOR_FAULT run (genuine abnormal operation)
 * is left raw and tagged `abnormalOperation: true` instead, so it's
 * preserved as evidence rather than smoothed away. The raw invalid values
 * are never mutated (they're already stored for audit before this runs);
 * this only affects the copy used for stats/forecast/trend.
 *
 * @param {object[]} window completed AUDIT window, in timestamp order.
 * @param {string[]} metrics numeric metric names to interpolate.
 * @param {object[]} [recentTail] timestamp-sorted cross-window tail (buffer.js::getRecentTail())
 *   used as a `before` neighbor when a run starts at the very beginning of `window`.
 * @returns {object[]} same length as window; SENSOR_FAULT runs replaced with
 *   samples flagged imputedForPhysics: true; NOT_SENSOR_FAULT runs flagged
 *   abnormalOperation: true; everything else untouched.
 */
export function imputeInvalidRuns(window, metrics, recentTail = []) {
  const result = window.slice();
  let i = 0;

  while (i < result.length) {
    if (result[i].physicsValid !== false) {
      i++;
      continue;
    }

    let j = i;
    while (j < result.length && result[j].physicsValid === false) j++;
    // Invalid run is [i, j).
    const run = result.slice(i, j);
    const before = i > 0 ? result[i - 1] : (recentTail.length ? recentTail[recentTail.length - 1] : null);
    const after = j < result.length ? result[j] : null;

    // Classification happens synchronously, using whatever neighbors
    // actually exist — a run touching the window's end (after === null) is
    // still classified now, not deferred (there is no "next window" to defer
    // to; this window's stats are computed and stored before any later
    // window could ever provide that context). faultClassifier.js's
    // spike-and-return rule is the only one that needs `after`; every other
    // rule works from `before` + the run's own shape.
    const verdict = classifyInvalidRun({ run, before, after });

    if (verdict === 'SENSOR_FAULT' && (before || after)) {
      const from = before ?? after;
      const to = after ?? before;
      const beforeMs = before ? Date.parse(before.timestamp) : null;
      const afterMs = after ? Date.parse(after.timestamp) : null;

      for (let k = 0; k < run.length; k++) {
        let t;
        if (before && after && afterMs !== beforeMs) {
          // Elapsed-time-weighted, not index-weighted — adjacent array
          // positions no longer imply uniform elapsed time now that
          // late/merged samples can be interleaved into a sorted window.
          const sampleMs = Date.parse(result[i + k].timestamp);
          t = (sampleMs - beforeMs) / (afterMs - beforeMs);
        } else {
          // Only one side available (or both endpoints coincide) — flat
          // carry-forward/back, same degenerate case as before.
          t = 1;
        }
        const { values, unfilled } = interpolateMetrics(from, to, t, metrics);
        result[i + k] = {
          ...result[i + k],
          imputedForPhysics: true,
          ...values,
          ...(unfilled.length ? { unfilledMetrics: unfilled } : {}),
        };
      }
    } else {
      // NOT_SENSOR_FAULT (or no neighbor at all to interpolate from) —
      // preserve as genuine abnormal-operation evidence, untouched.
      for (let k = 0; k < run.length; k++) {
        result[i + k] = { ...result[i + k], abnormalOperation: true };
      }
    }

    i = j;
  }

  return result;
}
