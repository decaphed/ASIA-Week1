// ─────────────────────────────────────────────────────────────────────────
// processedService.js — business logic for processed_telemetry.
//
// Mirrors sensorService.js's role for raw_telemetry: sits between the HTTP
// layer and the model, converts DB rows <-> the API shape. Unlike
// sensorService, there is no "fill in defaults" step — the preprocessing
// pipeline (preprocessing/pipeline.js) or validateProcessed.js already
// guarantees every field (stats, counters, quality score/label) is present
// and well-formed before this runs. Express only stores and re-shapes.
// ─────────────────────────────────────────────────────────────────────────

import * as model from '../models/processedModel.js';
import { onNewProcessedRecord as forecastOnNewRecord } from './forecastService.js';
import { onNewProcessedRecord as driftOnNewRecord } from './driftService.js';
import { onNewProcessedRecord as trendOnNewRecord } from './trendService.js';
import { computeFeaturesForNewRow, INGEST_FETCH_ROWS } from '../preprocessing/historicalFeatures.js';

const METRICS = ['flowRate', 'rpm', 'vibration', 'suctionPressure', 'dischargePressure', 'motorTemp'];

/** Convert a raw DB row into the nested object the API exposes. */
function rowToProcessed(row) {
  if (!row) return null;

  const metrics = {};
  for (const metric of METRICS) {
    metrics[metric] = {
      mean: row[`${metric}Mean`],
      median: row[`${metric}Median`],
      min: row[`${metric}Min`],
      max: row[`${metric}Max`],
      stdDev: row[`${metric}StdDev`],
      last: row[`${metric}Last`],
    };
  }

  return {
    id: row.id,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    timestamp: row.timestamp,
    metrics,
    dominantStatus: row.dominantStatus,
    dominantFaultType: row.dominantFaultType,
    runningSeconds: row.runningSeconds,
    faultSeconds: row.faultSeconds,
    stoppedSeconds: row.stoppedSeconds,
    sampleCount: row.sampleCount,
    // How many of sampleCount were genuine measurements, not derived from an
    // interpolated physics-invalid run — derived, not a stored column.
    // Physics-invalid runs are now interpolated INTO the aggregate stats
    // (see preprocessing/missing.js::imputeInvalidRuns) rather than excluded,
    // so sampleCount itself already reflects the full window; this just makes
    // visible how many of those samples were reconstructed rather than
    // measured. A window where every sample fails validation is skipped
    // entirely (no row is ever stored for it), so this is always accurate —
    // never the "all samples invalid" edge case.
    validSampleCount: row.sampleCount - row.physicsViolationCount,
    expectedSampleCount: row.expectedSampleCount,
    missingSampleCount: row.missingSampleCount,
    imputedSampleCount: row.imputedSampleCount,
    outlierCount: row.outlierCount,
    // Per-metric Hampel-capped outlier count (see preprocessing/pipeline.js).
    // Can be null for rows written before this column existed.
    outliersByMetric: row.outliersByMetric ? JSON.parse(row.outliersByMetric) : null,
    // Per-metric rawStdDev/rawRateOfChange/rawMaxExcursion computed BEFORE
    // Hampel capping (see preprocessing/precapFeatures.js). Can be null for
    // rows written before this column existed.
    precapFeaturesByMetric: row.precapFeaturesByMetric ? JSON.parse(row.precapFeaturesByMetric) : null,
    // Per-metric rollingMean/rollingStd/rollingSlope + driftZ/driftDirection,
    // computed causally as of this row (see
    // preprocessing/historicalFeatures.js). Can be null for rows written
    // before this column existed and not yet backfilled.
    historicalFeaturesByMetric: row.historicalFeaturesByMetric ? JSON.parse(row.historicalFeaturesByMetric) : null,
    physicsViolationCount: row.physicsViolationCount,
    // Per-metric + cross-variable tally (see preprocessing/quality.js). Can
    // be null for rows written before this column existed.
    violationsByMetric: row.violationsByMetric ? JSON.parse(row.violationsByMetric) : null,
    // Physics-invalid samples that were interpolated into the stats window
    // (see preprocessing/missing.js::imputeInvalidRuns) rather than dropped.
    physicsImputedCount: row.physicsImputedCount,
    missingRate: row.missingRate,
    imputationRate: row.imputationRate,
    outlierRate: row.outlierRate,
    physicsPassRate: row.physicsPassRate,
    physicsImputationRate: row.physicsImputationRate,
    qualityScore: row.qualityScore,
    qualityLabel: row.qualityLabel,
    isImputed: !!row.isImputed,
    // Event-time windowing / classifier counters (observational, not part of
    // qualityScore — see preprocessing/quality.js). Can be undefined for
    // rows written before these columns existed.
    lateSampleCount: row.lateSampleCount,
    mergedSampleCount: row.mergedSampleCount,
    duplicateSampleCount: row.duplicateSampleCount,
    partiallyImputedCount: row.partiallyImputedCount,
    partiallyImputedRate: row.partiallyImputedRate,
    abnormalOperationSampleCount: row.abnormalOperationSampleCount,
    preprocessingVersion: row.preprocessingVersion,
    preprocessingTimestamp: row.preprocessingTimestamp,
  };
}

/** Persist one incoming one-minute aggregate. `data` was already validated. */
export function saveProcessedReading(data) {
  // Computed here, before insert, from data's own (not-yet-stored) metric
  // means/dominantStatus plus recent prior rows — see
  // preprocessing/historicalFeatures.js for why this can't be derived later
  // from forecastService/driftService, which only hold live in-memory state.
  const recentRows = model.getRecentProcessed(INGEST_FETCH_ROWS);
  const historicalFeaturesByMetric = computeFeaturesForNewRow(recentRows, data);

  const record = {
    ...data,
    isImputed: data.isImputed ? 1 : 0,
    // ?? {} guards the manual POST /api/processed path, which doesn't
    // require these fields — stringifying undefined would otherwise store
    // the literal string "undefined" instead of a valid JSON object.
    outliersByMetric: JSON.stringify(data.outliersByMetric ?? {}),
    violationsByMetric: JSON.stringify(data.violationsByMetric ?? {}),
    precapFeaturesByMetric: JSON.stringify(data.precapFeaturesByMetric ?? {}),
    historicalFeaturesByMetric: JSON.stringify(historicalFeaturesByMetric),
  };
  const info = model.insertProcessed(record);
  return rowToProcessed({ id: Number(info.lastInsertRowid), ...record });
}

/**
 * Persist a processed record and immediately notify forecasting/drift/trend
 * detection — the single place that sequence happens, shared by the
 * preprocessing pipeline (preprocessing/pipeline.js) and the manual/back-
 * compat POST /api/processed endpoint (processedController.js), so the
 * four-step "save, forecast, drift, trend" sequence exists in exactly one
 * place.
 */
export function saveAndTrigger(data) {
  const record = saveProcessedReading(data);
  forecastOnNewRecord(data);
  driftOnNewRecord(data);
  trendOnNewRecord(data);
  return record;
}

/** The most recent processed record, or null if none stored yet. */
export function getLatestProcessedReading() {
  return rowToProcessed(model.getLatestProcessed());
}

/** A page of processed history plus pagination metadata (mirrors sensorService). */
export function getProcessedHistoryPage({ page, limit, sort }) {
  const offset = (page - 1) * limit;
  const rows = model.getProcessedHistory({ limit, offset, sort });
  const total = model.getProcessedCount();

  return {
    page,
    limit,
    sort,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    count: rows.length,
    data: rows.map(rowToProcessed),
  };
}
