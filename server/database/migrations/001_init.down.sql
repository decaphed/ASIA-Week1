-- 001_init.down.sql — reverse of 001_init.up.sql.
-- No FK between the two tables (see comment in 001_init.up.sql), so drop
-- order is not load-bearing; processed_telemetry first purely because it's
-- the "downstream" table.
DROP TABLE IF EXISTS processed_telemetry;
DROP TABLE IF EXISTS raw_telemetry;
