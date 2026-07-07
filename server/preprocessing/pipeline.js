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
import { pushSample, isWindowComplete, getWindow, resetBuffer, WINDOW_SIZE } from './buffer.js';
import { detectMissing } from './missing.js';
import { hampelCap } from './outlier.js';
import { aggregateWindow } from './aggregation.js';
import { computeQuality } from './quality.js';
import { METRICS } from '../services/forecastService.js';
import * as sensorService from '../services/sensorService.js';
import * as processedService from '../services/processedService.js';
import { logger } from '../utils/logger.js';

/**
 * Process one incoming raw telemetry sample: validate, store, buffer, and —
 * once every WINDOW_SIZE samples — aggregate + store a processed record and
 * trigger forecasting/drift detection.
 *
 * @param {object} sample raw sample as POSTed to /api/data.
 * @returns the saved raw reading (same shape dataController has always returned).
 */
export function processSample(sample) {
  // 1-2. Validate physics, annotate the raw sample.
  const { physicsValid, physicsViolations } = validatePhysics(sample);
  const annotated = {
    ...sample,
    isSynthetic: true,
    physicsValid,
    physicsViolations,
  };

  // 3. Store the raw sample — every tick, unconditionally.
  const savedReading = sensorService.saveReading(annotated);

  // 4-5. Buffer; stop here until a full window has accumulated.
  pushSample(annotated);
  if (!isWindowComplete()) {
    return savedReading;
  }

  const window = getWindow(); // full audit window — every sample, physics-valid or not
  resetBuffer();

  // 6. Missing-sample detection — always over the full audit window.
  const missingCount = detectMissing(window);

  // Physics-invalid samples are still stored/counted (see quality.js) but
  // must not influence the Hampel baseline, aggregate stats, forecasting,
  // drift, or the dashboard.
  const validWindow = window.filter((s) => s.physicsValid !== false);

  // Total failure — every sample in the window failed validation (e.g. a
  // real, ongoing fault). There is no trustworthy data to aggregate from, so
  // skip this window entirely rather than reporting known-bad numbers as if
  // they were real: no processed_telemetry row is written, and forecast/
  // drift are not triggered. Raw samples were already stored above, so the
  // audit trail is intact; the dashboard's processed view simply keeps
  // showing the last good window until valid data resumes, which is itself
  // a visible signal (a stale processed timestamp) rather than a silent one.
  if (validWindow.length === 0) {
    logger.warn(`Preprocessing: entire ${WINDOW_SIZE}-sample window failed physics validation (window ${window[0].timestamp} - ${window[window.length - 1].timestamp}) — skipping processed_telemetry for this window.`);
    return savedReading;
  }

  const statsWindow = validWindow;

  // 7. Hampel-filter outliers, per metric — evaluated over statsWindow only.
  const cappedByMetric = {};
  let outlierCount = 0;
  for (const metric of METRICS) {
    const raw = statsWindow.map((s) => s[metric]);
    const { capped, outlierCount: metricOutliers } = hampelCap(raw, 3);
    cappedByMetric[metric] = capped;
    outlierCount += metricOutliers;
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
    outlierCount,
    physicsViolationCount: quality.physicsViolationCount,
    missingRate: quality.missingRate,
    imputationRate: quality.imputationRate,
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

  return savedReading;
}
