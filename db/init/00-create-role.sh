#!/bin/sh
# 00-create-role.sh — creates the pdm_app application role.
#
# Must be a .sh, not a .sql: docker-entrypoint-initdb.d does NOT perform
# environment-variable substitution on .sql files (plain SQL has no `$VAR`
# interpolation mechanism — psql's own variable syntax is `:name`, driven
# by `\set`, not shell env vars). A .sh script is sourced/executed by the
# container's shell, which DOES expand `$PDM_APP_PASSWORD` before the
# heredoc is piped into psql. Runs before 01-init-pump-telemetry.sql
# (alphabetical order).
#
# CREATE ROLE with no extra attributes deliberately leaves pdm_app
# NOSUPERUSER / NOCREATEDB / NOCREATEROLE / NOREPLICATION / NOBYPASSRLS
# (all Postgres defaults) — this is an application role for a single
# dedicated database, not an admin role, and needs none of those.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  CREATE ROLE pdm_app LOGIN PASSWORD '$PDM_APP_PASSWORD';
EOSQL
