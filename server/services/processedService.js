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
import { onNewProcessedRecord as pdmOnNewRecord } from './pdmService.js';
import { computeFeaturesForNewRow, INGEST_FETCH_ROWS } from '../preprocessing/historicalFeatures.js';
import { logger } from '../utils/logger.js';

const METRICS = ['flowRate', 'rpm', 'vibration', 'suctionPressure', 'dischargePressure', 'motorTemp'];

/**
 * Convert a raw DB row into the nested object the API exposes.
 *
 * outliersByMetric/violationsByMetric/precapFeaturesByMetric/
 * historicalFeaturesByMetric are already parsed objects (Postgres JSONB) —
 * no JSON.parse step needed. isImputed is already a real boolean.
 */
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
    validSampleCount: row.sampleCount - row.physicsViolationCount,
    expectedSampleCount: row.expectedSampleCount,
    missingSampleCount: row.missingSampleCount,
    imputedSampleCount: row.imputedSampleCount,
    outlierCount: row.outlierCount,
    outliersByMetric: row.outliersByMetric ?? null,
    precapFeaturesByMetric: row.precapFeaturesByMetric ?? null,
    historicalFeaturesByMetric: row.historicalFeaturesByMetric ?? null,
    physicsViolationCount: row.physicsViolationCount,
    violationsByMetric: row.violationsByMetric ?? null,
    physicsImputedCount: row.physicsImputedCount,
    missingRate: row.missingRate,
    imputationRate: row.imputationRate,
    outlierRate: row.outlierRate,
    physicsPassRate: row.physicsPassRate,
    physicsImputationRate: row.physicsImputationRate,
    qualityScore: row.qualityScore,
    qualityLabel: row.qualityLabel,
    isImputed: row.isImputed,
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
export async function saveProcessedReading(data) {
  // Computed here, before insert, from data's own (not-yet-stored) metric
  // means/dominantStatus plus recent prior rows — see
  // preprocessing/historicalFeatures.js for why this can't be derived later
  // from forecastService/driftService, which only hold live in-memory state.
  const recentRows = await model.getRecentProcessed(INGEST_FETCH_ROWS);
  const historicalFeaturesByMetric = computeFeaturesForNewRow(recentRows, data);

  const record = {
    ...data,
    isImputed: !!data.isImputed,
    // ?? {} guards the manual POST /api/processed path, which doesn't
    // require these fields. Pass plain objects — pg serialises to jsonb
    // directly, no JSON.stringify needed (double-encoding bug otherwise).
    outliersByMetric: data.outliersByMetric ?? {},
    violationsByMetric: data.violationsByMetric ?? {},
    precapFeaturesByMetric: data.precapFeaturesByMetric ?? {},
    historicalFeaturesByMetric,
  };
  const info = await model.insertProcessed(record);
  return rowToProcessed({ id: info.lastInsertRowid, ...record });
}

/**
 * Persist a processed record and immediately notify forecasting/drift/trend
 * detection — the single place that sequence happens, shared by the
 * preprocessing pipeline (preprocessing/pipeline.js) and the manual/back-
 * compat POST /api/processed endpoint (processedController.js), so the
 * four-step "save, forecast, drift, trend" sequence exists in exactly one
 * place.
 *
 * @param precomputedVerdict a Tier 1 verdict pdm's POST /process-window
 *   already returned alongside `data` (pipeline.js's window-close call,
 *   §11.6.3) — passed through so pdmService.js skips its own redundant
 *   POST /score. The manual/back-compat POST /api/processed path never has
 *   one, so it's omitted there and pdmService.js falls back to scoring it
 *   itself, unchanged from before.
 */
export async function saveAndTrigger(data, precomputedVerdict = null) {
  const record = await saveProcessedReading(data);
  try {
    await forecastOnNewRecord(data);
  } catch (err) {
    logger.error(`forecastService.onNewProcessedRecord failed: ${err.stack || err.message}`);
  }
  try {
    await driftOnNewRecord(data);
  } catch (err) {
    logger.error(`driftService.onNewProcessedRecord failed: ${err.stack || err.message}`);
  }
  try {
    await trendOnNewRecord(data);
  } catch (err) {
    logger.error(`trendService.onNewProcessedRecord failed: ${err.stack || err.message}`);
  }
  try {
    // data: flat, same shape the other three get; record.id: the one extra
    // value PdM needs, for fault_events.processedTelemetryId (§3.4). This
    // try/catch only guards a synchronous throw — pdmService.js's own
    // fire-and-forget POST attaches its own .catch() for the async path.
    pdmOnNewRecord(data, record.id, precomputedVerdict);
  } catch (err) {
    logger.error(`pdmService.onNewProcessedRecord failed: ${err.stack || err.message}`);
  }
  return record;
}

/** The most recent processed record, or null if none stored yet. */
export async function getLatestProcessedReading() {
  return rowToProcessed(await model.getLatestProcessed());
}

/** A page of processed history plus pagination metadata (mirrors sensorService). */
export async function getProcessedHistoryPage({ page, limit, sort }) {
  const offset = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    model.getProcessedHistory({ limit, offset, sort }),
    model.getProcessedCount(),
  ]);

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
