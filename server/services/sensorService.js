// ─────────────────────────────────────────────────────────────────────────
// sensorService.js — business logic.
//
// The service sits between controllers (HTTP) and the model (SQL). It:
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

/**
 * Convert a raw DB row into the clean object the API exposes.
 *
 * physicsValid/abnormalOperation are already real booleans (Postgres
 * BOOLEAN), and physicsViolations/unfilledMetrics are already parsed
 * objects (Postgres JSONB) — the model layer no longer stores/returns them
 * as JSON-encoded strings or 0/1 integers, so no parse/coerce step is
 * needed here.
 */
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
    faultType: row.faultType ?? null,
    timestamp: row.timestamp,
    provenance: row.provenance,
    physicsValid: row.physicsValid,
    physicsViolations: row.physicsViolations ?? null,
    unfilledMetrics: row.unfilledMetrics ?? null,
    abnormalOperation: row.abnormalOperation,
  };
}

/**
 * Persist one incoming reading. `data` has already been validated by
 * middleware, so here we only normalise it for storage.
 *
 * physicsValid/physicsViolations/provenance are normally set by the
 * preprocessing pipeline (see preprocessing/validator.js and
 * preprocessing/pipeline.js), which runs on every POST /api/data request
 * regardless of source — including gap-filled ("IMPUTED") reconstructions,
 * see preprocessing/missing.js::generateFillSamples. They default to
 * "valid"/"MEASURED" here only as a safety net for any caller that reaches
 * saveReading() directly, bypassing the pipeline.
 */
export async function saveReading(data) {
  const record = {
    flowRate: data.flowRate,
    rpm: data.rpm,
    vibration: data.vibration,
    suctionPressure: data.suctionPressure,
    dischargePressure: data.dischargePressure,
    motorTemp: data.motorTemp,
    status: data.status || 'RUNNING',
    faultType: data.faultType ?? null,
    // Trust the sensor's timestamp if provided; otherwise stamp it now.
    timestamp: data.timestamp || new Date().toISOString(),
    provenance: data.provenance || 'MEASURED',
    physicsValid: data.physicsValid !== false,
    physicsViolations: Array.isArray(data.physicsViolations) && data.physicsViolations.length
      ? data.physicsViolations
      : null,
    // Set by preprocessing/missing.js (per-metric fill ceilings) and
    // preprocessing/faultClassifier.js (sensor-fault vs. abnormal-operation
    // classification) respectively — see preprocessing/pipeline.js.
    unfilledMetrics: Array.isArray(data.unfilledMetrics) && data.unfilledMetrics.length
      ? data.unfilledMetrics
      : null,
    abnormalOperation: data.abnormalOperation === true,
  };

  const info = await model.insertReading(record);
  return rowToReading({ id: info.lastInsertRowid, ...record });
}

/** The most recent reading, or null if none stored yet. */
export async function getLatestReading() {
  return rowToReading(await model.getLatest());
}

/**
 * A page of history plus pagination metadata.
 * @param {{page:number, limit:number, sort:'asc'|'desc'}} opts
 */
export async function getHistoryPage({ page, limit, sort }) {
  const offset = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    model.getHistory({ limit, offset, sort }),
    model.getCount(),
  ]);

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
export async function getStatistics() {
  const [averages, totalRecords, latestTimestamp] = await Promise.all([
    model.getAverages(),
    model.getCount(),
    model.getLatestTimestamp(),
  ]);
  return {
    totalRecords,
    latestTimestamp,
    averageFlowRate: round2(averages.avgFlowRate),
    averageRpm: round2(averages.avgRpm),
    averageVibration: round2(averages.avgVibration),
    averageSuctionPressure: round2(averages.avgSuctionPressure),
    averageDischargePressure: round2(averages.avgDischargePressure),
    averageMotorTemp: round2(averages.avgMotorTemp),
  };
}
