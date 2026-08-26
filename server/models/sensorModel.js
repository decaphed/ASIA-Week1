// ─────────────────────────────────────────────────────────────────────────
// sensorModel.js — the ONLY place that contains SQL for raw_telemetry.
//
// This is the "data access layer". Controllers and services never write SQL;
// they call these functions. Keeping every query here means:
//   • one place to audit/optimise queries,
//   • the rest of the app speaks in plain objects, not SQL.
//
// Every camelCase column name is double-quoted — Postgres folds unquoted
// identifiers to lowercase, which would silently return `undefined` for
// every camelCase field on every row. Values are always bound as $1, $2, …
// (never string-concatenated), same injection-safety property the old
// prepared statements had.
//
// Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
// migration.md Phase 4 (Strategy A, drop-and-recreate).
// ─────────────────────────────────────────────────────────────────────────

import pool, { toIso } from '../database/db.js';

function mapRow(row) {
  if (!row) return row;
  return { ...row, timestamp: toIso(row.timestamp) };
}

/** Insert one reading row. Returns the inserted row's id. */
export async function insertReading(record) {
  const result = await pool.query(
    `INSERT INTO raw_telemetry
      ("engineRpm", "lubOilPressure", "fuelPressure", "coolantPressure", "lubOilTemperature", "coolantTemperature", "status", "faultType", "timestamp",
       "provenance", "physicsValid", "physicsViolations", "unfilledMetrics", "abnormalOperation")
     VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      record.engineRpm, record.lubOilPressure, record.fuelPressure, record.coolantPressure, record.lubOilTemperature, record.coolantTemperature,
      record.status, record.faultType, record.timestamp,
      record.provenance, record.physicsValid, JSON.stringify(record.physicsViolations), JSON.stringify(record.unfilledMetrics), record.abnormalOperation,
    ],
  );
  return { lastInsertRowid: result.rows[0].id };
}

/**
 * @returns raw_telemetry rows in [start, end], chronological — used to
 *   reconstruct one 60-second window's worth of samples when a manual
 *   buffer's fault range has no existing processed_telemetry row covering
 *   it (server/services/faultEventService.js's Path B). Narrower-purpose
 *   than faultEventModel.js's getBufferRange, which pulls the full
 *   multi-hour training buffer for export/count, not a single window.
 */
export async function getRangeChronological(start, end) {
  const result = await pool.query(
    `SELECT * FROM raw_telemetry WHERE "timestamp" BETWEEN $1 AND $2 ORDER BY "timestamp" ASC`,
    [start, end],
  );
  return result.rows.map(mapRow);
}

/**
 * @returns the single newest raw_telemetry row strictly before `ts`, or
 *   undefined — Path B's `prevSample` for Python's gap-fill continuity,
 *   mirroring buffer.js's WindowState.prevSample capture for a live window.
 */
export async function getLastBefore(ts) {
  const result = await pool.query(
    `SELECT * FROM raw_telemetry WHERE "timestamp" < $1 ORDER BY "timestamp" DESC LIMIT 1`,
    [ts],
  );
  return mapRow(result.rows[0]);
}

/** @returns the number of raw_telemetry rows in [start, end] — used to reject a manual-buffer request over a range with no ingested data. */
export async function getCountInRange(start, end) {
  const result = await pool.query(
    `SELECT COUNT(*) AS count FROM raw_telemetry WHERE "timestamp" BETWEEN $1 AND $2`,
    [start, end],
  );
  return Number(result.rows[0].count);
}

/** @returns the latest raw row, or undefined if the table is empty. */
export async function getLatest() {
  const result = await pool.query('SELECT * FROM raw_telemetry ORDER BY id DESC LIMIT 1');
  return mapRow(result.rows[0]);
}

/** @returns an array of raw rows for the requested page. */
export async function getHistory({ limit, offset, sort }) {
  const order = sort === 'asc' ? 'ASC' : 'DESC';
  const result = await pool.query(
    `SELECT * FROM raw_telemetry ORDER BY id ${order} LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows.map(mapRow);
}

/** @returns total number of rows. */
export async function getCount() {
  const result = await pool.query('SELECT COUNT(*) AS count FROM raw_telemetry');
  return Number(result.rows[0].count);
}

/** @returns { avgEngineRpm, avgLubOilPressure, avgFuelPressure, avgCoolantPressure, avgLubOilTemperature, avgCoolantTemperature } (values may be null). */
export async function getAverages() {
  const result = await pool.query(`
    SELECT AVG("engineRpm")           AS "avgEngineRpm",
           AVG("lubOilPressure")      AS "avgLubOilPressure",
           AVG("fuelPressure")        AS "avgFuelPressure",
           AVG("coolantPressure")     AS "avgCoolantPressure",
           AVG("lubOilTemperature")   AS "avgLubOilTemperature",
           AVG("coolantTemperature")  AS "avgCoolantTemperature"
    FROM raw_telemetry
  `);
  return result.rows[0];
}

/** @returns the newest timestamp (ISO string), or null if empty. */
export async function getLatestTimestamp() {
  const result = await pool.query('SELECT "timestamp" FROM raw_telemetry ORDER BY id DESC LIMIT 1');
  return result.rows[0] ? toIso(result.rows[0].timestamp) : null;
}

/**
 * Downsampled per-metric averages, one row per non-empty bucket, oldest-first.
 * @param {{ bucketSeconds:number, sinceModifier:string }} opts
 *   bucketSeconds — bucket width in seconds (bound, not concatenated);
 *   sinceModifier — an interval string like '24 hours' / '7 days', used with
 *   Postgres's `now() - $2::interval`.
 * @returns rows: { bucket, t, engineRpm, lubOilPressure, fuelPressure,
 *                  coolantPressure, lubOilTemperature, coolantTemperature }
 *   (metric values are bucket AVGs).
 */
export async function getSeries({ bucketSeconds, sinceModifier }) {
  const result = await pool.query(
    `SELECT FLOOR(EXTRACT(EPOCH FROM "timestamp") / $1)::bigint AS bucket,
            MIN("timestamp")           AS t,
            AVG("engineRpm")           AS "engineRpm",
            AVG("lubOilPressure")      AS "lubOilPressure",
            AVG("fuelPressure")        AS "fuelPressure",
            AVG("coolantPressure")     AS "coolantPressure",
            AVG("lubOilTemperature")   AS "lubOilTemperature",
            AVG("coolantTemperature")  AS "coolantTemperature"
     FROM raw_telemetry
     WHERE "timestamp" >= now() - $2::interval
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [bucketSeconds, sinceModifier],
  );
  return result.rows.map((row) => ({ ...row, t: toIso(row.t) }));
}

/**
 * Single aggregate row over the window (counts, observed span, per-sensor
 * min/max/avg) for the management summary.
 * @param {{ sinceModifier:string }} opts — Postgres interval string for the window.
 */
export async function getSummaryAggregate({ sinceModifier }) {
  const result = await pool.query(
    `SELECT COUNT(*)                                        AS "sampleCount",
            SUM(CASE WHEN "status" = 'RUNNING' THEN 1 ELSE 0 END) AS "runningCount",
            MIN("timestamp")            AS "firstTs",
            MAX("timestamp")            AS "lastTs",
            MIN("engineRpm")            AS "engineRpmMin",
            MAX("engineRpm")            AS "engineRpmMax",
            AVG("engineRpm")            AS "engineRpmAvg",
            MIN("lubOilPressure")       AS "lubOilPressureMin",
            MAX("lubOilPressure")       AS "lubOilPressureMax",
            AVG("lubOilPressure")       AS "lubOilPressureAvg",
            MIN("fuelPressure")         AS "fuelPressureMin",
            MAX("fuelPressure")         AS "fuelPressureMax",
            AVG("fuelPressure")         AS "fuelPressureAvg",
            MIN("coolantPressure")      AS "coolantPressureMin",
            MAX("coolantPressure")      AS "coolantPressureMax",
            AVG("coolantPressure")      AS "coolantPressureAvg",
            MIN("lubOilTemperature")    AS "lubOilTemperatureMin",
            MAX("lubOilTemperature")    AS "lubOilTemperatureMax",
            AVG("lubOilTemperature")    AS "lubOilTemperatureAvg",
            MIN("coolantTemperature")   AS "coolantTemperatureMin",
            MAX("coolantTemperature")   AS "coolantTemperatureMax",
            AVG("coolantTemperature")   AS "coolantTemperatureAvg"
     FROM raw_telemetry
     WHERE "timestamp" >= now() - $1::interval`,
    [sinceModifier],
  );
  const row = result.rows[0];
  return { ...row, firstTs: toIso(row.firstTs), lastTs: toIso(row.lastTs) };
}
