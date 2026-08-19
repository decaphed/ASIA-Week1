-- 04-revoke-public-connect.sql — revokes the default PUBLIC CONNECT
-- privilege Postgres grants on every database at creation time.
--
-- Runs after 01-init-pump-telemetry.sql and 02-create-authentik-db.sh
-- (alphabetical order), so pump_telemetry and authentik_db already exist
-- by the time this fires. Plain .sql (not .sh) is fine here — unlike
-- 00/02/03, nothing below needs shell env-var interpolation.
--
-- Without this, any role that can authenticate at all (pdm_corpus_readonly,
-- pdm_app, authentik_svc) can open a connection to *every* database on the
-- instance, not just the one it's scoped to — e.g. pdm_corpus_readonly,
-- meant to be confined to pump_telemetry, could otherwise connect straight
-- to authentik_db. Per-table/schema grants already narrow what a role can
-- do once connected, but CONNECT itself was never narrowed.
--
-- REVOKE CONNECT does not need \c into the target database — CONNECT is a
-- database-level ACL entry, revoked from the catalog regardless of which
-- database the revoking session is attached to.
REVOKE CONNECT ON DATABASE pump_telemetry FROM PUBLIC;
REVOKE CONNECT ON DATABASE authentik_db FROM PUBLIC;

-- Low-value target (no role needs it, nothing external reaches this CT's
-- postgres directly), but a one-line addition here while touching the
-- same script.
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
