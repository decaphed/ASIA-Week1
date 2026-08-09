// ─────────────────────────────────────────────────────────────────────────
// db.js — the shared PostgreSQL/TimescaleDB connection pool.
//
// WHY a pool, not a single connection?
//   Unlike SQLite (an embedded file), Postgres is a networked server. A pool
//   lets multiple queries run concurrently (e.g. a dashboard GET while an
//   ingest POST is in flight) without each one waiting in line behind the
//   last. Every model in the app imports THIS pool.
//
// WHY async, unlike the old better-sqlite3 db.js?
//   node-postgres (`pg`) talks to Postgres over the network, so every query
//   is inherently asynchronous. Schema/DDL is no longer applied here at
//   import time either — that is now node-pg-migrate's job
//   (`npm run migrate:up`), run explicitly, never implicitly at boot.
// ─────────────────────────────────────────────────────────────────────────

import pg from 'pg';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — see server/.env.example');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// A network DB drops connections in ways a local file never could — an
// unhandled 'error' on an idle client would otherwise crash the process.
pool.on('error', (err) => {
  logger.error(`Postgres pool error (idle client): ${err.message}`);
});

/**
 * Lightweight health probe used by GET /api/health. Runs the cheapest
 * possible query; if it throws, the database is unavailable.
 */
export async function isDatabaseHealthy() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * TIMESTAMPTZ columns come back from `pg` as JS Date objects, but the rest
 * of the codebase (pipeline.js's Date.parse calls, buffer.js's string
 * comparisons, every API response the client consumes) assumes ISO strings.
 * Models call this on every timestamp column of every row they return, so
 * the Date/string boundary is crossed in exactly one place per table.
 */
export function toIso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

logger.info('PostgreSQL/TimescaleDB pool created');

export default pool;
