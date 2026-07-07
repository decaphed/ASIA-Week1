// ─────────────────────────────────────────────────────────────────────────
// routes/index.js — maps URLs to controllers.
//
// A Router is a mini Express app. app.js mounts this at "/api", so the paths
// below become /api/data, /api/live, etc. This file is the one place to see
// the whole API surface at a glance.
// ─────────────────────────────────────────────────────────────────────────

import { Router } from 'express';

import { createReading } from '../controllers/dataController.js';
import { getLive } from '../controllers/liveController.js';
import { getHistory } from '../controllers/historyController.js';
import { getStats } from '../controllers/statsController.js';
import { getHealth } from '../controllers/healthController.js';
import { getForecast } from '../controllers/forecastController.js';
import { getDrift } from '../controllers/driftController.js';
import { getTrend } from '../controllers/trendController.js';
import { createProcessedReading, getProcessedLive, getProcessedHistory } from '../controllers/processedController.js';
import { validateReadingMiddleware } from '../middleware/validateReading.js';
import { validateProcessedMiddleware } from '../middleware/validateProcessed.js';

const router = Router();

// Ingestion + preprocessing entry point. validateReadingMiddleware runs
// first (hard reject on malformed shape); createReading then runs the full
// preprocessing pipeline (preprocessing/pipeline.js) on every valid body.
router.post('/data', validateReadingMiddleware, createReading);

// One-minute aggregate ingestion. Manual/back-compat path now that the
// preprocessing pipeline produces and stores processed records itself —
// validateProcessedMiddleware guards the same way /data does.
router.post('/processed', validateProcessedMiddleware, createProcessedReading);

// Retrieval.
router.get('/live', getLive);
router.get('/history', getHistory);
router.get('/stats', getStats);
router.get('/health', getHealth);
router.get('/forecast', getForecast);
router.get('/drift', getDrift);
router.get('/trend', getTrend);
router.get('/processed', getProcessedHistory);
router.get('/processed/live', getProcessedLive);

export default router;
