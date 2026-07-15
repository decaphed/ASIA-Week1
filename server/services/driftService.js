// ─────────────────────────────────────────────────────────────────────────
// driftService.js — sustained-degradation ("drift") detector for the 6
// numeric pump metrics. This is deliberately separate from forecastService:
// forecastService's damped-trend ETS answers "what's the next reading
// likely to be", on a short horizon, and is intentionally biased to flatten
// out transient trends. This service answers a different question — "has
// the metric moved to a new normal and stayed there" — on a much longer
// horizon, which a damped short-horizon forecaster is not designed to see.
//
// Method: a two-sample z-test on the mean.
//   • REFERENCE window — an older, longer stretch of processed records —
//     establishes what "normal" currently looks like: its mean and standard
//     deviation.
//   • RECENT window — the newest, shorter stretch — is today's behaviour.
//   • We ask: is the recent window's average further from the reference
//     average than random noise could plausibly explain? That "plausible
//     noise" scale is the standard error of the mean (reference std dev /
//     sqrt(recent sample count)) — using sample count means a handful of
//     noisy minutes can't trip the detector, but a *sustained* shift across
//     the whole recent window can.
//   • |z| past Z_THRESHOLD standard errors => flag 'rising' or 'falling'.
//
// Input: as of the preprocessing pipeline, both windows are built from
// processed_telemetry's per-metric MEAN (one value per minute, already
// outlier-capped and quality-scored) rather than raw 1 Hz readings — the
// same rationale as forecastService: "has this metric drifted" is a
// management/condition-monitoring question, better answered from the
// cleaned aggregate than from second-to-second sensor noise.
//
// Regime-aware filtering: both windows are built ONLY from records whose
// `dominantStatus` is RUNNING. FAULT/STOPPED episodes are real but they're
// not "drift" — they're already flagged directly by `dominantStatus` — so
// letting one sit inside either window would corrupt what this detector
// calls "normal" (inflating the reference spread, or making a genuinely
// normal recent window look artificially different from a fault-
// contaminated reference). Filtering means each window's row count is a
// count of RUNNING minutes, not a strict wall-clock duration — see
// ROW_FETCH_MULTIPLIER below.
//
// Trigger: runDriftCheck() runs once, on startup (to pick up any history
// already in the database), and again every time a new processed record
// arrives (event-driven — see onNewProcessedRecord), instead of on a fixed
// timer. A new processed record IS "one more minute of data available", so
// there is nothing to gain from polling in between arrivals.
// ─────────────────────────────────────────────────────────────────────────

import * as model from '../models/forecastModel.js';
import { METRICS } from './forecastService.js';
import { logger } from '../utils/logger.js';

// Exported (not just module-local) so historicalFeatures.js can replay this
// exact z-test causally over stored history — see that module's header for
// why the fault-prediction training set needs a byte-identical drift feature
// rather than a re-derived approximation.
export const RECENT_WINDOW_ROWS = 15;     // "right now" — last ~15 minutes of RUNNING data
export const REFERENCE_WINDOW_ROWS = 120; // "normal" — the ~2 hours of RUNNING data before that
const MIN_ROWS_FOR_DETECTION = RECENT_WINDOW_ROWS + REFERENCE_WINDOW_ROWS;
const Z_THRESHOLD = 3; // standard errors from the reference mean

// Operating range (mirrors trendService.js's OPERATING_RANGE / client's
// SENSORS min/max) — used only to gate direction on PRACTICAL magnitude,
// alongside the z-test's statistical significance. Needed because the
// z-test's standard error (referenceStd / sqrt(RECENT_WINDOW_ROWS)) assumes
// the recent window's samples are independent; per-minute pump metrics are
// not (motorTemp's observed lag-1 autocorrelation is ~0.9), so the true
// uncertainty is far larger than sqrt(n) suggests and the naive z-test
// reports "significant" drift almost continuously — including shifts under
// 1% of a sensor's operating range, which is noise, not condition change.
// Requiring the shift to also clear MIN_RANGE_PCT of the range keeps the
// z-test (still useful for catching truly flat vs. truly moving) while
// refusing to call a shift "drift" unless it's big enough to matter.
const OPERATING_RANGE = {
  flowRate: { min: 50, max: 300 },
  rpm: { min: 1000, max: 3600 },
  vibration: { min: 0.5, max: 12 },
  suctionPressure: { min: 0.5, max: 3 },
  dischargePressure: { min: 2, max: 12 },
  motorTemp: { min: 20, max: 90 },
};
const MIN_RANGE_PCT = 5; // recentMean vs. referenceMean must differ by at least this % of the operating range
// The simulator spends ~86% of its time in RUNNING and the rest in short
// FAULT/STOPPED episodes (see node-red/flow.json). Those episodes are real,
// but they aren't "drift" — the pipeline already flags them directly via
// `dominantStatus` — so they must not be allowed to sneak into what this
// detector treats as "normal". We fetch this many times the two window
// sizes in raw rows so that, after filtering down to RUNNING-only records,
// both windows still end up with enough data even if a fault episode
// happened to fall in the fetched range.
const ROW_FETCH_MULTIPLIER = 2;

