// ─────────────────────────────────────────────────────────────────────────
// pipeline.js — the single public entry point for the preprocessing
// pipeline: processSample(sample). This is what used to be entirely inside
// node-red/flow.json's preprocess_minute function node; POST /api/data is
// now where every stage of that pipeline actually runs.
//
// Workflow (matches the design spec 1:1):
//   1. Validate physics            -> validator.js
//   2. Annotate raw sample
//   3. Store raw sample            -> sensorService.saveReading
//   4. Add to rolling buffer       -> buffer.js
//   5. If <60 samples, stop
//   6. Detect missing data         -> missing.js
//   7. Hampel-filter outliers      -> outlier.js
//   8. Aggregate one-minute stats  -> aggregation.js
//   9. Calculate quality           -> quality.js
//  10. Store processed_telemetry   -> processedService.saveAndTrigger
//  11. Trigger forecastService     -> processedService.saveAndTrigger
//  12. Trigger driftService        -> processedService.saveAndTrigger
// ─────────────────────────────────────────────────────────────────────────

import { validatePhysics } from './validator.js';
import { pushSample, isWindowComplete, getWindow, resetBuffer, getLastSample, WINDOW_SIZE } from './buffer.js';
import { detectMissing, generateFillSamples, imputeInvalidRuns } from './missing.js';
import { hampelCap } from './outlier.js';
import { computePrecapFeatures } from './precapFeatures.js';
import { aggregateWindow } from './aggregation.js';
import { computeQuality } from './quality.js';
import { METRICS } from '../services/forecastService.js';
import * as sensorService from '../services/sensorService.js';
import * as processedService from '../services/processedService.js';
import { logger } from '../utils/logger.js';

/**
 * Validate, annotate, store, and buffer ONE sample (real or gap-filled),
 * closing out and processing a window if this push completes it.
 *
 * @param {object} rawSample metrics + status + timestamp.
 * @param {'MEASURED'|'IMPUTED'} provenance
 * @returns the saved reading (API shape).
 */
