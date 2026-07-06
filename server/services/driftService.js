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
//   • REFERENCE window — an older, longer stretch of readings — establishes
//     what "normal" currently looks like: its mean and standard deviation.
//   • RECENT window — the newest, shorter stretch — is today's behaviour.
//   • We ask: is the recent window's average further from the reference
//     average than random noise could plausibly explain? That "plausible
//     noise" scale is the standard error of the mean (reference std dev /
//     sqrt(recent sample count)) — using sample count means a handful of
//     noisy readings can't trip the detector, but a *sustained* shift across
//     the whole recent window can.
//   • |z| past Z_THRESHOLD standard errors => flag 'rising' or 'falling'.
//
// Regime-aware filtering: both windows are built ONLY from readings whose
// `status` is RUNNING. FAULT/STOPPED episodes are real but they're not
// "drift" — they're already flagged directly by `status` — so letting one
// sit inside either window would corrupt what this detector calls "normal"
// (inflating the reference spread, or making a genuinely normal recent
// window look artificially different from a fault-contaminated reference).
// Filtering means each window's row count is a count of RUNNING samples,
// not a strict wall-clock duration — see ROW_FETCH_MULTIPLIER below.
//
// Row counts below assume ~1 reading/second from the Node-RED simulator.
// If the real ingest rate changes, retune *_WINDOW_ROWS (or switch to
// timestamp-based windowing) — the statistics don't change, only how much
// wall-clock time each window represents.
// ─────────────────────────────────────────────────────────────────────────

import * as model from '../models/forecastModel.js';
import { METRICS } from './forecastService.js';
import { logger } from '../utils/logger.js';

const RECENT_WINDOW_ROWS = 120;    // "right now" — last ~2 minutes of RUNNING data
const REFERENCE_WINDOW_ROWS = 900; // "normal" — the ~15 minutes of RUNNING data before that
const MIN_ROWS_FOR_DETECTION = RECENT_WINDOW_ROWS + REFERENCE_WINDOW_ROWS;
const Z_THRESHOLD = 3; // standard errors from the reference mean
const CHECK_INTERVAL_MS = 60 * 1000;
// Node-RED's simulator spends ~86% of its time in RUNNING and the rest in
// short FAULT/STOPPED episodes (see node-red/flow.json). Those episodes are
// real, but they aren't "drift" — Node-RED already flags them directly via
// `status` — so they must not be allowed to sneak into what this detector
// treats as "normal". We fetch this many times the two window sizes in raw
// rows so that, after filtering down to RUNNING-only readings, both windows
// still end up with enough data even if a fault episode happened to fall in
// the fetched range.
const ROW_FETCH_MULTIPLIER = 2;

// One drift entry per metric. Absent (null) until the first successful check.
const driftCache = Object.fromEntries(METRICS.map((m) => [m, null]));

const round2 = (value) => (value == null ? null : Math.round(value * 100) / 100);

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values, avg) {
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * @param series chronological (oldest-first), RUNNING-only values for one
 *   metric — FAULT/STOPPED readings are filtered out before this is called,
 *   so consecutive entries may skip real wall-clock time.
 * @returns the drift entry for that metric, or null if there isn't yet
 *   enough RUNNING history to compare against.
 */
function classify(series) {
  const recent = series.slice(-RECENT_WINDOW_ROWS);
  const reference = series.slice(-(RECENT_WINDOW_ROWS + REFERENCE_WINDOW_ROWS), -RECENT_WINDOW_ROWS);
  if (reference.length < REFERENCE_WINDOW_ROWS) return null;

  const referenceMean = mean(reference);
  const referenceStd = stdDev(reference, referenceMean);
  const recentMean = mean(recent);

  // Guard against a perfectly flat reference window (std = 0) producing a
  // divide-by-zero / infinite z — treat near-zero noise as a tiny noise
  // floor instead.
  const standardError = Math.max(referenceStd, 1e-6) / Math.sqrt(recent.length);
  const z = (recentMean - referenceMean) / standardError;

  let direction = 'stable';
  if (z > Z_THRESHOLD) direction = 'rising';
  else if (z < -Z_THRESHOLD) direction = 'falling';

  return {
    direction,
    z: round2(z),
    referenceMean: round2(referenceMean),
    recentMean: round2(recentMean),
    delta: round2(recentMean - referenceMean),
  };
}

/** Pull the latest window, re-check every metric, refresh the cache. */
function runDriftCheck() {
  const rows = model.getRecentReadings((RECENT_WINDOW_ROWS + REFERENCE_WINDOW_ROWS) * ROW_FETCH_MULTIPLIER);

  // rows are newest-first (id DESC); put them in chronological order, then
  // drop anything that wasn't a normal RUNNING reading. A FAULT/STOPPED
  // episode is a known, already-flagged event — not a candidate data point
  // for "what does normal look like" — so it's excluded here rather than
  // being allowed to quietly widen the reference spread or skew either
  // window's mean.
  const runningOnly = rows.slice().reverse().filter((row) => row.status === 'RUNNING');

  if (runningOnly.length < MIN_ROWS_FOR_DETECTION) {
    for (const metric of METRICS) driftCache[metric] = null;
    logger.info(`Drift check skipped: only ${runningOnly.length} RUNNING reading(s) available (need ${MIN_ROWS_FOR_DETECTION})`);
    return;
  }

  for (const metric of METRICS) {
    const series = runningOnly.map((row) => row[metric]);
    driftCache[metric] = classify(series);
  }
}

/** @returns the latest cached drift status for all 6 metrics. */
export function getDrift() {
  return { ...driftCache };
}

/** Starts the recurring drift-check timer. */
export function startDriftLoop() {
  runDriftCheck();
  setInterval(runDriftCheck, CHECK_INTERVAL_MS);
  logger.info(`Drift detection loop started: checking every ${CHECK_INTERVAL_MS / 1000}s`);
}
