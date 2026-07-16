// ─────────────────────────────────────────────────────────────────────────
// pipeline.js — the single public entry point for the preprocessing
// pipeline: processSample(sample).
//
// Workflow:
//   1. Classify the incoming sample's timestamp -> buffer.js::classify()
//      (ACCEPTED | DUPLICATE | MERGED | REJECTED_STALE)
//   2. Validate physics (with transition context) -> validator.js
//   3. Store raw sample, tagged with its classification -> sensorService.saveReading
//   4. DUPLICATE/REJECTED_STALE stop here — stored for audit, never buffered.
//   5. ACCEPTED/MERGED: gap-fill against the true last accepted sample,
//      commit into the event-time-windowed buffer -> buffer.js
//   6. Any window(s) that just closed (0, 1, or several on a multi-boundary
//      jump) get fully processed: missing-data detection, physics-invalid
//      run classification/repair, Hampel-filtered outlier capping,
//      one-minute aggregation, quality scoring, persistence, and
//      forecast/drift/trend triggers.
//
// A background sweep (see runBackgroundSweep(), wired into server.js) force-
// closes any window whose event-time boundary has passed even with no new
// sample arriving, since ingestion is otherwise entirely push-driven.
// ─────────────────────────────────────────────────────────────────────────

import { validatePhysics } from './validator.js';
import { classify, commit, getLastSample, getRecentTail, closeExpiredWindows } from './buffer.js';
import { detectMissing, generateFillSamples, imputeInvalidRuns } from './missing.js';
import { hampelCap } from './outlier.js';
import { computePrecapFeatures } from './precapFeatures.js';
import { aggregateWindow } from './aggregation.js';
import { computeQuality } from './quality.js';
import { EXPECTED_SAMPLE_COUNT } from './config.js';
import { METRICS } from '../services/forecastService.js';
import * as sensorService from '../services/sensorService.js';
import * as processedService from '../services/processedService.js';
import { logger } from '../utils/logger.js';
import { validateFillRow } from '../utils/validation.js';

/**
 * Fully process one closed window: missing-data detection, classifier-gated
 * physics-invalid-run repair, Hampel-filtered outlier capping (exempting
 * abnormal-operation samples), aggregation, quality scoring, persistence,
 * and forecast/drift/trend triggers.
 *
 * Runs in its own try/catch: every sample in the window is already safely
 * stored in raw_telemetry by the time this runs, so a failure here (e.g. a
 * downstream DB error, or the aggregation invariant-violation throw) must
 * not lose the raw audit trail — it's logged and the window is skipped.
 */
