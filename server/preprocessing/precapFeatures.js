// ─────────────────────────────────────────────────────────────────────────
// precapFeatures.js — pre-cap feature capture (Stage 7, run alongside
// hampelCap). hampelCap's whole job is to smooth away exactly the kind of
// spike/rapid-change signal that would precede a real pump fault — useful
// for clean aggregate stats, but it means that signal never reaches
// processed_telemetry at all. This module computes a few small descriptive
// stats over the SAME raw (pre-cap) per-metric array hampelCap consumes,
// so that signal is preserved as its own derived feature set instead of
// being discarded. Pure function: no DB, no Express, mirrors
// aggregation.js's round2()/variance conventions exactly.
// ─────────────────────────────────────────────────────────────────────────

import { round2 } from './aggregation.js';

/**
 * @param {number[]} values one metric's RAW values across the window,
 *   BEFORE hampelCap — i.e. the same `raw` array pipeline.js builds via
 *   `statsWindow.map((s) => s[metric])` right before calling hampelCap.
 * @returns {{ rawStdDev: number, rawRateOfChange: number, rawMaxExcursion: number }}
 *   rawStdDev — population standard deviation of `values` (same
 *     mean/variance/sqrt math as aggregation.js's per-metric stdDev, just
 *     computed on the uncapped series instead of the capped one).
 *   rawRateOfChange — mean of the absolute tick-to-tick differences across
 *     `values`, i.e. how fast the metric was moving before any capping.
 *   rawMaxExcursion — the largest absolute deviation of any single raw
 *     sample from `values`' own median, i.e. a spike's true size even
 *     though hampelCap would have flattened it to the median.
 */
export function computePrecapFeatures(values) {
  const n = values.length;

  const meanVal = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - meanVal) ** 2, 0) / n;
  const rawStdDev = round2(Math.sqrt(variance));

  let diffSum = 0;
  for (let i = 1; i < n; i++) {
    diffSum += Math.abs(values[i] - values[i - 1]);
  }
  const rawRateOfChange = round2(n > 1 ? diffSum / (n - 1) : 0);

  const sorted = values.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const rawMaxExcursion = round2(Math.max(...values.map((v) => Math.abs(v - median))));

  return { rawStdDev, rawRateOfChange, rawMaxExcursion };
}
