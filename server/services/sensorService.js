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
    flowRate: row.flowRate,
    rpm: row.rpm,
    vibration: row.vibration,
    suctionPressure: row.suctionPressure,
    dischargePressure: row.dischargePressure,
    motorTemp: row.motorTemp,
    status: row.status,
    timestamp: row.timestamp,
    isSynthetic: !!row.isSynthetic,
    physicsValid: !!row.physicsValid,
    physicsViolations: row.physicsViolations ? JSON.parse(row.physicsViolations) : null,
  };
}

/**
 * Persist one incoming reading. `data` has already been validated by
 * middleware, so here we only normalise it for storage.
 *
 * physicsValid/physicsViolations are normally set by Node-RED's
 * preprocess_minute function node (stage 1 of the preprocessing pipeline,
 * applied right after generation — see node-red/flow.json). They default to
 * "valid" here so readings posted from elsewhere (e.g. ManualReadingForm.jsx,
 * which bypasses Node-RED entirely) still get a well-formed row.
 */
export function saveReading(data) {
  const record = {
    flowRate: data.flowRate,
    rpm: data.rpm,
    vibration: data.vibration,
    suctionPressure: data.suctionPressure,
    dischargePressure: data.dischargePressure,
    motorTemp: data.motorTemp,
    status: data.status || 'RUNNING',
    // Trust the sensor's timestamp if provided; otherwise stamp it now.
    timestamp: data.timestamp || new Date().toISOString(),
    isSynthetic: data.isSynthetic ? 1 : 0,
    physicsValid: data.physicsValid === false ? 0 : 1,
    physicsViolations: Array.isArray(data.physicsViolations) && data.physicsViolations.length
      ? JSON.stringify(data.physicsViolations)
      : null,
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
    averageFlowRate: round2(averages.avgFlowRate),
    averageRpm: round2(averages.avgRpm),
    averageVibration: round2(averages.avgVibration),
    averageSuctionPressure: round2(averages.avgSuctionPressure),
    averageDischargePressure: round2(averages.avgDischargePressure),
    averageMotorTemp: round2(averages.avgMotorTemp),
  };
}
