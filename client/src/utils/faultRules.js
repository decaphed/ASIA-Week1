// ─────────────────────────────────────────────────────────────────────────
// faultRules.js — shared parsing helpers for fault_events' JSON-string
// columns (triggeredRules, featureSnapshot). Used by both the queue list
// and the detail/review view so there's exactly one implementation of each.
// ─────────────────────────────────────────────────────────────────────────

/** Parse a fault_events row's triggeredRules JSON-string safely — a
 *  malformed value must never blank the page. */
export function parseTriggeredRules(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Malformed-but-valid-JSON entries (e.g. a number or object slipped
    // into the array) must never reach `.split('.')` at a call site.
    return parsed.filter((entry) => typeof entry === 'string');
  } catch {
    return [];
  }
}

/**
 * Parse a fault_events row's featureSnapshot JSON-string safely.
 * Shape: { precapFeaturesByMetric: { [metric]: { rawStdDev, rawRateOfChange,
 * rawMaxExcursion } }, metricStats: { [metric]: { mean, median, min, max,
 * stdDev, last } } }. Returns null on missing/malformed input rather than
 * throwing — callers must render a "Feature snapshot unreadable" fallback.
 */
export function parseFeatureSnapshot(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      precapFeaturesByMetric: parsed.precapFeaturesByMetric ?? {},
      metricStats: parsed.metricStats ?? {},
    };
  } catch {
    return null;
  }
}
