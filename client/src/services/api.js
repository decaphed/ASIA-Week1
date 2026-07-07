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

/** POST /api/data → store a reading. (Handy for manual testing from the UI.) */
export async function postReading(reading) {
  const res = await client.post('/data', reading);
  return res.data;
}

export default client;
