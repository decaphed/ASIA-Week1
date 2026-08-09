// ─────────────────────────────────────────────────────────────────────────
// server.js — the entry point.
//
// Responsibilities:
//   1. Load environment variables from .env (dotenv) — MUST be first so that
//      db.js sees DATABASE_URL when it initialises the connection pool.
//   2. Create the Express app.
//   3. Start listening.
//
// Importing app.js triggers the whole dependency chain
// (routes → controllers → services → model → db.js), so the pool exists by
// the time we listen. Schema DOES NOT exist automatically, though — unlike
// the old SQLite db.js, migrations are an explicit `npm run migrate:up`
// step, never run implicitly at import/boot.
// ─────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { createApp } from './app.js';
import { logger } from './utils/logger.js';
import { assertRangeConsistency } from './utils/rangeConsistency.js';
import { startForecastLoop } from './services/forecastService.js';
import { startDriftLoop } from './services/driftService.js';
import { startTrendLoop } from './services/trendService.js';
import { runBackgroundSweep } from './preprocessing/pipeline.js';
import { LATE_GRACE_SECONDS, WINDOW_DURATION_SECONDS } from './preprocessing/config.js';

// Fail fast, before accepting any traffic, if the three hand-maintained
// range tables (RANGES / OPERATING_RANGE / THRESHOLDS) have drifted out of
// their required nesting — see rangeConsistency.js for why.
assertRangeConsistency();

const PORT = process.env.PORT || 3000;
const app = createApp();

app.listen(PORT, async () => {
  logger.info(`Backend listening on http://localhost:${PORT}`);
  logger.info('Endpoints: POST /api/data /api/processed | GET /api/live /api/history /api/stats /api/health /api/forecast /api/drift /api/trend /api/processed /api/processed/live');
  await startForecastLoop();
  await startDriftLoop();
  await startTrendLoop();

  // Guarantees an event-time window closes even during total stream
  // silence, since ingestion (preprocessing/buffer.js) is otherwise entirely
  // push-driven and would never force-close a window on its own.
  //
  // runBackgroundSweep() is async now (Postgres, not synchronous SQLite),
  // but setInterval's callback isn't awaited by the runtime — an unwrapped
  // rejection here would be an unhandled promise rejection. The lock inside
  // runBackgroundSweep() (see preprocessing/ingestLock.js) already prevents
  // it from overlapping with itself or with ingestion; this wrapper only
  // handles the "nothing catches a rejected async callback" gap.
  const sweepIntervalMs = (Math.min(WINDOW_DURATION_SECONDS, LATE_GRACE_SECONDS) / 2) * 1000;
  setInterval(() => {
    runBackgroundSweep().catch((err) => logger.error(`Background sweep failed: ${err.stack || err.message}`));
  }, sweepIntervalMs);
});
