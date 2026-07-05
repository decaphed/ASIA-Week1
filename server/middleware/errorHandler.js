// ─────────────────────────────────────────────────────────────────────────
// errorHandler.js — centralised error + 404 handling.
//
// Express recognises a middleware with FOUR arguments (err, req, res, next) as
// an error handler. Any error thrown in a controller that calls next(err) — or
// any unmatched route — ends up here, so we format all failures as consistent
// JSON instead of leaking stack traces to the client.
// ─────────────────────────────────────────────────────────────────────────

import { logger } from '../utils/logger.js';

/** 404 handler — mounted after all routes. */
export function notFound(req, res) {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

/** Final error handler — mounted last. */
// eslint-disable-next-line no-unused-vars  (Express needs the 4-arg signature)
export function errorHandler(err, req, res, next) {
  logger.error(`${req.method} ${req.originalUrl} → ${err.message}`);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal Server Error',
  });
}
