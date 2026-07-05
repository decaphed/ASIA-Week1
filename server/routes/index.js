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
import { validateReadingMiddleware } from '../middleware/validateReading.js';

const router = Router();

// Ingestion. validateReadingMiddleware runs first; only valid bodies reach
// createReading.
router.post('/data', validateReadingMiddleware, createReading);

// Retrieval.
router.get('/live', getLive);
router.get('/history', getHistory);
router.get('/stats', getStats);
router.get('/health', getHealth);
router.get('/forecast', getForecast);

export default router;
