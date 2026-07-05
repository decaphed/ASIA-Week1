-- ─────────────────────────────────────────────────────────────────────────
-- Database schema for the IoT dashboard.
--
-- This file is executed once at startup by database/db.js. Everything here is
-- idempotent ("IF NOT EXISTS"), so running it on every boot is safe: the first
-- run creates the table, and later runs are no-ops.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS SensorData (
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
  timestamp          TEXT NOT NULL
);

-- Index on timestamp: the dashboard constantly asks for "the newest rows"
-- (ORDER BY timestamp DESC) and filters history by time. An index turns those
-- sorts/look-ups into fast B-tree traversals instead of full-table scans.
CREATE INDEX IF NOT EXISTS idx_sensordata_timestamp
  ON SensorData (timestamp DESC);
