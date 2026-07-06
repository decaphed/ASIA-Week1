// ─────────────────────────────────────────────────────────────────────────
// processedService.js — business logic for processed_telemetry.
//
// Mirrors sensorService.js's role for raw_telemetry: sits between the HTTP
// layer and the model, converts DB rows <-> the API shape. Unlike
// sensorService, there is no "fill in defaults" step — Node-RED's
// preprocess_minute function node already computed every field (stats,
// counters, quality score/label), and validateProcessed.js already rejected
// anything malformed before this runs. Express only stores and re-shapes.
// ─────────────────────────────────────────────────────────────────────────

import * as model from '../models/processedModel.js';

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
    runningSeconds: row.runningSeconds,
    faultSeconds: row.faultSeconds,
    stoppedSeconds: row.stoppedSeconds,
    sampleCount: row.sampleCount,
    expectedSampleCount: row.expectedSampleCount,
    missingSampleCount: row.missingSampleCount,
    imputedSampleCount: row.imputedSampleCount,
    outlierCount: row.outlierCount,
    physicsViolationCount: row.physicsViolationCount,
    missingRate: row.missingRate,
    imputationRate: row.imputationRate,
    outlierRate: row.outlierRate,
    physicsPassRate: row.physicsPassRate,
    qualityScore: row.qualityScore,
    qualityLabel: row.qualityLabel,
    isImputed: !!row.isImputed,
    preprocessingVersion: row.preprocessingVersion,
    preprocessingTimestamp: row.preprocessingTimestamp,
  };
}

/** Persist one incoming one-minute aggregate. `data` was already validated. */
export function saveProcessedReading(data) {
  const record = { ...data, isImputed: data.isImputed ? 1 : 0 };
  const info = model.insertProcessed(record);
  return rowToProcessed({ id: Number(info.lastInsertRowid), ...record });
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
