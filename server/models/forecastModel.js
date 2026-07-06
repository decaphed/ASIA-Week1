// ─────────────────────────────────────────────────────────────────────────
// forecastModel.js — thin adapter over processedModel.js for
// forecastService/driftService.
//
// Forecasting and drift detection both need "the last n telemetry rows,
// newest first" — but as of the preprocessing pipeline, their input is
// processed_telemetry (one quality-scored aggregate per minute), not the
// raw 1 Hz stream. processedModel.js already owns the prepared statement for
// that query (getRecentProcessed), so this file delegates to it instead of
// duplicating a second "SELECT * ... ORDER BY id DESC LIMIT ?" against the
// same table. The getRecentReadings name is kept so forecastService.js and
// driftService.js don't need to change their call sites.
// ─────────────────────────────────────────────────────────────────────────

import { getRecentProcessed } from './processedModel.js';

/** @returns an array of up to n processed (one-minute aggregate) rows, newest first (id DESC). */
export function getRecentReadings(n) {
  return getRecentProcessed(n);
}