function processClosedWindow(win) {
  const window = win.samples;
  if (window.length === 0) return;

  try {
    const missingCount = detectMissing(win);
    const imputedSampleCount = window.filter((s) => s.provenance === 'IMPUTED').length;
    const partiallyImputedCount = window.filter((s) => Array.isArray(s.unfilledMetrics) && s.unfilledMetrics.length > 0).length;
    const mergedSampleCount = win.mergedSampleCount || 0;
    const lateSampleCount = mergedSampleCount; // MERGED covers both late and out-of-order reinsertion under the trimmed 4-way classification.
    const duplicateSampleCount = win.duplicateCount || 0;

    // Physics-invalid samples are still stored/counted (see quality.js).
    // validWindow itself is only used below to detect the all-invalid-window
    // case; for stats/forecast/trend, invalid runs get classified and either
    // repaired (SENSOR_FAULT) or preserved (NOT_SENSOR_FAULT) instead of
    // dropped (see statsWindow below), so they don't leave a hole.
    const validWindow = window.filter((s) => s.physicsValid !== false);

    if (validWindow.length === 0) {
      logger.warn(`Preprocessing: entire window failed physics validation (window ${win.windowStart} - ${win.windowEnd}) — skipping processed_telemetry for this window.`);
      return;
    }

    const statsWindow = imputeInvalidRuns(window, METRICS, getRecentTail());
    const physicsImputedCount = statsWindow.filter((s) => s.imputedForPhysics === true).length;
    const abnormalOperationSampleCount = statsWindow.filter((s) => s.abnormalOperation === true).length;

    // Hampel-filter outliers, per metric — evaluated over statsWindow only,
    // with abnormal-operation samples exempted from both being capped AND
    // from polluting a neighbor's median/MAD baseline (see outlier.js).
    const excludeMask = statsWindow.map((s) => s.abnormalOperation === true);

    const cappedByMetric = {};
    const outliersByMetric = {};
    const precapFeaturesByMetric = {};
    let outlierCount = 0;
    for (const metric of METRICS) {
      const raw = statsWindow.map((s) => s[metric]);
      const { capped, outlierCount: metricOutliers } = hampelCap(raw, 3, excludeMask);
      cappedByMetric[metric] = capped;
      outliersByMetric[metric] = metricOutliers;
      outlierCount += metricOutliers;
      precapFeaturesByMetric[metric] = computePrecapFeatures(raw);
    }

    const agg = aggregateWindow(window, statsWindow, cappedByMetric);

    const quality = computeQuality({
      window,
      missingCount,
      outlierCount,
      metricCount: METRICS.length,
      evaluatedSampleCount: statsWindow.length,
      imputedSampleCount,
      physicsImputedCount,
      lateSampleCount,
      mergedSampleCount,
      duplicateSampleCount,
      partiallyImputedCount,
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
      expectedSampleCount: EXPECTED_SAMPLE_COUNT,
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
      lateSampleCount: quality.lateSampleCount,
      mergedSampleCount: quality.mergedSampleCount,
      duplicateSampleCount: quality.duplicateSampleCount,
      partiallyImputedCount: quality.partiallyImputedCount,
      partiallyImputedRate: quality.partiallyImputedRate,
      abnormalOperationSampleCount,
      preprocessingVersion: 'v2',
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

    processedService.saveAndTrigger(processedRecord);
  } catch (err) {
    logger.error(`Preprocessing: failed to aggregate/store processed window (window ${win.windowStart} - ${win.windowEnd}): ${err.message}`);
  }
}

/**
 * Validate, annotate, store, and (for ACCEPTED/MERGED only) buffer ONE
 * sample, processing any window(s) that close as a result.
 *
 * @param {object} rawSample metrics + status + timestamp.
 * @param {'MEASURED'|'IMPUTED'} provenance
 * @param {'ACCEPTED'|'DUPLICATE'|'MERGED'|'REJECTED_STALE'} classification
 * @returns the saved reading (API shape).
 */
function ingestSample(rawSample, provenance, classification) {
  const prevSample = getLastSample();
  const dtSec = prevSample ? (Date.parse(rawSample.timestamp) - Date.parse(prevSample.timestamp)) / 1000 : null;

  const { physicsValid, physicsViolations } = validatePhysics(rawSample, { prevSample, dtSec });
  const annotated = { ...rawSample, provenance, physicsValid, physicsViolations };

  if (provenance === 'IMPUTED') {
    const fillErrors = validateFillRow(annotated);
    if (fillErrors.length) {
      logger.warn(`Preprocessing: internally-generated fill row failed validation, storing anyway for audit: ${fillErrors.join('; ')}`);
    }
  }

  // Store every sample, unconditionally, real or reconstructed — including
  // DUPLICATE/REJECTED_STALE, so raw_telemetry keeps a complete audit trail
  // even for samples that never enter a window.
  const savedReading = sensorService.saveReading(annotated);

  if (classification === 'DUPLICATE' || classification === 'REJECTED_STALE') {
    return savedReading;
  }

  const closedWindows = commit(savedReading, classification);
  for (const win of closedWindows) {
    processClosedWindow(win);
  }
  return savedReading;
}

/**
 * Process one incoming raw telemetry sample: classify it against the
 * event-time windowed buffer, backfill any gap since the last accepted
 * sample (per-metric ceilings, via linear interpolation — see missing.js),
 * then validate/store/buffer the real sample itself.
 *
 * @param {object} sample raw sample as POSTed to /api/data.
 * @returns the saved raw reading for `sample` (same shape dataController has
 *   always returned), plus `accepted`/`reason`/`duplicate` flags for
 *   DUPLICATE/REJECTED_STALE outcomes — these are business-logic outcomes
 *   ("received and understood, but not used"), not protocol errors, so they
 *   no longer throw an HTTP 400 the way a reordered timestamp used to.
 */
export function processSample(sample) {
  const tsMs = Date.parse(sample.timestamp);
  const classification = classify(tsMs);

  if (classification === 'REJECTED_STALE') {
    const savedReading = ingestSample(sample, 'MEASURED', classification);
    return { ...savedReading, accepted: false, reason: 'STALE' };
  }
  if (classification === 'DUPLICATE') {
    const savedReading = ingestSample(sample, 'MEASURED', classification);
    return { ...savedReading, accepted: true, duplicate: true };
  }

  // ACCEPTED / MERGED: gap-fill against the true last accepted/merged
  // sample, then store the real sample itself.
  const fillSamples = generateFillSamples(getLastSample(), sample, METRICS);
  for (const fill of fillSamples) {
    const fillClassification = classify(Date.parse(fill.timestamp));
    ingestSample(fill, 'IMPUTED', fillClassification);
  }
  return ingestSample(sample, 'MEASURED', classification);
}

/**
 * Force-close and process any window whose event-time boundary has passed,
 * even with no new sample arriving — called on a wall-clock interval from
 * server.js, since ingestion is otherwise entirely push-driven and a fully
 * silent stream would otherwise never close its last window.
 */
export function runBackgroundSweep() {
  const closedWindows = closeExpiredWindows(Date.now());
  for (const win of closedWindows) {
    processClosedWindow(win);
  }
}
