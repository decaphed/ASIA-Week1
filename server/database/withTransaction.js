// ─────────────────────────────────────────────────────────────────────────
// withTransaction.js — explicit BEGIN/COMMIT/ROLLBACK helper.
//
// better-sqlite3 had a built-in db.transaction() wrapper; `pg` has no direct
// equivalent because a transaction is scoped to one checked-out client, not
// the pool. This helper is that missing piece: check out a client, run the
// caller's function against it, commit on success, roll back and rethrow on
// failure, always release the client back to the pool.
// ─────────────────────────────────────────────────────────────────────────

import pool from './db.js';

export async function withTransaction(fn) {
  const client = await pool.connect();
  let releaseErr;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    releaseErr = err;
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection may already be dead (e.g. the error that triggered
      // this catch was itself a connection failure) — release(err) below
      // still destroys the client instead of recycling it either way.
    }
    throw err;
  } finally {
    // Passing the error forces pg to destroy this client instead of
    // returning it to the pool — a connection that failed mid-transaction
    // may be left in an indeterminate state, and recycling it could hand a
    // broken connection to a later, unrelated query.
    client.release(releaseErr);
  }
}
