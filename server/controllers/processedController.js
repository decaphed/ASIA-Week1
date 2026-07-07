// ─────────────────────────────────────────────────────────────────────────
// processedController.js — handles POST/GET /api/processed.
//
// POST is now a manual/back-compat ingestion path: the preprocessing
// pipeline (preprocessing/pipeline.js) is what normally produces processed
// records once every 60 samples of POST /api/data, storing them and
// triggering forecast/drift itself. This endpoint shares that exact same
// save+trigger sequence via processedService.saveAndTrigger, so there is
// still only one place forecasting/drift detection get notified from.
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/processedService.js';

export function createProcessedReading(req, res, next) {
  try {
    // req.body is already flat and validated — the same flat shape
    // forecastService/driftService read (row.flowRateMean, row.dominantStatus).
    const record = service.saveAndTrigger(req.body);
    res.status(201).json({ success: true, data: record });
  } catch (err) {
    next(err);
  }
}

export function getProcessedLive(req, res, next) {
  try {
    const record = service.getLatestProcessedReading();
    if (!record) {
      return res.json({ success: true, data: null, message: 'No processed records yet' });
    }
    res.json({ success: true, data: record });
  } catch (err) {
    next(err);
  }
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export function getProcessedHistory(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const sort = req.query.sort === 'asc' ? 'asc' : 'desc';

    const result = service.getProcessedHistoryPage({ page, limit, sort });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}
