// ─────────────────────────────────────────────────────────────────────────
// sensorModel.js — the ONLY place that contains SQL.
//
// This is the "data access layer". Controllers and services never write SQL;
// they call these functions. Keeping every query here means:
//   • one place to audit/optimise queries,
//   • the rest of the app speaks in plain objects, not SQL.
//
// Every statement is "prepared" once at module load. A prepared statement is
// compiled by SQLite a single time and then reused, which is both faster and
// safe against SQL injection because values are *bound* (?/@name), never
// concatenated into the SQL string.
// ─────────────────────────────────────────────────────────────────────────

import db from '../database/db.js';

// INSERT a new reading. Named parameters (@temperature …) are filled from an
// object passed to .run({...}). Returns info incl. lastInsertRowid.
const insertStmt = db.prepare(`
  INSERT INTO raw_telemetry
    (flowRate, rpm, vibration, suctionPressure, dischargePressure, motorTemp, status, faultType, timestamp,
     provenance, physicsValid, physicsViolations, unfilledMetrics, abnormalOperation)
  VALUES
    (@flowRate, @rpm, @vibration, @suctionPressure, @dischargePressure, @motorTemp, @status, @faultType, @timestamp,
     @provenance, @physicsValid, @physicsViolations, @unfilledMetrics, @abnormalOperation)
`);

// The single newest row. ORDER BY id DESC LIMIT 1 = "highest id" = latest
// inserted. Using id (not timestamp) is robust even if two readings share a
// timestamp.
const latestStmt = db.prepare(`
  SELECT * FROM raw_telemetry ORDER BY id DESC LIMIT 1
`);

// History pages. We keep two prepared statements — one per sort direction —
// because the ORDER BY direction cannot be a bound parameter in SQL, and we
// must never string-concatenate untrusted input into the query.
const historyDescStmt = db.prepare(`
  SELECT * FROM raw_telemetry ORDER BY id DESC LIMIT ? OFFSET ?
`);
const historyAscStmt = db.prepare(`
  SELECT * FROM raw_telemetry ORDER BY id ASC LIMIT ? OFFSET ?
`);

// COUNT(*) — total number of stored readings (for pagination + stats).
const countStmt = db.prepare(`
  SELECT COUNT(*) AS count FROM raw_telemetry
`);

// AVG() aggregates across the whole table. SQLite returns NULL for AVG of an
// empty table, which the service layer handles.
const averagesStmt = db.prepare(`
  SELECT AVG(flowRate)          AS avgFlowRate,
         AVG(rpm)                AS avgRpm,
         AVG(vibration)          AS avgVibration,
         AVG(suctionPressure)    AS avgSuctionPressure,
         AVG(dischargePressure)  AS avgDischargePressure,
         AVG(motorTemp)          AS avgMotorTemp
  FROM raw_telemetry
`);

// Just the newest timestamp (used by stats + health).
const latestTimestampStmt = db.prepare(`
  SELECT timestamp FROM raw_telemetry ORDER BY id DESC LIMIT 1
`);

// Downsampled per-metric time series for trend charts (GET /history/series)
// and, at a finer bucket, the excursion tally in summaryService.js.
//
// One prepared statement covers every range: the bucket width (seconds) and
// the time-window origin are both BOUND, never concatenated. The window is
// compared on epoch seconds — strftime('%s', …) on both sides — rather than on
// the raw ISO strings, because our timestamps are 'YYYY-MM-DDTHH:MM:SS.sssZ'
// while SQLite's datetime('now', …) renders 'YYYY-MM-DD HH:MM:SS'; a plain
// string >= would mis-order at the 'T'/space boundary. strftime('%s', …)
// parses both shapes to a real epoch, so the comparison is correct.
//
// Bucket key = floor(epoch / bucketSeconds); MIN(timestamp) is the bucket's
// start instant; empty buckets simply do not appear (GROUP BY over present
// rows only). Ordered oldest-first so charts can plot left-to-right.
const seriesStmt = db.prepare(`
  SELECT CAST(strftime('%s', timestamp) / @bucketSeconds AS INTEGER) AS bucket,
         MIN(timestamp)          AS t,
         AVG(flowRate)           AS flowRate,
         AVG(rpm)                AS rpm,
         AVG(vibration)          AS vibration,
         AVG(suctionPressure)    AS suctionPressure,
         AVG(dischargePressure)  AS dischargePressure,
         AVG(motorTemp)          AS motorTemp
  FROM raw_telemetry
  WHERE strftime('%s', timestamp) >= strftime('%s', 'now', @sinceModifier)
  GROUP BY bucket
  ORDER BY bucket ASC
`);

