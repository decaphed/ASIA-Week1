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
import { getSeries } from '../controllers/seriesController.js';
import { getSummary } from '../controllers/summaryController.js';
import { getStats } from '../controllers/statsController.js';
import { getHealth } from '../controllers/healthController.js';
import { getForecast } from '../controllers/forecastController.js';
import { getDrift } from '../controllers/driftController.js';
import { getTrend } from '../controllers/trendController.js';
import { createProcessedReading, getProcessedLive, getProcessedHistory } from '../controllers/processedController.js';
import { listFaultEvents, getFaultEvent, reviewFaultEvent, getFaultEventStats, exportFaultEventBuffers } from '../controllers/pdmController.js';
import { getWhoami } from '../controllers/whoamiController.js';
import { validateReadingMiddleware } from '../middleware/validateReading.js';
import { validateProcessedMiddleware } from '../middleware/validateProcessed.js';
import { requireGroup, requireTrustedProxy } from '../middleware/authentikIdentity.js';
import { rateLimit } from '../middleware/rateLimit.js';

// Authentik group allowed to submit HITL fault-event reviews (§3.6). Only
// enforced for requests that actually carry an Authentik identity — see
// middleware/authentikIdentity.js for why direct/dev access isn't blocked.
const PDM_REVIEWER_GROUP = process.env.PDM_REVIEWER_GROUP || 'pdm-reviewers';

const router = Router();

// Ingestion + preprocessing entry point. validateReadingMiddleware runs
// first (hard reject on malformed shape); createReading then runs the full
// preprocessing pipeline (preprocessing/pipeline.js) on every valid body.
router.post('/data', rateLimit, validateReadingMiddleware, createReading);

// One-minute aggregate ingestion. Manual/back-compat path now that the
// preprocessing pipeline produces and stores processed records itself —
// validateProcessedMiddleware guards the same way /data does.
router.post('/processed', rateLimit, validateProcessedMiddleware, createProcessedReading);

// Retrieval. requireTrustedProxy on every one of these except /health (see
// its comment in middleware/authentikIdentity.js — Docker's own container-
// internal HEALTHCHECK curl can never carry the proxy secret) — without it,
// any container reachable on the `edge` network (e.g. node-red) could read
// all of this with no credentials, since none of these previously checked
// identity at all.
router.get('/live', requireTrustedProxy, getLive);
// Register the more specific /history/series before the /history page route.
// Both are exact paths so Express 4 wouldn't actually shadow one with the
// other, but ordering specific-before-generic keeps the intent obvious.
router.get('/history/series', requireTrustedProxy, getSeries);
router.get('/history', requireTrustedProxy, getHistory);
router.get('/summary', requireTrustedProxy, getSummary);
router.get('/stats', requireTrustedProxy, getStats);
router.get('/health', getHealth);
router.get('/whoami', getWhoami);
router.get('/forecast', requireTrustedProxy, getForecast);
router.get('/drift', requireTrustedProxy, getDrift);
router.get('/trend', requireTrustedProxy, getTrend);
router.get('/processed', requireTrustedProxy, getProcessedHistory);
router.get('/processed/live', requireTrustedProxy, getProcessedLive);

// PdM HITL review endpoints (§3.6). /stats and /export/csv are registered
// before the /:id routes so Express doesn't try to parse "stats"/"export"
// as an :id param.
router.get('/pdm/fault-events/stats', requireTrustedProxy, getFaultEventStats);
router.get('/pdm/fault-events/export/csv', requireTrustedProxy, exportFaultEventBuffers);
router.get('/pdm/fault-events/:id', requireTrustedProxy, getFaultEvent);
router.get('/pdm/fault-events', requireTrustedProxy, listFaultEvents);
router.patch('/pdm/fault-events/:id', requireTrustedProxy, requireGroup(PDM_REVIEWER_GROUP), reviewFaultEvent);

export default router;
