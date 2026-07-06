// ─────────────────────────────────────────────────────────────────────────
// validateProcessed.js — Express middleware guarding POST /api/processed.
//
// Mirrors validateReading.js: reject a malformed one-minute aggregate before
// it reaches the controller/database. See utils/validation.js for the rules.
// ─────────────────────────────────────────────────────────────────────────

import { validateProcessedRecord } from '../utils/validation.js';

export function validateProcessedMiddleware(req, res, next) {
  const errors = validateProcessedRecord(req.body ?? {});

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: 'Invalid processed telemetry record',
      details: errors,
    });
  }

  next();
}
