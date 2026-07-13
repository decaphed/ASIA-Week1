// ─────────────────────────────────────────────────────────────────────────
// quality.js — data-quality assessment (Stage 7/8). Ported unchanged from
// node-red/flow.json's preprocess_minute: a weighted quality score where
// missing data hurts most (a gap can't be recovered), outliers are already
// contained by capping (lower weight), and physics violations are advisory
// (a FAULT episode can look "physically odd" without being a data-quality
// problem).
// ─────────────────────────────────────────────────────────────────────────

import { round2 } from './aggregation.js';

// Maps each exact violation string produced by validator.js::validatePhysics
// to a tally category. Hardcoded (not parsed/split) on purpose: if
// validator.js's wording ever changes, an unmatched string should fail
// loudly (see the "unmatched" bucket below) rather than silently
// miscounting. The two cross-variable rules get their own fixed categories
// instead of being attributed to either metric they compare — a mismatch
// between suction/discharge pressure, or between status and flow/rpm,
// implicates a relationship, not one sensor.
const VIOLATION_CATEGORY = {
  'flowRate out of range': 'flowRate',
  'rpm out of range': 'rpm',
  'vibration out of range': 'vibration',
  'suctionPressure out of range': 'suctionPressure',
  'dischargePressure out of range': 'dischargePressure',
  'motorTemp out of range': 'motorTemp',
  'dischargePressure must exceed suctionPressure': 'dischargePressureVsSuction',
  'STOPPED status but flow/rpm indicate the pump is running': 'statusMismatch',
};

const VIOLATION_CATEGORIES = [...new Set(Object.values(VIOLATION_CATEGORY))];

/**
 * Tally how many times each violation category occurred across a window.
 * A single sample can contribute to more than one category (e.g. an
 * out-of-range metric AND a cross-variable failure at once), so these
 * counts generally sum to MORE than physicsViolationCount, which counts
 * samples, not violations — that's expected, not a bug.
 *
 * @param {object[]} window completed AUDIT window.
 * @returns {Record<string, number>} one count per category, always present
 *   (0 if never violated), plus an `unmatched` bucket for any violation
 *   string that doesn't match VIOLATION_CATEGORY (should stay 0 unless
 *   validator.js's wording drifts out of sync with this map).
 */
function tallyViolationsByMetric(window) {
  const tally = Object.fromEntries(VIOLATION_CATEGORIES.map((category) => [category, 0]));
  tally.unmatched = 0;

  for (const sample of window) {
    if (!sample.physicsViolations) continue;
    for (const violation of sample.physicsViolations) {
      const category = VIOLATION_CATEGORY[violation];
      tally[category ?? 'unmatched'] += 1;
    }
  }

  return tally;
}

/**
 * @param {object} args
 * @param {object[]} args.window completed 60-sample AUDIT window (all samples, MEASURED + IMPUTED).
 * @param {number} args.missingCount from missing.js::detectMissing — RESIDUAL
 *   gaps only (ones too large to fill, see missing.js::MAX_FILLABLE_GAP_SECONDS).
 * @param {number} args.outlierCount total across all metrics, from outlier.js
 *   (evaluated only over the physics-valid subset — see pipeline.js).
 * @param {number} args.metricCount number of metrics.
 * @param {number} args.evaluatedSampleCount size of the physics-valid subset
 *   Hampel filtering actually ran over (outlierRate's denominator) — may be
 *   smaller than window.length when some samples failed validation.
 * @param {number} args.imputedSampleCount actual count of provenance==='IMPUTED'
 *   rows in `window` — an exact count now that gap-filling really happens,
 *   not an estimate.
 */
export function computeQuality({ window, missingCount, outlierCount, metricCount, evaluatedSampleCount, imputedSampleCount, physicsImputedCount = 0 }) {
  const n = window.length;
  const physicsViolationCount = window.filter((sample) => sample.physicsValid === false).length;
  const violationsByMetric = tallyViolationsByMetric(window);

  const missingRate = missingCount / (n + missingCount);
  const outlierRate = outlierCount / (evaluatedSampleCount * metricCount);
  const physicsPassRate = 1 - physicsViolationCount / n;
  const imputationRate = imputedSampleCount / n;
  const physicsImputationRate = physicsImputedCount / n;

  const qualityScore = round2(100 * (
    0.4 * (1 - missingRate) +
    0.3 * (1 - outlierRate) +
    0.3 * physicsPassRate
  ));
  const qualityLabel = qualityScore >= 90 ? 'GOOD' : qualityScore >= 70 ? 'FAIR' : 'POOR';

  return {
    physicsViolationCount,
    violationsByMetric,
    missingRate: round2(missingRate),
    outlierRate: round2(outlierRate),
    physicsPassRate: round2(physicsPassRate),
    qualityScore,
    qualityLabel,
    imputedSampleCount,
    imputationRate: round2(imputationRate),
    physicsImputedCount,
    physicsImputationRate: round2(physicsImputationRate),
    isImputed: imputedSampleCount > 0,
  };
}
