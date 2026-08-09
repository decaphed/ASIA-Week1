// ─────────────────────────────────────────────────────────────────────────
// ingestLock.js — promise-chain mutex serializing pipeline.js's two public
// entry points, processSample() and runBackgroundSweep().
//
// WHY this exists: processSample() reads buffer.js's getLastSample() at the
// top, then (through ingestSample()) eventually calls commit(), which
// mutates that same buffer state — with nothing awaited in between under
// the old synchronous better-sqlite3 code. Now that DB calls are async,
// nothing stops two concurrent POST /api/data requests (or a request
// racing a background sweep) from interleaving those reads/writes, which
// would silently corrupt window boundaries or duplicate fill rows. Wrapping
// both entry points in the SAME lock instance makes every call — ingest or
// sweep — strictly one-at-a-time, restoring the ordering guarantee the
// pipeline was designed around.
// ─────────────────────────────────────────────────────────────────────────

let tail = Promise.resolve();

/**
 * Runs `fn` only after every previously-queued withLock() call has settled.
 * Rejections are swallowed on the internal chain (not on the caller's
 * returned promise) so one failed call doesn't permanently wedge the lock
 * for everyone queued after it.
 */
export function withLock(fn) {
  const run = tail.then(() => fn());
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
