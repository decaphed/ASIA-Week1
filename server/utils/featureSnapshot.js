// ─────────────────────────────────────────────────────────────────────────
// featureSnapshot.js — the fixed §3.3 featureSnapshot composition (full
// precapFeaturesByMetric + full per-metric metricStats, all six metrics,
// never a per-metric subset), shared by faultEventService.js (Tier 1
// flags, negative samples, manual-buffer entries) and
// corpusMaterializationService.js (§10.5's corpus rows) — extracted to its
// own module specifically so corpusMaterializationService.js doesn't have
// to import it from faultEventService.js, which would create a circular
// import once faultEventService.js calls back into
// corpusMaterializationService.js on confirm/reject.
// ─────────────────────────────────────────────────────────────────────────

import { METRICS } from '../services/forecastService.js';

/** Full per-metric mean/median/min/max/stdDev/last off the flat processedRecord shape. */
export function buildMetricStats(data) {
  const metricStats = {};
  for (const metric of METRICS) {
    metricStats[metric] = {
      mean: data[`${metric}Mean`],
      median: data[`${metric}Median`],
      min: data[`${metric}Min`],
      max: data[`${metric}Max`],
      stdDev: data[`${metric}StdDev`],
      last: data[`${metric}Last`],
    };
  }
  return metricStats;
}

// §3.3: fixed, eventType-independent composition — full precapFeaturesByMetric
// (all six metrics) + full per-metric metricStats, never a per-metric subset.
export function buildFeatureSnapshot(data) {
  return JSON.stringify({
    precapFeaturesByMetric: data.precapFeaturesByMetric ?? {},
    metricStats: buildMetricStats(data),
  });
}