// One drift entry per metric. Absent (null) until the first successful check.
const driftCache = Object.fromEntries(METRICS.map((m) => [m, null]));

const round2 = (value) => (value == null ? null : Math.round(value * 100) / 100);

/** The mean value for one metric out of a processed_telemetry row. */
const metricMean = (row, metric) => row[`${metric}Mean`];

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values, avg) {
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * @param metric metric key — looked up in OPERATING_RANGE for the magnitude gate.
 * @param series chronological (oldest-first), RUNNING-only per-minute mean
 *   values for one metric — FAULT/STOPPED records are filtered out before
 *   this is called, so consecutive entries may skip real wall-clock time.
 * @returns the drift entry for that metric, or null if there isn't yet
 *   enough RUNNING history to compare against.
 */
export function classify(metric, series) {
  const recent = series.slice(-RECENT_WINDOW_ROWS);
  const reference = series.slice(-(RECENT_WINDOW_ROWS + REFERENCE_WINDOW_ROWS), -RECENT_WINDOW_ROWS);
  if (reference.length < REFERENCE_WINDOW_ROWS) return null;

  // A single non-finite value poisons referenceMean/recentMean/z to NaN.
  // Math.abs(NaN) > Z_THRESHOLD is false, so isSignificant would silently
  // become false and direction would default to 'stable' — read as a
  // confident "confirmed no drift" rather than "couldn't compute". Report
  // null (same as "not enough data") instead of a misleadingly confident
  // answer built on bad data.
  if (!recent.every(Number.isFinite) || !reference.every(Number.isFinite)) return null;

  const referenceMean = mean(reference);
  const referenceStd = stdDev(reference, referenceMean);
  const recentMean = mean(recent);
  const delta = recentMean - referenceMean;

  // Guard against a perfectly flat reference window (std = 0) producing a
  // divide-by-zero / infinite z — treat near-zero noise as a tiny noise
  // floor instead.
  const standardError = Math.max(referenceStd, 1e-6) / Math.sqrt(recent.length);
  const z = (recentMean - referenceMean) / standardError;

  const { min, max } = OPERATING_RANGE[metric];
  const rangePct = (Math.abs(delta) / (max - min)) * 100;
  const isSignificant = Math.abs(z) > Z_THRESHOLD && rangePct >= MIN_RANGE_PCT;

  let direction = 'stable';
  if (isSignificant) direction = z > 0 ? 'rising' : 'falling';

  return {
    direction,
    z: round2(z),
    referenceMean: round2(referenceMean),
    recentMean: round2(recentMean),
    delta: round2(delta),
    rangePct: round2(rangePct),
  };
}

/** Pull the latest window, re-check every metric, refresh the cache. */
function runDriftCheck() {
  const rows = model.getRecentReadings((RECENT_WINDOW_ROWS + REFERENCE_WINDOW_ROWS) * ROW_FETCH_MULTIPLIER);

  // rows are newest-first (id DESC); put them in chronological order, then
  // drop anything that wasn't a normal RUNNING minute. A FAULT/STOPPED
  // episode is a known, already-flagged event — not a candidate data point
  // for "what does normal look like" — so it's excluded here rather than
  // being allowed to quietly widen the reference spread or skew either
  // window's mean.
  const runningOnly = rows.slice().reverse().filter((row) => row.dominantStatus === 'RUNNING');

  if (runningOnly.length < MIN_ROWS_FOR_DETECTION) {
    for (const metric of METRICS) driftCache[metric] = null;
    logger.info(`Drift check skipped: only ${runningOnly.length} RUNNING processed record(s) available (need ${MIN_ROWS_FOR_DETECTION})`);
    return;
  }

  for (const metric of METRICS) {
    const series = runningOnly.map((row) => metricMean(row, metric));
    driftCache[metric] = classify(metric, series);
  }
}

/** @returns the latest cached drift status for all 6 metrics. */
export function getDrift() {
  return { ...driftCache };
}

/**
 * Called by processedController after each new processed record is stored.
 * Re-runs the full windowed check (cheap: it re-queries only
 * (RECENT+REFERENCE)*ROW_FETCH_MULTIPLIER rows) rather than trying to
 * incrementally update the reference/recent means, keeping the statistics
 * identical to a from-scratch computation.
 */
export function onNewProcessedRecord() {
  runDriftCheck();
}

/** Runs an initial check on startup to pick up any history already stored. */
export function startDriftLoop() {
  runDriftCheck();
  logger.info('Drift detection loop started: initial check run; subsequent checks are event-driven (see onNewProcessedRecord)');
}
