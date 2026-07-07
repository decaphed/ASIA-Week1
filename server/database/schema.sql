-- ─────────────────────────────────────────────────────────────────────────
-- Database schema for the IoT dashboard.
--
-- This file is executed once at startup by database/db.js. Everything here is
-- idempotent ("IF NOT EXISTS"), so running it on every boot is safe: the first
-- run creates the table, and later runs are no-ops.
-- ─────────────────────────────────────────────────────────────────────────

-- raw_telemetry: the untouched audit trail. One row per Virtual Estimator
-- tick (~1 Hz), PLUS one row per gap-filled tick the preprocessing pipeline
-- reconstructs (see preprocessing/missing.js::generateFillSamples) — every
-- row is tagged by `provenance` so real and reconstructed data are always
-- distinguishable. The six telemetry values of a MEASURED row are never
-- altered after insert; physicsValid/physicsViolations/provenance are
-- annotations added by the preprocessing pipeline before storage.
CREATE TABLE IF NOT EXISTS raw_telemetry (
  -- Surrogate primary key. INTEGER PRIMARY KEY in SQLite is an alias for the
  -- built-in ROWID, so it auto-increments automatically without extra keywords.
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Pump telemetry. REAL = floating-point column.
  flowRate           REAL NOT NULL,   -- litres/minute, ~50–300
  rpm                REAL NOT NULL,   -- revolutions/minute, ~1000–3600
  vibration          REAL NOT NULL,   -- mm/s, ~0.5–12
  suctionPressure    REAL NOT NULL,   -- bar, ~0.5–3
  dischargePressure  REAL NOT NULL,   -- bar, ~2–12
  motorTemp          REAL NOT NULL,   -- degrees Celsius, ~20–90

  -- Run state as a short text enum: 'RUNNING' | 'STOPPED' | 'FAULT'.
  status             TEXT NOT NULL DEFAULT 'STOPPED',

  -- ISO-8601 timestamp of the reading (e.g. 2026-07-05T10:00:00.000Z). Stored
  -- as TEXT because SQLite has no dedicated date type; ISO strings sort
  -- chronologically as plain text, which is exactly what we want.
  timestamp          TEXT NOT NULL,

  -- Provenance/validation annotations (see preprocessing pipeline docs).
  provenance         TEXT NOT NULL DEFAULT 'MEASURED', -- 'MEASURED' | 'IMPUTED' (gap-filled)
  physicsValid       INTEGER NOT NULL DEFAULT 1,   -- 0 = failed a physics-informed check
  physicsViolations  TEXT                          -- JSON array of rule names, NULL if none
);

-- Index on timestamp: the dashboard constantly asks for "the newest rows"
-- (ORDER BY timestamp DESC) and filters history by time. An index turns those
-- sorts/look-ups into fast B-tree traversals instead of full-table scans.
CREATE INDEX IF NOT EXISTS idx_raw_telemetry_timestamp
  ON raw_telemetry (timestamp DESC);

-- processed_telemetry: one aggregated, quality-scored record per 60-sample
-- (~1 minute) window. This is what forecasting, drift detection and the
-- management dashboard consume. Related to raw_telemetry by TIME RANGE
-- (windowStart <= raw.timestamp < windowEnd), not by foreign key — the
-- relationship is a 60:1 rollup produced continuously in Node-RED, so a
-- per-row FK would add bookkeeping with no query benefit an index doesn't
-- already give a time-range join.
CREATE TABLE IF NOT EXISTS processed_telemetry (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Window boundaries + canonical timestamp. timestamp = windowEnd (see
  -- design doc "Timestamp Handling" for why end-of-window was chosen over
  -- start-of-window or nearest-minute).
  windowStart             TEXT NOT NULL,
  windowEnd               TEXT NOT NULL,
  timestamp               TEXT NOT NULL,

  -- Per-metric aggregation statistics (mean/median/min/max/stdDev/last).
  -- "last" is the final RAW (uncapped) value in the window — the true
  -- instantaneous state at windowEnd — everything else is computed from the
  -- outlier-capped series (see Outlier Handling in the design doc).
  flowRateMean REAL NOT NULL, flowRateMedian REAL NOT NULL, flowRateMin REAL NOT NULL, flowRateMax REAL NOT NULL, flowRateStdDev REAL NOT NULL, flowRateLast REAL NOT NULL,
  rpmMean REAL NOT NULL, rpmMedian REAL NOT NULL, rpmMin REAL NOT NULL, rpmMax REAL NOT NULL, rpmStdDev REAL NOT NULL, rpmLast REAL NOT NULL,
  vibrationMean REAL NOT NULL, vibrationMedian REAL NOT NULL, vibrationMin REAL NOT NULL, vibrationMax REAL NOT NULL, vibrationStdDev REAL NOT NULL, vibrationLast REAL NOT NULL,
  suctionPressureMean REAL NOT NULL, suctionPressureMedian REAL NOT NULL, suctionPressureMin REAL NOT NULL, suctionPressureMax REAL NOT NULL, suctionPressureStdDev REAL NOT NULL, suctionPressureLast REAL NOT NULL,
  dischargePressureMean REAL NOT NULL, dischargePressureMedian REAL NOT NULL, dischargePressureMin REAL NOT NULL, dischargePressureMax REAL NOT NULL, dischargePressureStdDev REAL NOT NULL, dischargePressureLast REAL NOT NULL,
  motorTempMean REAL NOT NULL, motorTempMedian REAL NOT NULL, motorTempMin REAL NOT NULL, motorTempMax REAL NOT NULL, motorTempStdDev REAL NOT NULL, motorTempLast REAL NOT NULL,

  -- Operating-status breakdown across the window (seconds, sums to ~sampleCount).
  dominantStatus          TEXT NOT NULL,
  runningSeconds          INTEGER NOT NULL DEFAULT 0,
  faultSeconds            INTEGER NOT NULL DEFAULT 0,
  stoppedSeconds          INTEGER NOT NULL DEFAULT 0,

  -- Completeness / preprocessing counters.
  sampleCount             INTEGER NOT NULL,
  expectedSampleCount     INTEGER NOT NULL DEFAULT 60,
  missingSampleCount      INTEGER NOT NULL DEFAULT 0,
  imputedSampleCount      INTEGER NOT NULL DEFAULT 0,
  outlierCount            INTEGER NOT NULL DEFAULT 0,
  outliersByMetric        TEXT,                        -- JSON object: per-metric Hampel-capped outlier count (see preprocessing/pipeline.js)
  physicsViolationCount   INTEGER NOT NULL DEFAULT 0,
  violationsByMetric      TEXT,                        -- JSON object: per-metric + cross-variable violation tally (see preprocessing/quality.js)

  -- Rates derived from the counters above (0..1), stored pre-computed so the
  -- dashboard/quality panel never has to recompute them client-side.
  missingRate             REAL NOT NULL DEFAULT 0,
  imputationRate          REAL NOT NULL DEFAULT 0,
  outlierRate             REAL NOT NULL DEFAULT 0,
  physicsPassRate         REAL NOT NULL DEFAULT 1,

  -- Data Quality Assessment (see design doc "Quality Model").
  qualityScore            REAL NOT NULL,   -- 0..100
  qualityLabel            TEXT NOT NULL,   -- GOOD | FAIR | POOR
  isImputed               INTEGER NOT NULL DEFAULT 0,

  -- Metadata.
  preprocessingVersion    TEXT NOT NULL DEFAULT 'v1',
  preprocessingTimestamp  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_telemetry_timestamp
  ON processed_telemetry (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_processed_telemetry_window
  ON processed_telemetry (windowStart, windowEnd);
