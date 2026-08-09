-- 01-init-pump-telemetry.sql — creates the pump_telemetry database, enables
-- TimescaleDB, and hands ownership to pdm_app.
--
-- Runs as $POSTGRES_USER (postgres superuser) against $POSTGRES_DB
-- ("postgres"), per docker-entrypoint-initdb.d convention. \c only
-- switches the target database, not the connected role, so every
-- statement below still executes as the postgres superuser — ordering
-- CREATE EXTENSION before ALTER DATABASE ... OWNER TO is not load-bearing
-- for privileges, but is kept in this order because it reads naturally:
-- provision the database, then hand it off.
CREATE DATABASE pump_telemetry;

\c pump_telemetry

-- Creating the timescaledb extension requires superuser (or being on the
-- extension allowlist); must happen while still connected as postgres.
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ALTER DATABASE ... OWNER TO is sufficient on its own: database ownership
-- already implies every privilege ON the database (CONNECT/CREATE/
-- TEMPORARY), so a separate GRANT ALL PRIVILEGES beforehand would be
-- redundant. On Postgres 15+ the "public" schema inside a freshly created
-- database is owned by the pseudo-role pg_database_owner, whose members
-- are dynamically "whoever currently owns this database" — so pdm_app
-- also gets CREATE on the public schema (needed to run migrations)
-- automatically once it becomes the database owner, with no extra GRANT
-- needed for that either.
ALTER DATABASE pump_telemetry OWNER TO pdm_app;
