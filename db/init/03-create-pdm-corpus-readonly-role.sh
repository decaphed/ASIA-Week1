#!/bin/sh
# 03-create-pdm-corpus-readonly-role.sh — creates the read-only role
# pdm/app/corpus.py connects as (§10.5, §10.6 item 2's resolution: Python
# gets a read-only role against the same database for the batch/training
# path — the live per-window /score path's "no DB access at all"
# restriction is unaffected, this is a narrower, additive exception).
#
# Must be a .sh, not a .sql — same reason as 00-create-role.sh: .sql files
# get no environment-variable substitution from docker-entrypoint-initdb.d,
# only a shell script does.
#
# Only CREATE ROLE + database/schema-level grants happen here — NOT
# `GRANT SELECT ON training_corpus`. That table doesn't exist yet at
# container-init time: unlike raw_telemetry/processed_telemetry
# (01-init-pump-telemetry.sql, applied directly in docker-entrypoint-
# initdb.d), training_corpus is created later by a node-pg-migrate
# migration (005_training_corpus.sql), run separately after the container
# is up. Granting SELECT on a table that doesn't exist yet would fail this
# script outright. The table-level grant lives in that migration's Up
# Migration instead, after its CREATE TABLE — see that file.
#
# Deliberately no grant on fault_events, raw_telemetry, processed_telemetry,
# or training_runs (the champion lookup training_runs would otherwise need
# is looked up by Node and passed into pdm/app/retrain.py's run_retrain(),
# so Python never queries training_runs directly — see that function's
# docstring). No INSERT/UPDATE/DELETE grant on anything, ever: Python never
# writes application data (§3.4's invariant, unchanged by this role's
# existence).
#
# NOTE for an already-initialized Postgres volume (docker-entrypoint-
# initdb.d only runs on a FRESH volume's first boot): this script will not
# retroactively apply to an existing deployment. Run the same CREATE
# ROLE/GRANT statements by hand via psql against an existing instance —
# see this session's notes for the exact one-off commands.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  CREATE ROLE pdm_corpus_readonly LOGIN PASSWORD '$PDM_CORPUS_READONLY_PASSWORD';
  GRANT CONNECT ON DATABASE pump_telemetry TO pdm_corpus_readonly;
  GRANT USAGE ON SCHEMA public TO pdm_corpus_readonly;
EOSQL
