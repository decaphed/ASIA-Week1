#!/bin/sh
# 02-create-authentik-db.sh — creates the authentik_svc role and authentik_db
# database for Authentik SSO (docs/plan/2026-08-09-authentik-split-ct.md §5.1).
#
# Must be a .sh, not a .sql: docker-entrypoint-initdb.d does NOT perform
# environment-variable substitution on .sql files (plain SQL has no `$VAR`
# interpolation mechanism — psql's own variable syntax is `:name`, driven
# by `\set`, not shell env vars). A .sh script is sourced/executed by the
# container's shell, which DOES expand `$AUTHENTIK_PG_PASSWORD` before the
# heredoc is piped into psql. Runs after 00-create-role.sh and
# 01-init-pump-telemetry.sql (alphabetical order); order doesn't matter
# here since this script touches neither pdm_app nor pump_telemetry.
#
# One script, not a .sh + .sql split (contrast 00/01): that split exists
# only because pump_telemetry needs a superuser-only `CREATE EXTENSION`
# step between role creation and ownership transfer. Authentik has no
# time-series tables and needs no extension — deliberately NOT
# `CREATE EXTENSION timescaledb`, to avoid widening its blast radius — so
# splitting role creation from database creation here would be
# cargo-culting.
#
# CREATE ROLE with no extra attributes deliberately leaves authentik_svc
# NOSUPERUSER / NOCREATEDB / NOCREATEROLE / NOREPLICATION / NOBYPASSRLS
# (all Postgres defaults) — this is an application role for a single
# dedicated database, not an admin role, and needs none of those.
#
# *** THIS SCRIPT WILL NOT RUN ON THE LIVE pdm-db INSTANCE. ***
# /docker-entrypoint-initdb.d/ only fires on first initialization of a
# fresh volume, and pdm_db_data already exists. This script is committed so
# a from-scratch rebuild is correct and reproducible; for the live
# instance, apply the equivalent SQL by hand — see
# docs/runbook/authentik-operations.md ("Manual database provisioning").
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  CREATE ROLE authentik_svc LOGIN PASSWORD '$AUTHENTIK_PG_PASSWORD';
  CREATE DATABASE authentik_db OWNER authentik_svc;
EOSQL
