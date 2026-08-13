// ─────────────────────────────────────────────────────────────────────────
// run_js_pipeline.mjs — golden-value parity suite's JS reference harness
// (docs/plan/2026-08-05-pdm-implementation.md §11.6.5).
//
// pipeline.js's own exported entry points (processSample/runBackgroundSweep)
// require a live Postgres connection (sensorService.saveReading/
// processedService.saveAndTrigger, wrapped in withLock()) — this parity
// suite must run without a database. This script reproduces pipeline.js's
// PURE computation orchestration (ingestSample's per-sample gap-fill +
// physics-validate loop, and processClosedWindow's missing/impute/outlier/
// aggregate/precap/quality stage sequence) with the DB-writing lines
// removed, calling the exact same preprocessing modules pipeline.js calls.
//
// This is NOT a copy meant to diverge from pipeline.js — if pipeline.js's
// orchestration logic ever changes, this file must be updated to match, or
// the parity suite silently stops testing what's actually live. Read
// server/preprocessing/pipeline.js side-by-side with this file before
// trusting a parity-suite pass after any change to either.
//
// Usage: node run_js_pipeline.mjs < fixture.json
//   Input:  JSON array of raw samples (the same shape POST /api/data
//           accepts), in timestamp order, no prevSample (see
//           tests/parity/fixtures.py's module docstring for why).
//   Output: {"processedRecords": [...]} on stdout — one entry per window
//           that closed while processing the input, in close order.
// ─────────────────────────────────────────────────────────────────────────

import { validatePhysics } from '../../preprocessing/validator.js';
import {
  classify, commit, getLastSample, getRecentTail, resetAll, closeExpiredWindows,
} from '../../preprocessing/buffer.js';
import { detectMissing, generateFillSamples, imputeInvalidRuns } from '../../preprocessing/missing.js';
import { hampelCap } from '../../preprocessing/outlier.js';
import { computePrecapFeatures } from '../../preprocessing/precapFeatures.js';
import { aggregateWindow } from '../../preprocessing/aggregation.js';
import { computeQuality } from '../../preprocessing/quality.js';
import { EXPECTED_SAMPLE_COUNT } from '../../preprocessing/config.js';
import { METRICS } from '../../services/forecastService.js';

// Mirrors pipeline.js::processClosedWindow exactly, minus the final
// `await processedService.saveAndTrigger(processedRecord)` DB write —
// returns the processedRecord instead of persisting it.
function buildProcessedRecord(win) {
  const window = win.samples;
  if (window.length === 0) return null;

  const missingCount = detectMissing(win);
  const imputedSampleCount = window.filter((s) => s.provenance === 'IMPUTED').length;
  const partiallyImputedCount = window.filter(
    (s) => Array.isArray(s.unfilledMetrics) && s.unfilledMetrics.length > 0,
  ).length;
  const mergedSampleCount = win.mergedSampleCount || 0;
  const lateSampleCount = mergedSampleCount;
  const duplicateSampleCount = win.duplicateCount || 0;

  const validWindow = window.filter((s) => s.physicsValid !== false);
  if (validWindow.length === 0) return null;

  const statsWindow = imputeInvalidRuns(window, METRICS, getRecentTail());
  const physicsImputedCount = statsWindow.filter((s) => s.imputedForPhysics === true).length;
  const abnormalOperationSampleCount = statsWindow.filter((s) => s.abnormalOperation === true).length;
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
    timestamp: agg.windowEnd,
    dominantStatus: agg.dominantStatus,
    dominantFaultType: agg.dominantFaultType,
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

  return processedRecord;
}

// Mirrors pipeline.js::ingestSample, minus `await sensorService.saveReading()`.
function ingestSample(rawSample, provenance, classification, prevSample) {
  const dtSec = prevSample ? (Date.parse(rawSample.timestamp) - Date.parse(prevSample.timestamp)) / 1000 : null;
  const { physicsValid, physicsViolations } = validatePhysics(rawSample, { prevSample, dtSec });
  const annotated = { ...rawSample, provenance, physicsValid, physicsViolations };

  if (classification === 'DUPLICATE' || classification === 'REJECTED_STALE') {
    return [];
  }
  return commit(annotated, classification);
}

// Mirrors pipeline.js::processSampleLocked exactly.
function processSampleLocked(sample) {
  const tsMs = Date.parse(sample.timestamp);
  const classification = classify(tsMs);
  const closedWindowsOut = [];

  if (classification === 'REJECTED_STALE' || classification === 'DUPLICATE') {
    closedWindowsOut.push(...ingestSample(sample, 'MEASURED', classification, getLastSample()));
    return closedWindowsOut;
  }

  const fillSamples = generateFillSamples(getLastSample(), sample, METRICS);
  for (const fill of fillSamples) {
    const fillClassification = classify(Date.parse(fill.timestamp));
    closedWindowsOut.push(...ingestSample(fill, 'IMPUTED', fillClassification, getLastSample()));
  }
  closedWindowsOut.push(...ingestSample(sample, 'MEASURED', classification, getLastSample()));
  return closedWindowsOut;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const samples = Array.isArray(input) ? input : input.samples;

  resetAll();
  const allClosedWindows = [];
  for (const sample of samples) {
    allClosedWindows.push(...processSampleLocked(sample));
  }
  // Force-close any window still open at the end — mirrors
  // runBackgroundSweep()'s role in the live system for a fixture that ends
  // mid-window rather than being followed by a next-window sample.
  const forceCloseAtMs = input.forceCloseAtMs
    ?? Date.parse(samples[samples.length - 1].timestamp) + 60_000;
  allClosedWindows.push(...closeExpiredWindows(forceCloseAtMs));

  const processedRecords = allClosedWindows.map(buildProcessedRecord).filter((r) => r !== null);
  process.stdout.write(JSON.stringify({ processedRecords }));
}

main().catch((err) => {
  process.stderr.write(`run_js_pipeline.mjs error: ${err.stack || err.message}\n`);
  process.exit(1);
});
