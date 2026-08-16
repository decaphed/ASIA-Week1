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
  const status = err.status || 500;
  // 5xx means something we didn't anticipate — don't echo err.message back
  // to the client, since a raw DB/FS error could leak internal detail.
  // Below 500 (validation etc.) err.message is our own deliberate text.
  const message = status >= 500 ? 'Internal Server Error' : err.message || 'Bad Request';
  res.status(status).json({ success: false, error: message });
}
