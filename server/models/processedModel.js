// ─────────────────────────────────────────────────────────────────────────
// processedModel.js — the ONLY place that contains SQL for processed_telemetry.
//
// Same convention as sensorModel.js: every camelCase column name is
// double-quoted, values are always bound as $1, $2, … (never concatenated).
// ─────────────────────────────────────────────────────────────────────────

import pool, { toIso } from '../database/db.js';

const METRICS = ['flowRate', 'rpm', 'vibration', 'suctionPressure', 'dischargePressure', 'motorTemp'];
const STATS = ['Mean', 'Median', 'Min', 'Max', 'StdDev', 'Last'];
const METRIC_COLUMNS = METRICS.flatMap((metric) => STATS.map((stat) => `${metric}${stat}`));

const INSERT_COLUMNS = [
  'windowStart', 'windowEnd', 'timestamp',
  ...METRIC_COLUMNS,
  'dominantStatus', 'dominantFaultType', 'runningSeconds', 'faultSeconds', 'stoppedSeconds',
  'sampleCount', 'expectedSampleCount', 'missingSampleCount', 'imputedSampleCount', 'outlierCount', 'outliersByMetric', 'physicsViolationCount', 'violationsByMetric', 'physicsImputedCount', 'precapFeaturesByMetric', 'historicalFeaturesByMetric',
  'missingRate', 'imputationRate', 'outlierRate', 'physicsPassRate', 'physicsImputationRate',
  'lateSampleCount', 'mergedSampleCount', 'duplicateSampleCount', 'partiallyImputedCount', 'partiallyImputedRate', 'abnormalOperationSampleCount',
  'qualityScore', 'qualityLabel', 'isImputed',
  'preprocessingVersion', 'preprocessingTimestamp',
];

const INSERT_SQL = `
  INSERT INTO processed_telemetry
    (${INSERT_COLUMNS.map((c) => `"${c}"`).join(', ')})
  VALUES
    (${INSERT_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
  RETURNING id
`;

function mapRow(row) {
  if (!row) return row;
  return {
    ...row,
    timestamp: toIso(row.timestamp),
    windowStart: toIso(row.windowStart),
    windowEnd: toIso(row.windowEnd),
    preprocessingTimestamp: toIso(row.preprocessingTimestamp),
  };
}

/** Insert one processed (one-minute aggregate) record. Returns the inserted row's id. */
export async function insertProcessed(record) {
  const values = INSERT_COLUMNS.map((c) => record[c]);
  const result = await pool.query(INSERT_SQL, values);
  return { lastInsertRowid: result.rows[0].id };
}

/** @returns up to n most recent rows, newest first (id DESC). */
export async function getRecentProcessed(n) {
  const result = await pool.query('SELECT * FROM processed_telemetry ORDER BY id DESC LIMIT $1', [n]);
  return result.rows.map(mapRow);
}

/** @returns the single newest row, or undefined if the table is empty. */
export async function getLatestProcessed() {
  const result = await pool.query('SELECT * FROM processed_telemetry ORDER BY id DESC LIMIT 1');
  return mapRow(result.rows[0]);
}

/** @returns an array of rows for the requested page. */
export async function getProcessedHistory({ limit, offset, sort }) {
  const order = sort === 'asc' ? 'ASC' : 'DESC';
  const result = await pool.query(
    `SELECT * FROM processed_telemetry ORDER BY id ${order} LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows.map(mapRow);
}

/** @returns total number of processed rows. */
export async function getProcessedCount() {
  const result = await pool.query('SELECT COUNT(*) AS count FROM processed_telemetry');
  return Number(result.rows[0].count);
}

/**
 * @returns processed_telemetry rows whose windowEnd falls in [start, end],
 *   chronological — used to find an already-computed window inside a
 *   manual-buffer fault range (server/services/faultEventService.js's
 *   Path A: reuse an existing row rather than reconstructing one).
 */
export async function getProcessedByWindowRange(start, end) {
  const result = await pool.query(
    `SELECT * FROM processed_telemetry WHERE "windowEnd" BETWEEN $1 AND $2 ORDER BY "windowEnd" ASC`,
    [start, end],
  );
  return result.rows.map(mapRow);
}

/** @returns the single processed_telemetry row with this exact windowEnd, or undefined. */
export async function getProcessedByWindowEnd(windowEnd) {
  const result = await pool.query('SELECT * FROM processed_telemetry WHERE "windowEnd" = $1', [windowEnd]);
  return mapRow(result.rows[0]);
}

/** @returns every processed row, oldest first (id ASC) — used by the historical-features backfill script. */
export async function getAllProcessedChronological() {
  const result = await pool.query('SELECT * FROM processed_telemetry ORDER BY id ASC');
  return result.rows.map(mapRow);
}

/**
 * Overwrite historicalFeaturesByMetric for one existing row (backfill script
 * only — new rows set it at insert time). `client` is optional — when
 * provided (inside a withTransaction() call), the update runs on that
 * client instead of a fresh pool connection, so it participates in the
 * caller's transaction.
 */
export async function updateHistoricalFeatures(id, historicalFeaturesByMetric, client = pool) {
  return client.query(
    'UPDATE processed_telemetry SET "historicalFeaturesByMetric" = $1 WHERE id = $2',
    [historicalFeaturesByMetric, id],
  );
}
