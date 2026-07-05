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
  id          INTEGER PRIMARY KEY AUTOINCREMENT,

  -- The three numeric measurements. REAL = floating-point column.
  temperature REAL    NOT NULL,   -- degrees Celsius, ~20–35
  humidity    REAL    NOT NULL,   -- percent, ~40–80
  pressure    REAL    NOT NULL,   -- hectopascals (hPa), ~980–1040

  -- SQLite has no native BOOLEAN type, so we store the light status as an
  -- INTEGER (0 = off / false, 1 = on / true) and convert back to a real
  -- boolean in the service layer.
  light       INTEGER NOT NULL DEFAULT 0,

  -- ISO-8601 timestamp of the reading (e.g. 2026-07-05T10:00:00.000Z). Stored
  -- as TEXT because SQLite has no dedicated date type; ISO strings sort
  -- chronologically as plain text, which is exactly what we want.
  timestamp   TEXT    NOT NULL
);

-- Index on timestamp: the dashboard constantly asks for "the newest rows"
-- (ORDER BY timestamp DESC) and filters history by time. An index turns those
-- sorts/look-ups into fast B-tree traversals instead of full-table scans.
CREATE INDEX IF NOT EXISTS idx_sensordata_timestamp
  ON SensorData (timestamp DESC);
