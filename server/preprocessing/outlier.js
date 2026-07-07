// ─────────────────────────────────────────────────────────────────────────
// outlier.js — Hampel-filter outlier detection (Stage 4). Ported unchanged
// from node-red/flow.json's preprocess_minute: median + MAD (median absolute
// deviation), scaled by 1.4826 to be a consistent estimator of standard
// deviation under normality. Outliers are CAPPED to the median, never
// deleted — the true raw value stays in raw_telemetry regardless, so
// nothing is lost; only the aggregate is protected from a single spurious
// spike.
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {number[]} values one metric's raw values across the window.
 * @param {number} [k] outlier threshold in MAD units.
 * @returns {{ capped: number[], outlierCount: number }}
 */
export function hampelCap(values, k = 3) {
  const sorted = values.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  const absDev = values.map((v) => Math.abs(v - median));
  const madSorted = absDev.slice().sort((a, b) => a - b);
  const mad = 1.4826 * madSorted[Math.floor(madSorted.length / 2)];

  let outlierCount = 0;
  const capped = values.map((v) => {
    if (mad > 0 && Math.abs(v - median) > k * mad) {
      outlierCount++;
      return median;
    }
    return v;
  });

  return { capped, outlierCount };
}
