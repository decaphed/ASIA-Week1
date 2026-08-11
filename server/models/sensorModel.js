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
      ("flowRate", "rpm", "vibration", "suctionPressure", "dischargePressure", "motorTemp", "status", "faultType", "timestamp",
       "provenance", "physicsValid", "physicsViolations", "unfilledMetrics", "abnormalOperation")
     VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      record.flowRate, record.rpm, record.vibration, record.suctionPressure, record.dischargePressure, record.motorTemp,
      record.status, record.faultType, record.timestamp,
      record.provenance, record.physicsValid, JSON.stringify(record.physicsViolations), JSON.stringify(record.unfilledMetrics), record.abnormalOperation,
    ],
  );
  return { lastInsertRowid: result.rows[0].id };
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

/** @returns { avgFlowRate, avgRpm, avgVibration, avgSuctionPressure, avgDischargePressure, avgMotorTemp } (values may be null). */
export async function getAverages() {
  const result = await pool.query(`
    SELECT AVG("flowRate")          AS "avgFlowRate",
           AVG("rpm")                AS "avgRpm",
           AVG("vibration")          AS "avgVibration",
           AVG("suctionPressure")    AS "avgSuctionPressure",
           AVG("dischargePressure")  AS "avgDischargePressure",
           AVG("motorTemp")          AS "avgMotorTemp"
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
 * @returns rows: { bucket, t, flowRate, rpm, vibration, suctionPressure,
 *                  dischargePressure, motorTemp } (metric values are bucket AVGs).
 */
export async function getSeries({ bucketSeconds, sinceModifier }) {
  const result = await pool.query(
    `SELECT FLOOR(EXTRACT(EPOCH FROM "timestamp") / $1)::bigint AS bucket,
            MIN("timestamp")          AS t,
            AVG("flowRate")           AS "flowRate",
            AVG("rpm")                AS "rpm",
            AVG("vibration")          AS "vibration",
            AVG("suctionPressure")    AS "suctionPressure",
            AVG("dischargePressure")  AS "dischargePressure",
            AVG("motorTemp")          AS "motorTemp"
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
            MIN("timestamp")          AS "firstTs",
            MAX("timestamp")          AS "lastTs",
            MIN("flowRate")           AS "flowRateMin",
            MAX("flowRate")           AS "flowRateMax",
            AVG("flowRate")           AS "flowRateAvg",
            MIN("rpm")                AS "rpmMin",
            MAX("rpm")                AS "rpmMax",
            AVG("rpm")                AS "rpmAvg",
            MIN("vibration")          AS "vibrationMin",
            MAX("vibration")          AS "vibrationMax",
            AVG("vibration")          AS "vibrationAvg",
            MIN("suctionPressure")    AS "suctionPressureMin",
            MAX("suctionPressure")    AS "suctionPressureMax",
            AVG("suctionPressure")    AS "suctionPressureAvg",
            MIN("dischargePressure")  AS "dischargePressureMin",
            MAX("dischargePressure")  AS "dischargePressureMax",
            AVG("dischargePressure")  AS "dischargePressureAvg",
            MIN("motorTemp")          AS "motorTempMin",
            MAX("motorTemp")          AS "motorTempMax",
            AVG("motorTemp")          AS "motorTempAvg"
     FROM raw_telemetry
     WHERE "timestamp" >= now() - $1::interval`,
    [sinceModifier],
  );
  const row = result.rows[0];
  return { ...row, firstTs: toIso(row.firstTs), lastTs: toIso(row.lastTs) };
}
