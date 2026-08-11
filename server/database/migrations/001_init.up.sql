-- 001_init.up.sql — initial TimescaleDB schema.
--
-- Ported 1:1 from the former SQLite schema.sql (raw_telemetry +
-- processed_telemetry only — fault_events is a later, separate PdM phase,
-- added in 002_fault_events.up.sql once it was actually needed). Column names, NOT NULL
-- constraints, and DEFAULTs are preserved exactly; comments are carried
-- over so the *why* behind each column travels with the schema, not just
-- the *what*.
--
-- Both tables are converted to TimescaleDB hypertables partitioned on
-- "timestamp". Timescale requires any PRIMARY KEY/UNIQUE index to include
-- the partitioning column, hence the composite (id, "timestamp") key
-- instead of a bare surrogate id.
--
-- Every mixed-case column is double-quoted, including ones that happen to
-- already be all-lowercase ("rpm", "status", ...). This is deliberate and
-- must stay consistent: Postgres folds *any* unquoted identifier to
-- lowercase, so quoting only the columns that "need" it today is a trap
-- the moment a column is renamed later. One rule, applied uniformly, is
-- easier to keep correct than "quote it only if it's currently mixed
-- case". Every hand-written query against these tables (models, scripts,
-- ad-hoc psql) MUST double-quote these same identifiers, or Postgres will
-- silently look up the lowercase-folded name instead of erroring.

