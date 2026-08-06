// ─────────────────────────────────────────────────────────────────────────
// api.js — the SINGLE place the frontend talks to the backend.
//
// WHY centralise HTTP here?
//   If fetch()/axios calls were scattered across components, changing the base
//   URL, adding auth headers, or handling errors would mean editing many
//   files. With one service module, every component imports these functions
//   and never knows the URLs. This is the "service layer" pattern.
//
// Each function returns just the meaningful part of the response so components
// don't have to dig through the { success, data } envelope.
// ─────────────────────────────────────────────────────────────────────────

import axios from 'axios';

// import.meta.env is how Vite exposes environment variables to the browser.
const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

// A pre-configured axios instance: shared base URL + a timeout so a dead
// backend fails fast (and our hooks can show an offline banner) instead of
// hanging forever.
const client = axios.create({
  baseURL: BASE_URL,
  timeout: 8000,
});

/** GET /api/live → the latest reading object, or null if none yet. */
export async function getLive() {
  const res = await client.get('/live');
  return res.data.data;
}

/** GET /api/history → { page, limit, total, totalPages, data: [...] }. */
export async function getHistory({ page = 1, limit = 100, sort = 'desc' } = {}) {
  const res = await client.get('/history', { params: { page, limit, sort } });
  return res.data;
}

/** GET /api/stats → aggregate stats object (+ apiLatencyMs). */
export async function getStats() {
  const res = await client.get('/stats');
  return res.data.data;
}

/** GET /api/health → the raw health object (status, database, lastReadingAt…). */
export async function getHealth() {
  const res = await client.get('/health');
  return res.data;
}

/** GET /api/forecast → per-metric { level, trend, forecast, lowerBound, upperBound } (or null). */
export async function getForecast() {
  const res = await client.get('/forecast');
  return res.data.data;
}

/** GET /api/drift → per-metric { direction, z, referenceMean, recentMean, delta } (or null). */
export async function getDrift() {
  const res = await client.get('/drift');
  return res.data.data;
}

/** GET /api/trend → per-metric { direction, magnitude, label, slopePerMin, rangePct, z, significant } (or null). */
export async function getTrend() {
  const res = await client.get('/trend');
  return res.data.data;
}

/** GET /api/processed/live → the latest one-minute aggregate (quality/imputation info), or null. */
export async function getProcessedLive() {
  const res = await client.get('/processed/live');
  return res.data.data;
}

/** GET /api/processed?page&limit&sort → { page, limit, total, totalPages, data: [...] } — 1-minute aggregates. */
export async function getProcessedHistory({ page = 1, limit = 100, sort = 'desc' } = {}) {
  const res = await client.get('/processed', { params: { page, limit, sort } });
  return res.data;
}

/** GET /api/history/series?range → { range, bucketSeconds, points: [...] } — bucketed historical trend. */
export async function getSeries(range) {
  const res = await client.get('/history/series', { params: { range } });
  return res.data.data;
}

/** GET /api/summary?range → { range, from, to, sampleCount, availabilityPct, runHours, excursions, perSensor }. */
export async function getSummary(range) {
  const res = await client.get('/summary', { params: { range } });
  return res.data.data;
}

/** POST /api/data → store a reading. (Handy for manual testing from the UI.) */
export async function postReading(reading) {
  const res = await client.post('/data', reading);
  return res.data;
}

/** GET /pdm/fault-events?status → array of fault_events rows (all rows, including NEGATIVE_SAMPLE, when status is omitted). */
export async function getFaultEvents(status) {
  const res = await client.get('/pdm/fault-events', { params: status ? { status } : undefined });
  return res.data.data;
}

/** GET /pdm/fault-events/:id → one fault_events row + a computed bufferSampleCount. */
export async function getFaultEvent(id) {
  const res = await client.get(`/pdm/fault-events/${id}`);
  return res.data.data;
}

/**
 * PATCH /pdm/fault-events/:id → apply a HITL review decision. Returns the
 * fully updated row (server computes bufferEnd/reviewedAt).
 * IMPORTANT: the backend merges each field via `patch.x ?? existing.x` —
 * `undefined` PRESERVES the existing value, but `''` OVERWRITES it with an
 * empty string. Callers must omit untouched/empty optional fields from
 * `patch` entirely rather than sending `null`/`''`, or a prior decision's
 * field gets silently blanked. Unused until Phase 2's review form.
 */
export async function reviewFaultEvent(id, patch) {
  const res = await client.patch(`/pdm/fault-events/${id}`, patch);
  return res.data.data;
}

/** GET /pdm/fault-events/stats → confidence×status breakdown. Unused until the Phase 4 analytics view. */
export async function getFaultEventStats() {
  const res = await client.get('/pdm/fault-events/stats');
  return res.data.data;
}

export default client;
