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
  INSERT INTO SensorData (temperature, humidity, pressure, light, timestamp)
  VALUES (@temperature, @humidity, @pressure, @light, @timestamp)
`);

// The single newest row. ORDER BY id DESC LIMIT 1 = "highest id" = latest
// inserted. Using id (not timestamp) is robust even if two readings share a
// timestamp.
const latestStmt = db.prepare(`
  SELECT * FROM SensorData ORDER BY id DESC LIMIT 1
`);

// History pages. We keep two prepared statements — one per sort direction —
// because the ORDER BY direction cannot be a bound parameter in SQL, and we
// must never string-concatenate untrusted input into the query.
const historyDescStmt = db.prepare(`
  SELECT * FROM SensorData ORDER BY id DESC LIMIT ? OFFSET ?
`);
const historyAscStmt = db.prepare(`
  SELECT * FROM SensorData ORDER BY id ASC LIMIT ? OFFSET ?
`);

// COUNT(*) — total number of stored readings (for pagination + stats).
const countStmt = db.prepare(`
  SELECT COUNT(*) AS count FROM SensorData
`);

// AVG() aggregates across the whole table. SQLite returns NULL for AVG of an
// empty table, which the service layer handles.
const averagesStmt = db.prepare(`
  SELECT AVG(temperature) AS avgTemperature,
         AVG(humidity)    AS avgHumidity,
         AVG(pressure)    AS avgPressure
  FROM SensorData
`);

// Just the newest timestamp (used by stats + health).
const latestTimestampStmt = db.prepare(`
  SELECT timestamp FROM SensorData ORDER BY id DESC LIMIT 1
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
