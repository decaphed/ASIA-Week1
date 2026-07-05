// ─────────────────────────────────────────────────────────────────────────
// validateReading.js — Express middleware guarding POST /api/data.
//
// Middleware is a function (req, res, next). It runs BEFORE the controller.
// If the body is invalid we short-circuit with 400 and never call next(), so
// the controller (and the database) are never reached with bad data.
// ─────────────────────────────────────────────────────────────────────────

import { validateReading } from '../utils/validation.js';

export function validateReadingMiddleware(req, res, next) {
  const errors = validateReading(req.body ?? {});

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: 'Invalid sensor data',
      details: errors,
    });
  }

  next(); // valid → hand off to the controller
}