CREATE TABLE raw_telemetry (
  id                 BIGSERIAL,

  -- Pump telemetry. DOUBLE PRECISION is the right call here, not NUMERIC:
  -- these are physical sensor measurements (litres/min, RPM, mm/s, bar,
  -- degrees C), not currency, so there is no requirement for exact
  -- decimal representation — the sensors themselves have far less
  -- precision than an IEEE 754 double carries. NUMERIC would add storage
  -- and arithmetic overhead for zero real benefit here. Nullable: an
  -- internally generated IMPUTED fill row can leave a specific metric
  -- null when that metric's gap exceeds its own per-metric interpolation
  -- ceiling (see preprocessing/missing.js) — never true for a real
  -- MEASURED reading, which is still hard-required at the HTTP boundary
  -- (validateReading). Do NOT add NOT NULL to these columns.
  "flowRate"           DOUBLE PRECISION,   -- litres/minute, ~50-300
  "rpm"                DOUBLE PRECISION,   -- revolutions/minute, ~1000-3600
  "vibration"          DOUBLE PRECISION,   -- mm/s, ~0.5-12
  "suctionPressure"    DOUBLE PRECISION,   -- bar, ~0.5-3
  "dischargePressure"  DOUBLE PRECISION,   -- bar, ~2-12
  "motorTemp"          DOUBLE PRECISION,   -- degrees Celsius, ~20-90

  -- Run state as a short text enum: 'RUNNING' | 'STOPPED' | 'FAULT'.
  "status"             TEXT NOT NULL DEFAULT 'STOPPED',

  -- Failure signature, only set while status = 'FAULT': 'THERMAL' |
  -- 'CAVITATION' | 'BEARING' (see node-red/flow.json's FAULT_PROFILES).
  -- NULL for RUNNING/STOPPED rows.
  "faultType"          TEXT,

  -- Reading timestamp. TIMESTAMPTZ (not the SQLite-era TEXT/ISO-string
  -- hack) — this is also the hypertable partitioning column.
  "timestamp"          TIMESTAMPTZ NOT NULL,

  -- Provenance/validation annotations (see preprocessing pipeline docs).
  "provenance"         TEXT NOT NULL DEFAULT 'MEASURED', -- 'MEASURED' | 'IMPUTED' (gap-filled)
  "physicsValid"       BOOLEAN NOT NULL DEFAULT TRUE,    -- FALSE = failed a physics-informed check
  "physicsViolations"  JSONB,                            -- array of rule names, NULL if none

  -- Metric names left null on this row because their gap exceeded that
  -- metric's own interpolation ceiling (see preprocessing/missing.js).
  -- NULL when every metric was filled/measured.
  "unfilledMetrics"    JSONB,
  -- Set by preprocessing/faultClassifier.js: TRUE when a physics-invalid
  -- run this sample belongs to was classified NOT_SENSOR_FAULT (genuine
  -- abnormal operation, deliberately left unrepaired) rather than
  -- SENSOR_FAULT (repaired in the stats-facing copy).
  "abnormalOperation"  BOOLEAN NOT NULL DEFAULT FALSE,

  PRIMARY KEY (id, "timestamp")
);

-- create_default_indexes => FALSE: create_hypertable() would otherwise add
-- its own ascending index on the partitioning column, which would be
-- redundant with (and slightly worse than, for this app's "get newest
-- rows" access pattern) the explicit DESC index created below. Avoids
-- carrying two overlapping indexes on a table taking ~86,400 writes/day.
SELECT create_hypertable('raw_telemetry', 'timestamp', create_default_indexes => FALSE);

-- The dashboard constantly asks for "the newest rows" (ORDER BY timestamp
-- DESC) and filters history by time range. A DESC index serves both
-- ORDER BY timestamp DESC LIMIT n and range scans without a sort step.
CREATE INDEX idx_raw_telemetry_timestamp
  ON raw_telemetry ("timestamp" DESC);

-- processed_telemetry: one aggregated, quality-scored record per 60-sample
-- (~1 minute) window. This is what forecasting, drift detection and the
-- management dashboard consume. Related to raw_telemetry by TIME RANGE
-- (windowStart <= raw.timestamp < windowEnd), not by foreign key — the
-- relationship is a 60:1 rollup produced continuously in Node-RED, so a
-- per-row FK would add bookkeeping with no query benefit an index doesn't
-- already give a time-range join.
CREATE TABLE processed_telemetry (
  id                      BIGSERIAL,

  -- Window boundaries + canonical timestamp. timestamp = windowEnd (see
  -- design doc "Timestamp Handling" for why end-of-window was chosen over
  -- start-of-window or nearest-minute).
  "windowStart"             TIMESTAMPTZ NOT NULL,
  "windowEnd"               TIMESTAMPTZ NOT NULL,
  "timestamp"               TIMESTAMPTZ NOT NULL,

  -- Per-metric aggregation statistics (mean/median/min/max/stdDev/last).
  -- "last" is the final RAW (uncapped) value in the window — the true
  -- instantaneous state at windowEnd — everything else is computed from
  -- the outlier-capped series (see Outlier Handling in the design doc).
  -- DOUBLE PRECISION throughout for the same reason as raw_telemetry
  -- above: these are statistics over physical measurements, not money.
  "flowRateMean" DOUBLE PRECISION NOT NULL, "flowRateMedian" DOUBLE PRECISION NOT NULL, "flowRateMin" DOUBLE PRECISION NOT NULL, "flowRateMax" DOUBLE PRECISION NOT NULL, "flowRateStdDev" DOUBLE PRECISION NOT NULL, "flowRateLast" DOUBLE PRECISION NOT NULL,
  "rpmMean" DOUBLE PRECISION NOT NULL, "rpmMedian" DOUBLE PRECISION NOT NULL, "rpmMin" DOUBLE PRECISION NOT NULL, "rpmMax" DOUBLE PRECISION NOT NULL, "rpmStdDev" DOUBLE PRECISION NOT NULL, "rpmLast" DOUBLE PRECISION NOT NULL,
  "vibrationMean" DOUBLE PRECISION NOT NULL, "vibrationMedian" DOUBLE PRECISION NOT NULL, "vibrationMin" DOUBLE PRECISION NOT NULL, "vibrationMax" DOUBLE PRECISION NOT NULL, "vibrationStdDev" DOUBLE PRECISION NOT NULL, "vibrationLast" DOUBLE PRECISION NOT NULL,
  "suctionPressureMean" DOUBLE PRECISION NOT NULL, "suctionPressureMedian" DOUBLE PRECISION NOT NULL, "suctionPressureMin" DOUBLE PRECISION NOT NULL, "suctionPressureMax" DOUBLE PRECISION NOT NULL, "suctionPressureStdDev" DOUBLE PRECISION NOT NULL, "suctionPressureLast" DOUBLE PRECISION NOT NULL,
  "dischargePressureMean" DOUBLE PRECISION NOT NULL, "dischargePressureMedian" DOUBLE PRECISION NOT NULL, "dischargePressureMin" DOUBLE PRECISION NOT NULL, "dischargePressureMax" DOUBLE PRECISION NOT NULL, "dischargePressureStdDev" DOUBLE PRECISION NOT NULL, "dischargePressureLast" DOUBLE PRECISION NOT NULL,
  "motorTempMean" DOUBLE PRECISION NOT NULL, "motorTempMedian" DOUBLE PRECISION NOT NULL, "motorTempMin" DOUBLE PRECISION NOT NULL, "motorTempMax" DOUBLE PRECISION NOT NULL, "motorTempStdDev" DOUBLE PRECISION NOT NULL, "motorTempLast" DOUBLE PRECISION NOT NULL,

  -- Operating-status breakdown across the window (seconds, sums to ~sampleCount).
  "dominantStatus"          TEXT NOT NULL,
  -- Dominant failure signature (THERMAL | CAVITATION | BEARING) among this
  -- window's FAULT samples, or NULL if none — mirrors raw_telemetry.faultType,
  -- rolled up the same way dominantStatus is (see preprocessing/aggregation.js).
  "dominantFaultType"       TEXT,
  "runningSeconds"          INTEGER NOT NULL DEFAULT 0,
  "faultSeconds"            INTEGER NOT NULL DEFAULT 0,
  "stoppedSeconds"          INTEGER NOT NULL DEFAULT 0,

  -- Completeness / preprocessing counters.
  "sampleCount"             INTEGER NOT NULL,
  "expectedSampleCount"     INTEGER NOT NULL DEFAULT 60,
  "missingSampleCount"      INTEGER NOT NULL DEFAULT 0,
  "imputedSampleCount"      INTEGER NOT NULL DEFAULT 0,
  "outlierCount"            INTEGER NOT NULL DEFAULT 0,
  "outliersByMetric"        JSONB,   -- per-metric Hampel-capped outlier count (see preprocessing/pipeline.js)
  "physicsViolationCount"   INTEGER NOT NULL DEFAULT 0,
  "violationsByMetric"      JSONB,   -- per-metric + cross-variable violation tally (see preprocessing/quality.js)
  "physicsImputedCount"     INTEGER NOT NULL DEFAULT 0,   -- physics-invalid samples interpolated into the stats window (see preprocessing/missing.js::imputeInvalidRuns)
  "precapFeaturesByMetric"  JSONB,   -- per-metric rawStdDev/rawRateOfChange/rawMaxExcursion computed BEFORE Hampel capping (see preprocessing/precapFeatures.js)
  "historicalFeaturesByMetric" JSONB,   -- per-metric rollingMean/rollingStd/rollingSlope + driftZ/driftDirection, computed causally as of this row (see preprocessing/historicalFeatures.js)

  -- Rates derived from the counters above (0..1), stored pre-computed so
  -- the dashboard/quality panel never has to recompute them client-side.
  "missingRate"             DOUBLE PRECISION NOT NULL DEFAULT 0,
  "imputationRate"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "physicsImputationRate"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "outlierRate"             DOUBLE PRECISION NOT NULL DEFAULT 0,
  "physicsPassRate"         DOUBLE PRECISION NOT NULL DEFAULT 1,

  -- Data Quality Assessment (see design doc "Quality Model").
  "qualityScore"            DOUBLE PRECISION NOT NULL,   -- 0..100
  "qualityLabel"            TEXT NOT NULL,                -- GOOD | FAIR | POOR
  "isImputed"               BOOLEAN NOT NULL DEFAULT FALSE,

  -- Event-time windowing / classifier counters (observational, NOT part of
  -- qualityScore — see preprocessing/quality.js).
  "lateSampleCount"          INTEGER NOT NULL DEFAULT 0,
  "mergedSampleCount"        INTEGER NOT NULL DEFAULT 0,
  "duplicateSampleCount"     INTEGER NOT NULL DEFAULT 0,
  "partiallyImputedCount"    INTEGER NOT NULL DEFAULT 0,
  "partiallyImputedRate"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "abnormalOperationSampleCount" INTEGER NOT NULL DEFAULT 0,

  -- Metadata.
  "preprocessingVersion"    TEXT NOT NULL DEFAULT 'v1',
  "preprocessingTimestamp"  TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (id, "timestamp")
);

-- Same reasoning as raw_telemetry: skip Timescale's default index, add our
-- own DESC index below instead of a duplicate ascending one.
SELECT create_hypertable('processed_telemetry', 'timestamp', create_default_indexes => FALSE);

CREATE INDEX idx_processed_telemetry_timestamp
  ON processed_telemetry ("timestamp" DESC);
CREATE INDEX idx_processed_telemetry_window
  ON processed_telemetry ("windowStart", "windowEnd");
