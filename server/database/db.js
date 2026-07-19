// ─────────────────────────────────────────────────────────────────────────
// db.js — the single, shared SQLite connection.
//
// WHY a single shared connection?
//   SQLite is an embedded database: it is just a file on disk. Opening one
//   connection and reusing it everywhere (a "module singleton") avoids file
//   locking headaches and is exactly how better-sqlite3 is designed to be
//   used. Every model in the app imports THIS db object.
//
// WHY better-sqlite3?
//   Its API is *synchronous*. `db.prepare(sql).get()` returns the row
//   immediately — no callbacks, no async/await. For a small server like ours
//   that makes the storage code trivial to read and reason about, which is
//   perfect for learning. (Node's own event loop is not blocked in a way that
//   matters here because each query is sub-millisecond.)
// ─────────────────────────────────────────────────────────────────────────

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';

// __dirname is not defined in ES modules, so we reconstruct it from the URL.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the DB file path. If DB_PATH is relative (e.g. "./data.db") we
// anchor it to the current working directory; if it is unset we default to a
// data.db that sits next to the server/ folder.
const rawPath = process.env.DB_PATH || join(__dirname, '..', 'data.db');
const DB_PATH = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);

// Opening the Database creates the file automatically if it does not exist.
const db = new Database(DB_PATH);

// WAL (Write-Ahead Logging) lets readers (all our GET endpoints) run while a
// writer (POST /api/data) is committing. Great for a "constantly writing,
// constantly reading" dashboard.
db.pragma('journal_mode = WAL');

// Run the schema file to guarantee the SensorData table + index exist.
const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

// CREATE TABLE IF NOT EXISTS is a no-op on an already-existing table, so a
// column rename (isSynthetic -> provenance) needs an explicit, idempotent
// migration for any data.db created before this change.
const rawTelemetryColumns = db.prepare('PRAGMA table_info(raw_telemetry)').all().map((col) => col.name);
if (!rawTelemetryColumns.includes('provenance')) {
  db.exec("ALTER TABLE raw_telemetry ADD COLUMN provenance TEXT NOT NULL DEFAULT 'MEASURED'");
}
if (!rawTelemetryColumns.includes('faultType')) {
  db.exec('ALTER TABLE raw_telemetry ADD COLUMN faultType TEXT');
}
if (rawTelemetryColumns.includes('isSynthetic')) {
  try {
    db.exec('ALTER TABLE raw_telemetry DROP COLUMN isSynthetic');
  } catch {
    // Older SQLite builds don't support DROP COLUMN — harmless to leave the
    // unused legacy column in place if so.
  }
}

// Same idempotent-migration need as provenance above, for a data.db created
// before per-metric violation tallying existed.
const processedTelemetryColumns = db.prepare('PRAGMA table_info(processed_telemetry)').all().map((col) => col.name);
if (!processedTelemetryColumns.includes('violationsByMetric')) {
  db.exec('ALTER TABLE processed_telemetry ADD COLUMN violationsByMetric TEXT');
}
if (!processedTelemetryColumns.includes('outliersByMetric')) {
  db.exec('ALTER TABLE processed_telemetry ADD COLUMN outliersByMetric TEXT');
}

// Same idempotent-migration need, for a data.db created before physics-invalid
// runs were imputed (rather than dropped) into the stats window.
if (!processedTelemetryColumns.includes('physicsImputedCount')) {
  db.exec('ALTER TABLE processed_telemetry ADD COLUMN physicsImputedCount INTEGER NOT NULL DEFAULT 0');
}
if (!processedTelemetryColumns.includes('physicsImputationRate')) {
  db.exec('ALTER TABLE processed_telemetry ADD COLUMN physicsImputationRate REAL NOT NULL DEFAULT 0');
}

// Same idempotent-migration need, for a data.db created before pre-cap
// (pre-Hampel-cap) per-metric features were captured.
if (!processedTelemetryColumns.includes('precapFeaturesByMetric')) {
  db.exec('ALTER TABLE processed_telemetry ADD COLUMN precapFeaturesByMetric TEXT');
}

// Same idempotent-migration need, for a data.db created before the
// causally-computed rolling/drift feature snapshot existed (see
// preprocessing/historicalFeatures.js) — closes the gap where
// forecastService/driftService only kept live in-memory state, with nothing
// persisted per historical row for fault-prediction training to draw on.
if (!processedTelemetryColumns.includes('historicalFeaturesByMetric')) {
  db.exec('ALTER TABLE processed_telemetry ADD COLUMN historicalFeaturesByMetric TEXT');
}

