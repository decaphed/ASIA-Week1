// ─────────────────────────────────────────────────────────────────────────
// processedController.js — handles POST/GET /api/processed (the one-minute
// aggregate ingested from Node-RED's preprocess_minute function node).
//
// After a successful insert, forecasting and drift detection are notified
// directly (event-driven) instead of polling on a timer — a new processed
// record IS the trigger for both, since each only arrives once per minute.
// See forecastService.onNewProcessedRecord / driftService.onNewProcessedRecord.
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/processedService.js';
import { onNewProcessedRecord as forecastOnNewRecord } from '../services/forecastService.js';
import { onNewProcessedRecord as driftOnNewRecord } from '../services/driftService.js';

export function createProcessedReading(req, res, next) {
  try {
    const record = service.saveProcessedReading(req.body);
    // forecastService/driftService read the FLAT database-row shape
    // (row.flowRateMean, row.dominantStatus — matching processedModel's
    // SELECT * rows), not the nested API shape `record` becomes above
    // (record.metrics.flowRate.mean). req.body is already flat and
    // validated, so pass that through instead of the reshaped `record`.
    forecastOnNewRecord(req.body);
    driftOnNewRecord(req.body);
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
