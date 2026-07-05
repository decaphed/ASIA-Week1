// ─────────────────────────────────────────────────────────────────────────
// dataController.js — handles POST /api/data (ingestion from Node-RED).
//
// Controllers are the HTTP layer: read the request, call the service, shape
// the response. No SQL, no business rules — those live in the service/model.
// Errors are forwarded to the central error handler via next(err).
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/sensorService.js';

export function createReading(req, res, next) {
  try {
    // Body was already validated by validateReadingMiddleware.
    const reading = service.saveReading(req.body);
    res.status(201).json({ success: true, data: reading });
  } catch (err) {
    next(err);
  }
}