// Same idempotent-migration need, for a data.db created before event-time
// windowing (buffer.js) and the sensor-fault-vs-abnormal-operation
// classifier (faultClassifier.js) existed.
if (!processedTelemetryColumns.includes('lateSampleCount')) {
  db.exec('ALTER TABLE processed_telemetry ADD COLUMN lateSampleCount INTEGER NOT NULL DEFAULT 0');
}
if (!processedTelemetryColumns.includes('mergedSampleCount')) {
  db.exec('ALTER TABLE processed_telemetry ADD COLUMN mergedSampleCount INTEGER NOT NULL DEFAULT 0');
}
if (!processedTelemetryColumns.includes('duplicateSampleCount')) {
  db.exec('ALTER TABLE processed_telemetry ADD COLUMN duplicateSampleCount INTEGER NOT NULL DEFAULT 0');
}
if (!processedTelemetryColumns.includes('partiallyImputedCount')) {
  db.exec('ALTER TABLE processed_telemetry ADD COLUMN partiallyImputedCount INTEGER NOT NULL DEFAULT 0');
}
if (!processedTelemetryColumns.includes('partiallyImputedRate')) {
  db.exec('ALTER TABLE processed_telemetry ADD COLUMN partiallyImputedRate REAL NOT NULL DEFAULT 0');
}
if (!processedTelemetryColumns.includes('abnormalOperationSampleCount')) {
  db.exec('ALTER TABLE processed_telemetry ADD COLUMN abnormalOperationSampleCount INTEGER NOT NULL DEFAULT 0');
}

// Same idempotent-migration need, for a data.db created before per-window
// fault-signature rollup existed (see preprocessing/aggregation.js).
if (!processedTelemetryColumns.includes('dominantFaultType')) {
  db.exec('ALTER TABLE processed_telemetry ADD COLUMN dominantFaultType TEXT');
}

if (!rawTelemetryColumns.includes('unfilledMetrics')) {
  db.exec('ALTER TABLE raw_telemetry ADD COLUMN unfilledMetrics TEXT');
}
if (!rawTelemetryColumns.includes('abnormalOperation')) {
  db.exec('ALTER TABLE raw_telemetry ADD COLUMN abnormalOperation INTEGER NOT NULL DEFAULT 0');
}

// SQLite's ALTER TABLE can't drop a NOT NULL constraint in place — a
// raw_telemetry table created before per-metric partial-fill rows existed
// still has NOT NULL on the six metric columns, which would throw on the
// first IMPUTED row that legitimately leaves one of them null (see
// preprocessing/missing.js's per-metric interpolation ceilings). Detect that
// case and rebuild the table (standard SQLite recipe: create the new shape,
// copy every row across, drop the old table, rename) rather than silently
// leaving a data-corrupting constraint in place.
const flowRateColumn = db.prepare('PRAGMA table_info(raw_telemetry)').all().find((col) => col.name === 'flowRate');
if (flowRateColumn && flowRateColumn.notnull) {
  db.exec(`
    CREATE TABLE raw_telemetry_new (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      flowRate           REAL,
      rpm                REAL,
      vibration          REAL,
      suctionPressure    REAL,
      dischargePressure  REAL,
      motorTemp          REAL,
      status             TEXT NOT NULL DEFAULT 'STOPPED',
      faultType          TEXT,
      timestamp          TEXT NOT NULL,
      provenance         TEXT NOT NULL DEFAULT 'MEASURED',
      physicsValid       INTEGER NOT NULL DEFAULT 1,
      physicsViolations  TEXT,
      unfilledMetrics    TEXT,
      abnormalOperation  INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO raw_telemetry_new
      (id, flowRate, rpm, vibration, suctionPressure, dischargePressure, motorTemp,
       status, faultType, timestamp, provenance, physicsValid, physicsViolations,
       unfilledMetrics, abnormalOperation)
    SELECT
      id, flowRate, rpm, vibration, suctionPressure, dischargePressure, motorTemp,
       status, faultType, timestamp, provenance, physicsValid, physicsViolations,
       unfilledMetrics, abnormalOperation
    FROM raw_telemetry;
    DROP TABLE raw_telemetry;
    ALTER TABLE raw_telemetry_new RENAME TO raw_telemetry;
    CREATE INDEX IF NOT EXISTS idx_raw_telemetry_timestamp ON raw_telemetry (timestamp DESC);
  `);
  logger.info('SQLite migration: rebuilt raw_telemetry with nullable metric columns (per-metric partial-fill support).');
}

logger.info(`SQLite ready at ${DB_PATH}`);

/**
 * Lightweight health probe used by GET /api/health. Runs the cheapest
 * possible query; if it throws, the database is unavailable.
 */
export function isDatabaseHealthy() {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

export default db;
