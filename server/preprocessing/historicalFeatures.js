// ─────────────────────────────────────────────────────────────────────────
// historicalFeatures.js — persists a "features as they looked at the time"
// snapshot per processed_telemetry row, closing the data gap noted in
// FAULT_PREDICTION_PLAN.md's Phase 4 section: forecastService.js and
// driftService.js only keep LIVE in-memory state, so nothing about "what did
// the drift z-score look like 10 minutes before this past fault" was
// recoverable from the DB alone. This module computes an equivalent,
// storable snapshot causally — using only rows up to and including the
// current one, never rows after it, matching the plan's no-leakage
// requirement — so every row, past and future, carries the features a fault
// predictor will actually train on.
//
// Two feature families, and they are NOT interchangeable in trustworthiness:
//   • driftZ / driftDirection — replays driftService's own two-sample z-test
//     verbatim (see the `classify` export there) over the RUNNING-only
//     prefix up to this row, so it is provably identical to what the live
//     dashboard would have shown at that moment, not a re-derived
//     approximation.
//   • rollingMean / rollingStd / rollingSlope — a deliberately SIMPLER
//     stand-in for forecastService's damped-trend ETS state. Reproducing ETS
//     exactly would require replaying its 15-minute wall-clock refit timer
//     plus regime-reset/outlier-capping logic historically, which depends on
//     real-time arrival timing that can't be reconstructed from stored rows
//     alone. A plain trailing-window OLS slope needs no such replay and is
//     adequate signal for a linear model, but it is NOT byte-identical to
//     forecastService's live trend/level output — training/eval code must
//     not assume parity between the two.
// ─────────────────────────────────────────────────────────────────────────

import { round2 } from './aggregation.js';
import { classify, RECENT_WINDOW_ROWS, REFERENCE_WINDOW_ROWS } from '../services/driftService.js';

export const METRICS = ['engineRpm', 'lubOilPressure', 'fuelPressure', 'coolantPressure', 'lubOilTemperature', 'coolantTemperature'];

// Trailing window for the rolling mean/std/slope stand-in. Matches
// forecastService's RESIDUAL_WINDOW (30) — long enough for a slope fit to
// reflect more than one or two noisy minutes, short enough to still track a
// real regime change within half an hour.
const ROLLING_WINDOW = 30;

// How many RUNNING-only rows the drift z-test needs before it can produce a
// value at all (mirrors driftService's own MIN_ROWS_FOR_DETECTION).
const MIN_RUNNING_ROWS_FOR_DRIFT = RECENT_WINDOW_ROWS + REFERENCE_WINDOW_ROWS;

// How many raw (any-status) rows to fetch when computing features for ONE
// new row at ingest time, so that after filtering to RUNNING-only there is
// still enough history for the drift test even if a FAULT/STOPPED episode
// falls inside the fetched range — same rationale as driftService's
// ROW_FETCH_MULTIPLIER.
const ROW_FETCH_MULTIPLIER = 2;
export const INGEST_FETCH_ROWS = MIN_RUNNING_ROWS_FOR_DRIFT * ROW_FETCH_MULTIPLIER;

/**
 * Ordinary-least-squares slope + mean/std over a trailing window of values.
 * @param {number[]} windowValues chronological (oldest-first) values ending
 *   at the current row.
 */
