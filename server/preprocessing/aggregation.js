// ─────────────────────────────────────────────────────────────────────────
// aggregation.js — one-minute aggregation (Stage 5/6). Per metric:
// mean/median/min/max (from the outlier-capped, physics-VALID series) plus
// "last" (the true, uncapped final valid value of the window — the real
// instantaneous state). Also derives the operating-status breakdown
// (dominantStatus + per-status seconds), which uses the FULL audit window —
// status classification isn't a physics-validity concern.
//
// physicsInvalid samples are still stored in raw_telemetry and still count
// toward physicsViolationCount/physicsPassRate (quality.js) — a broken
// sensor should still be visible for alarming — but they must not pull the
// numbers that feed forecasting, drift detection, or the dashboard. The
// caller (pipeline.js) is responsible for excluding them before computing
// cappedByMetric, so the Hampel median/MAD baseline itself is never
// contaminated by invalid readings either. pipeline.js also guarantees
// statsWindow is never empty — a window where every sample failed
// validation is skipped entirely before this function is ever called.
//
// METRICS is imported from forecastService (the existing single source of
// truth for the 6-metric list, already relied on by driftService) instead of
// being redefined a third time here.
// ─────────────────────────────────────────────────────────────────────────

import { METRICS } from '../services/forecastService.js';

export function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * @param {object[]} window the full completed 60-sample audit window (every
 *   sample that arrived, physics-valid or not), in arrival order.
 * @param {object[]} statsWindow the physics-valid subset of `window` (never
 *   empty — see pipeline.js) — what cappedByMetric was computed from.
 * @param {Record<string, number[]>} cappedByMetric outlier-capped series per
 *   metric, aligned with `statsWindow`.
 * @returns aggregate stats, status breakdown, sample count, and window bounds.
 */
export function aggregateWindow(window, statsWindow, cappedByMetric) {
  const stats = {};

  for (const metric of METRICS) {
    const raw = statsWindow.map((sample) => sample[metric]);
    const capped = cappedByMetric[metric];
    const n = capped.length;

    const meanVal = capped.reduce((a, b) => a + b, 0) / n;
    const sortedCapped = capped.slice().sort((a, b) => a - b);
    const medianVal = sortedCapped[Math.floor(n / 2)];
    const variance = capped.reduce((a, b) => a + (b - meanVal) ** 2, 0) / n;

    stats[metric] = {
      mean: round2(meanVal),
      median: round2(medianVal),
      min: Math.min(...capped),
      max: Math.max(...capped),
      stdDev: round2(Math.sqrt(variance)),
      last: raw[raw.length - 1],
    };
  }

  // Status classification uses the FULL audit window — a physics violation
  // doesn't invalidate what the sensor reported its own status as.
  const statusCounts = { RUNNING: 0, FAULT: 0, STOPPED: 0 };
  for (const sample of window) {
    statusCounts[sample.status] = (statusCounts[sample.status] || 0) + 1;
  }
  const dominantStatus = Object.keys(statusCounts).sort((a, b) => statusCounts[b] - statusCounts[a])[0];

  return {
    stats,
    dominantStatus,
    runningSeconds: statusCounts.RUNNING,
    faultSeconds: statusCounts.FAULT,
    stoppedSeconds: statusCounts.STOPPED,
    sampleCount: window.length,
    windowStart: window[0].timestamp,
    windowEnd: window[window.length - 1].timestamp,
  };
}