// One-shot aggregate over a time window for the management summary
// (GET /summary). Same epoch-based window guard as seriesStmt. COUNT/SUM give
// availability + run-time inputs; MIN/MAX(timestamp) give the true observed
// span (guards against ingest gaps); per-sensor MIN/MAX/AVG feed perSensor.
const summaryAggregateStmt = db.prepare(`
  SELECT COUNT(*)                                        AS sampleCount,
         SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) AS runningCount,
         MIN(timestamp)          AS firstTs,
         MAX(timestamp)          AS lastTs,
         MIN(flowRate)           AS flowRateMin,
         MAX(flowRate)           AS flowRateMax,
         AVG(flowRate)           AS flowRateAvg,
         MIN(rpm)                AS rpmMin,
         MAX(rpm)                AS rpmMax,
         AVG(rpm)                AS rpmAvg,
         MIN(vibration)          AS vibrationMin,
         MAX(vibration)          AS vibrationMax,
         AVG(vibration)          AS vibrationAvg,
         MIN(suctionPressure)    AS suctionPressureMin,
         MAX(suctionPressure)    AS suctionPressureMax,
         AVG(suctionPressure)    AS suctionPressureAvg,
         MIN(dischargePressure)  AS dischargePressureMin,
         MAX(dischargePressure)  AS dischargePressureMax,
         AVG(dischargePressure)  AS dischargePressureAvg,
         MIN(motorTemp)          AS motorTempMin,
         MAX(motorTemp)          AS motorTempMax,
         AVG(motorTemp)          AS motorTempAvg
  FROM raw_telemetry
  WHERE strftime('%s', timestamp) >= strftime('%s', 'now', @sinceModifier)
`);

/** Insert one reading row. `record.light` must already be 0 or 1. */
export function insertReading(record) {
  return insertStmt.run(record);
}

/** @returns the latest raw row, or undefined if the table is empty. */
export function getLatest() {
  return latestStmt.get();
}

/** @returns an array of raw rows for the requested page. */
export function getHistory({ limit, offset, sort }) {
  const stmt = sort === 'asc' ? historyAscStmt : historyDescStmt;
  return stmt.all(limit, offset);
}

/** @returns total number of rows. */
export function getCount() {
  return countStmt.get().count;
}

/** @returns { avgTemperature, avgHumidity, avgPressure } (values may be null). */
export function getAverages() {
  return averagesStmt.get();
}

/** @returns the newest timestamp string, or null if empty. */
export function getLatestTimestamp() {
  const row = latestTimestampStmt.get();
  return row ? row.timestamp : null;
}

/**
 * Downsampled per-metric averages, one row per non-empty bucket, oldest-first.
 * @param {{ bucketSeconds:number, sinceModifier:string }} opts
 *   bucketSeconds — bucket width in seconds (bound, not concatenated);
 *   sinceModifier — a SQLite datetime modifier like '-24 hours' / '-7 days'.
 * @returns rows: { bucket, t, flowRate, rpm, vibration, suctionPressure,
 *                  dischargePressure, motorTemp } (metric values are bucket AVGs).
 */
export function getSeries({ bucketSeconds, sinceModifier }) {
  return seriesStmt.all({ bucketSeconds, sinceModifier });
}

/**
 * Single aggregate row over the window (counts, observed span, per-sensor
 * min/max/avg) for the management summary.
 * @param {{ sinceModifier:string }} opts — SQLite datetime modifier for the window.
 */
export function getSummaryAggregate({ sinceModifier }) {
  return summaryAggregateStmt.get({ sinceModifier });
}
