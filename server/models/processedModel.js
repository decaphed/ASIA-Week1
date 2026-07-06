// ─────────────────────────────────────────────────────────────────────────
// processedModel.js — the ONLY place that contains SQL for processed_telemetry.
//
// Same convention as sensorModel.js: one prepared statement per query,
// compiled once at module load, values bound (never string-concatenated).
// ─────────────────────────────────────────────────────────────────────────

import db from '../database/db.js';

const METRICS = ['flowRate', 'rpm', 'vibration', 'suctionPressure', 'dischargePressure', 'motorTemp'];
const STATS = ['Mean', 'Median', 'Min', 'Max', 'StdDev', 'Last'];
const METRIC_COLUMNS = METRICS.flatMap((metric) => STATS.map((stat) => `${metric}${stat}`));

const insertStmt = db.prepare(`
  INSERT INTO processed_telemetry
    (windowStart, windowEnd, timestamp,
     ${METRIC_COLUMNS.join(', ')},
     dominantStatus, runningSeconds, faultSeconds, stoppedSeconds,
     sampleCount, expectedSampleCount, missingSampleCount, imputedSampleCount, outlierCount, physicsViolationCount,
     missingRate, imputationRate, outlierRate, physicsPassRate,
     qualityScore, qualityLabel, isImputed,
     preprocessingVersion, preprocessingTimestamp)
  VALUES
    (@windowStart, @windowEnd, @timestamp,
     ${METRIC_COLUMNS.map((c) => `@${c}`).join(', ')},
     @dominantStatus, @runningSeconds, @faultSeconds, @stoppedSeconds,
     @sampleCount, @expectedSampleCount, @missingSampleCount, @imputedSampleCount, @outlierCount, @physicsViolationCount,
     @missingRate, @imputationRate, @outlierRate, @physicsPassRate,
     @qualityScore, @qualityLabel, @isImputed,
     @preprocessingVersion, @preprocessingTimestamp)
`);

// Newest-first. Used both by the dashboard (small n) and by forecasting /
// drift detection (larger n).
const recentStmt = db.prepare(`
  SELECT * FROM processed_telemetry ORDER BY id DESC LIMIT ?
`);

const latestStmt = db.prepare(`
  SELECT * FROM processed_telemetry ORDER BY id DESC LIMIT 1
`);

const historyDescStmt = db.prepare(`
  SELECT * FROM processed_telemetry ORDER BY id DESC LIMIT ? OFFSET ?
`);
const historyAscStmt = db.prepare(`
  SELECT * FROM processed_telemetry ORDER BY id ASC LIMIT ? OFFSET ?
`);
const countStmt = db.prepare(`
  SELECT COUNT(*) AS count FROM processed_telemetry
`);

/** Insert one processed (one-minute aggregate) record. */
export function insertProcessed(record) {
  return insertStmt.run(record);
}

/** @returns up to n most recent rows, newest first (id DESC). */
export function getRecentProcessed(n) {
  return recentStmt.all(n);
}

/** @returns the single newest row, or undefined if the table is empty. */
export function getLatestProcessed() {
  return latestStmt.get();
}

/** @returns an array of raw rows for the requested page. */
export function getProcessedHistory({ limit, offset, sort }) {
  const stmt = sort === 'asc' ? historyAscStmt : historyDescStmt;
  return stmt.all(limit, offset);
}

/** @returns total number of processed rows. */
export function getProcessedCount() {
  return countStmt.get().count;
}
