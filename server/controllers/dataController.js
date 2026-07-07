// ─────────────────────────────────────────────────────────────────────────
// dataController.js — handles POST /api/data (ingestion from Node-RED).
//
// Controllers are the HTTP layer: read the request, call the service, shape
// the response. No SQL, no business rules — those live in the service/model.
// Errors are forwarded to the central error handler via next(err).
//
// This is the preprocessing pipeline's entry point (see
// preprocessing/pipeline.js): every request runs physics validation,
// buffering, and — once every 60 samples — aggregation/quality scoring and
// forecast/drift triggers, not just a raw insert.
// ─────────────────────────────────────────────────────────────────────────

import { processSample } from '../preprocessing/index.js';

export function createReading(req, res, next) {
  try {
    // Body was already validated by validateReadingMiddleware.
    const reading = processSample(req.body);
    res.status(201).json({ success: true, data: reading });
  } catch (err) {
    next(err);
  }
}