function rollingStats(windowValues) {
  const n = windowValues.length;
  // A single non-finite value (bad reading, missing metric) must not poison
  // mean/std/slope into NaN, which round2() would silently turn into a JSON
  // null indistinguishable from "not enough data yet" — report the honest
  // "can't compute" instead.
  if (n < 2 || !windowValues.every(Number.isFinite)) {
    return { rollingMean: null, rollingStd: null, rollingSlope: null };
  }

  const meanVal = windowValues.reduce((a, b) => a + b, 0) / n;
  const variance = windowValues.reduce((a, b) => a + (b - meanVal) ** 2, 0) / n;

  // Slope of value against index (0..n-1) via closed-form OLS.
  const xMean = (n - 1) / 2;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (windowValues[i] - meanVal);
    den += (i - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;

  return {
    rollingMean: round2(meanVal),
    rollingStd: round2(Math.sqrt(variance)),
    rollingSlope: round2(slope),
  };
}

/**
 * Compute historicalFeaturesByMetric causally for every row in
 * `chronologicalRows` — row i's features use only rows[0..i], never rows
 * after it.
 * @param {object[]} chronologicalRows processed_telemetry rows, oldest
 *   first, each with `${metric}Mean` and `dominantStatus` already populated.
 * @returns {{ id: number|undefined, historicalFeaturesByMetric: object }[]}
 *   parallel array; `id` is undefined for a row that hasn't been inserted
 *   yet (the ingest-time call site — see computeFeaturesForNewRow below).
 */
export function computeHistoricalFeatures(chronologicalRows) {
  const results = [];
  // First index (into chronologicalRows) of the current dominantStatus run —
  // advances whenever status differs from the previous row. Bounds the
  // rolling window below so a FAULT/STOPPED episode's mean can't sit inside
  // the trailing OLS window and bias rollingSlope/rollingStd for
  // ROLLING_WINDOW rows after the episode ends — the same structural-break
  // concern forecastService's regime-aware reset addresses for ETS, just
  // resolved immediately here (no 3-row persistence check) since this is an
  // offline causal replay, not a live stream reacting to noisy blips. See
  // the file header: deliberately simpler than ETS, not a byte-identical
  // replay of it.
  let regimeStartIndex = 0;

  for (let i = 0; i < chronologicalRows.length; i++) {
    const row = chronologicalRows[i];
    if (i > 0 && row.dominantStatus !== chronologicalRows[i - 1].dominantStatus) {
      regimeStartIndex = i;
    }

    // Bounded raw-row lookback ending at this row, matching INGEST_FETCH_ROWS
    // — the same raw-row budget driftService's live runDriftCheck() and
    // ingest-time computeFeaturesForNewRow() both fetch. Without this cap,
    // an unbounded backward scan for RUNNING rows (across e.g. an extended
    // STOPPED period) can find enough history to produce a driftZ value here
    // that the live dashboard / ingest-time computation could never have
    // produced for that same row, since they only ever see the last
    // INGEST_FETCH_ROWS raw rows. That mismatch is what made a backfill
    // re-run able to silently overwrite an already-correct ingest-time value
    // — this bound keeps computeHistoricalFeatures reproducible regardless
    // of how much unbounded history precedes row i.
    const rawWindowStart = Math.max(0, i - INGEST_FETCH_ROWS + 1);
    const rollingScopeStart = Math.max(rawWindowStart, regimeStartIndex);

    // Neither window depends on `metric` — slice/filter once per row and
    // reuse across all 6 metrics below, instead of repeating the same
    // slice+filter work 6 times over.
    const rollingRows = chronologicalRows.slice(rollingScopeStart, i + 1).slice(-ROLLING_WINDOW);
    const runningRows = chronologicalRows.slice(rawWindowStart, i + 1).filter((r) => r.dominantStatus === 'RUNNING');

    const featuresByMetric = {};
    for (const metric of METRICS) {
      const rollingWindow = rollingRows.map((r) => r[`${metric}Mean`]);
      const { rollingMean, rollingStd, rollingSlope } = rollingStats(rollingWindow);

      const runningSeries = runningRows.map((r) => r[`${metric}Mean`]);
      const drift = runningSeries.length >= MIN_RUNNING_ROWS_FOR_DRIFT ? classify(metric, runningSeries) : null;

      featuresByMetric[metric] = {
        rollingMean,
        rollingStd,
        rollingSlope,
        driftZ: drift ? drift.z : null,
        driftDirection: drift ? drift.direction : null,
      };
    }

    results.push({ id: row.id, historicalFeaturesByMetric: featuresByMetric });
  }

  return results;
}

/**
 * Compute historicalFeaturesByMetric for exactly ONE new row that has not
 * been inserted yet, given its own field values plus recent prior rows.
 * @param {object[]} recentRowsNewestFirst up to INGEST_FETCH_ROWS prior
 *   processed_telemetry rows, newest first (as returned by
 *   processedModel.getRecentProcessed).
 * @param {object} newRowData the not-yet-inserted record (must already have
 *   `${metric}Mean` and `dominantStatus` set).
 * @returns {object} historicalFeaturesByMetric for `newRowData` alone.
 */
export function computeFeaturesForNewRow(recentRowsNewestFirst, newRowData) {
  const chronological = recentRowsNewestFirst.slice().reverse();
  chronological.push(newRowData);
  const results = computeHistoricalFeatures(chronological);
  return results[results.length - 1].historicalFeaturesByMetric;
}
