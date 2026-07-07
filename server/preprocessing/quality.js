// ─────────────────────────────────────────────────────────────────────────
// quality.js — data-quality assessment (Stage 7/8). Ported unchanged from
// node-red/flow.json's preprocess_minute: a weighted quality score where
// missing data hurts most (a gap can't be recovered), outliers are already
// contained by capping (lower weight), and physics violations are advisory
// (a FAULT episode can look "physically odd" without being a data-quality
// problem).
// ─────────────────────────────────────────────────────────────────────────

import { round2 } from './aggregation.js';

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
export function computeQuality({ window, missingCount, outlierCount, metricCount, evaluatedSampleCount, imputedSampleCount }) {
  const n = window.length;
  const physicsViolationCount = window.filter((sample) => sample.physicsValid === false).length;

  const missingRate = missingCount / (n + missingCount);
  const outlierRate = outlierCount / (evaluatedSampleCount * metricCount);
  const physicsPassRate = 1 - physicsViolationCount / n;
  const imputationRate = imputedSampleCount / n;

  const qualityScore = round2(100 * (
    0.4 * (1 - missingRate) +
    0.3 * (1 - outlierRate) +
    0.3 * physicsPassRate
  ));
  const qualityLabel = qualityScore >= 90 ? 'GOOD' : qualityScore >= 70 ? 'FAIR' : 'POOR';

  return {
    physicsViolationCount,
    missingRate: round2(missingRate),
    outlierRate: round2(outlierRate),
    physicsPassRate: round2(physicsPassRate),
    qualityScore,
    qualityLabel,
    imputedSampleCount,
    imputationRate: round2(imputationRate),
    isImputed: imputedSampleCount > 0,
  };
}