function ingestSample(rawSample, provenance) {
  // 1-2. Validate physics, annotate the sample — applies identically to
  // MEASURED and IMPUTED samples, so a reconstructed reading that turns out
  // physically implausible is just as visible as a real one would be.
  const { physicsValid, physicsViolations } = validatePhysics(rawSample);
  const annotated = { ...rawSample, provenance, physicsValid, physicsViolations };

  // 3. Store — every sample, unconditionally, real or reconstructed.
  const savedReading = sensorService.saveReading(annotated);

  // 4-5. Buffer; stop here until a full window has accumulated.
  pushSample(savedReading);
  if (!isWindowComplete()) {
    return savedReading;
  }

  const window = getWindow(); // full audit window — every sample, MEASURED or IMPUTED, physics-valid or not
  resetBuffer();

  // 6-12 run in their own try/catch: the sample above is already safely
  // stored, so a failure here (e.g. a downstream DB error) must not turn a
  // successful ingestion into a 500 for the caller, nor leave the window
  // half-processed — log and degrade the same way the all-invalid-window
  // case below already does.
  try {
    // 6. Missing-sample detection — now only ever finds RESIDUAL gaps (ones
    // too large to have been filled by generateFillSamples, see missing.js).
    const missingCount = detectMissing(window);
    const imputedSampleCount = window.filter((s) => s.provenance === 'IMPUTED').length;

    // Physics-invalid samples are still stored/counted (see quality.js).
    // validWindow itself is only used below to detect the all-invalid-window
    // case; for stats/forecast/trend, invalid runs get interpolated instead
    // of dropped (see statsWindow below), so they don't leave a hole.
    const validWindow = window.filter((s) => s.physicsValid !== false);

    // Total failure — every sample in the window failed validation (e.g. a
    // real, ongoing fault). There is no trustworthy data to aggregate from,
    // so skip this window entirely rather than reporting known-bad numbers
    // as if they were real: no processed_telemetry row is written, and
    // forecast/drift are not triggered. Raw samples were already stored
    // above, so the audit trail is intact; the dashboard's processed view
    // simply keeps showing the last good window until valid data resumes,
    // which is itself a visible signal (a stale processed timestamp) rather
    // than a silent one.
    if (validWindow.length === 0) {
      logger.warn(`Preprocessing: entire ${WINDOW_SIZE}-sample window failed physics validation (window ${window[0].timestamp} - ${window[window.length - 1].timestamp}) — skipping processed_telemetry for this window.`);
      return savedReading;
    }

    // Physics-invalid runs get interpolated (same math as a gap-fill) rather
    // than dropped, so a sensor glitch doesn't leave a hole or a step-change
    // in the series forecast/trend consume. The raw invalid values already
    // stored above are untouched; only this stats-facing copy is smoothed.
    const statsWindow = imputeInvalidRuns(window, METRICS);
    const physicsImputedCount = statsWindow.filter((s) => s.imputedForPhysics === true).length;

    // 7. Hampel-filter outliers, per metric — evaluated over statsWindow only.
    // Pre-cap features are captured from the SAME `raw` array, before
    // hampelCap smooths it, so the spike/rapid-change signal hampelCap
    // discards is preserved rather than lost.
    const cappedByMetric = {};
    const outliersByMetric = {};
    const precapFeaturesByMetric = {};
    let outlierCount = 0;
    for (const metric of METRICS) {
      const raw = statsWindow.map((s) => s[metric]);
      const { capped, outlierCount: metricOutliers } = hampelCap(raw, 3);
      cappedByMetric[metric] = capped;
      outliersByMetric[metric] = metricOutliers;
      outlierCount += metricOutliers;
      precapFeaturesByMetric[metric] = computePrecapFeatures(raw);
    }

    // 8. One-minute aggregation.
    const agg = aggregateWindow(window, statsWindow, cappedByMetric);

    // 9. Quality scoring.
    const quality = computeQuality({
      window,
      missingCount,
      outlierCount,
      metricCount: METRICS.length,
      evaluatedSampleCount: statsWindow.length,
      imputedSampleCount,
      physicsImputedCount,
    });

    const processedRecord = {
      windowStart: agg.windowStart,
      windowEnd: agg.windowEnd,
      timestamp: agg.windowEnd, // canonical timestamp = end of window
      dominantStatus: agg.dominantStatus,
      runningSeconds: agg.runningSeconds,
      faultSeconds: agg.faultSeconds,
      stoppedSeconds: agg.stoppedSeconds,
      sampleCount: agg.sampleCount,
      expectedSampleCount: WINDOW_SIZE,
      missingSampleCount: missingCount,
      imputedSampleCount: quality.imputedSampleCount,
      physicsImputedCount: quality.physicsImputedCount,
      outlierCount,
      outliersByMetric,
      precapFeaturesByMetric,
      physicsViolationCount: quality.physicsViolationCount,
      violationsByMetric: quality.violationsByMetric,
      missingRate: quality.missingRate,
      imputationRate: quality.imputationRate,
      physicsImputationRate: quality.physicsImputationRate,
      outlierRate: quality.outlierRate,
      physicsPassRate: quality.physicsPassRate,
      qualityScore: quality.qualityScore,
      qualityLabel: quality.qualityLabel,
      isImputed: quality.isImputed,
      preprocessingVersion: 'v1',
      preprocessingTimestamp: new Date().toISOString(),
    };

    for (const metric of METRICS) {
      processedRecord[`${metric}Mean`] = agg.stats[metric].mean;
      processedRecord[`${metric}Median`] = agg.stats[metric].median;
      processedRecord[`${metric}Min`] = agg.stats[metric].min;
      processedRecord[`${metric}Max`] = agg.stats[metric].max;
      processedRecord[`${metric}StdDev`] = agg.stats[metric].stdDev;
      processedRecord[`${metric}Last`] = agg.stats[metric].last;
    }

    // 10-12. Store processed_telemetry, then trigger forecast + drift.
    processedService.saveAndTrigger(processedRecord);
  } catch (err) {
    logger.error(`Preprocessing: failed to aggregate/store processed window (window ${window[0].timestamp} - ${window[window.length - 1].timestamp}): ${err.message}`);
  }

  return savedReading;
}

/**
 * Process one incoming raw telemetry sample: backfill any gap since the
 * last sample (up to missing.js::MAX_FILLABLE_GAP_SECONDS, via linear
 * interpolation), then validate/store/buffer the real sample itself — and
 * for each of those pushes, once every WINDOW_SIZE samples, aggregate +
 * store a processed record and trigger forecasting/drift detection.
 *
 * @param {object} sample raw sample as POSTed to /api/data.
 * @returns the saved raw reading for `sample` (same shape dataController has always returned) —
 *   any gap-fill rows created along the way are a side effect, not part of the response.
 */
export function processSample(sample) {
  // Chronology guard: everything downstream (gap-fill interpolation, window
  // start/end bounds, the "last" aggregate stat, Mann-Kendall/Theil-Sen row
  // ordering, drift's reference-vs-recent split) trusts arrival order to be
  // time order. A retried request or a client with a skewed clock would
  // silently corrupt all of it, so a sample whose timestamp is not strictly
  // after the last accepted one is rejected here — before it is stored or
  // buffered — rather than caught nowhere.
  const last = getLastSample();
  if (last?.timestamp && sample.timestamp) {
    const dtMs = Date.parse(sample.timestamp) - Date.parse(last.timestamp);
    if (Number.isFinite(dtMs) && dtMs <= 0) {
      const err = new Error(
        `timestamp must be after the last accepted reading (${last.timestamp}); received ${sample.timestamp}`,
      );
      err.status = 400;
      throw err;
    }
  }

  const fillSamples = generateFillSamples(getLastSample(), sample, METRICS);
  for (const fill of fillSamples) {
    ingestSample(fill, 'IMPUTED');
  }
  return ingestSample(sample, 'MEASURED');
}
