// ─────────────────────────────────────────────────────────────────────────
// server.js — the entry point.
//
// Responsibilities:
//   1. Load environment variables from .env (dotenv) — MUST be first so that
//      db.js sees DB_PATH when it initialises.
//   2. Create the Express app.
//   3. Start listening.
//
// Importing app.js triggers the whole dependency chain
// (routes → controllers → services → model → db.js), so by the time we listen
// the database file and table already exist.
// ─────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { createApp } from './app.js';
import { logger } from './utils/logger.js';
import { startForecastLoop } from './services/forecastService.js';
import { startDriftLoop } from './services/driftService.js';
import { startTrendLoop } from './services/trendService.js';

const PORT = process.env.PORT || 3000;
const app = createApp();

app.listen(PORT, () => {
  logger.info(`Backend listening on http://localhost:${PORT}`);
  logger.info('Endpoints: POST /api/data /api/processed | GET /api/live /api/history /api/stats /api/health /api/forecast /api/drift /api/trend /api/processed /api/processed/live');
  startForecastLoop();
  startDriftLoop();
  startTrendLoop();
});
