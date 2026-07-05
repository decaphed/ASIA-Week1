// ─────────────────────────────────────────────────────────────────────────
// forecastModel.js — the ONLY place forecastService talks to SQL.
//
// Same convention as sensorModel.js: one prepared statement, compiled once
// at module load, reused (bound parameters — no string concatenation).
// ─────────────────────────────────────────────────────────────────────────

import db from '../database/db.js';

// The last n rows, newest first. Used both for the 15-minute re-fit (n=200)
// and the 60-second forward slide (n=1).
const recentStmt = db.prepare(`
  SELECT * FROM SensorData ORDER BY id DESC LIMIT ?
`);

/** @returns an array of up to n raw rows, newest first (id DESC). */
export function getRecentReadings(n) {
  return recentStmt.all(n);
}
