// ─────────────────────────────────────────────────────────────────────────
// sensorService.js — business logic.
//
// The service sits between controllers (HTTP) and the model (SQL). It:
//   • converts between the DB shape (light = 0/1) and the API shape
//     (light = true/false),
//   • fills in a server-side timestamp when the client omits one,
//   • assembles derived data such as statistics and pagination metadata.
//
// Controllers stay thin because all of this lives here.
// ─────────────────────────────────────────────────────────────────────────

import * as model from '../models/sensorModel.js';

/** Round to 2 decimals, preserving null (empty-table averages). */
function round2(value) {
  return value == null ? null : Math.round(value * 100) / 100;
}

/** Convert a raw DB row into the clean object the API exposes. */
function rowToReading(row) {
  if (!row) return null;
  return {
    id: row.id,
    temperature: row.temperature,
    humidity: row.humidity,
    pressure: row.pressure,
    light: row.light === 1, // 0/1 → boolean
    timestamp: row.timestamp,
  };
}

/**
 * Persist one incoming reading. `data` has already been validated by
 * middleware, so here we only normalise it for storage.
 */
export function saveReading(data) {
  const record = {
    temperature: data.temperature,
    humidity: data.humidity,
    pressure: data.pressure,
    // better-sqlite3 cannot bind a JS boolean, so store 0/1.
    light: data.light ? 1 : 0,
    // Trust the sensor's timestamp if provided; otherwise stamp it now.
    timestamp: data.timestamp || new Date().toISOString(),
  };

  const info = model.insertReading(record);
  return rowToReading({ id: Number(info.lastInsertRowid), ...record });
}

/** The most recent reading, or null if none stored yet. */
export function getLatestReading() {
  return rowToReading(model.getLatest());
}

/**
 * A page of history plus pagination metadata.
 * @param {{page:number, limit:number, sort:'asc'|'desc'}} opts
 */
export function getHistoryPage({ page, limit, sort }) {
  const offset = (page - 1) * limit;
  const rows = model.getHistory({ limit, offset, sort });
  const total = model.getCount();

  return {
    page,
    limit,
    sort,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    count: rows.length,
    data: rows.map(rowToReading),
  };
}

/** Aggregate statistics for the dashboard's stats panel. */
export function getStatistics() {
  const averages = model.getAverages();
  return {
    totalRecords: model.getCount(),
    latestTimestamp: model.getLatestTimestamp(),
    averageTemperature: round2(averages.avgTemperature),
    averageHumidity: round2(averages.avgHumidity),
    averagePressure: round2(averages.avgPressure),
  };
}
