// ─────────────────────────────────────────────────────────────────────────
// api/client.js — thin fetch wrapper over the backend REST API.
//
// Every endpoint responds with the { success, data } envelope (or
// { success:false, error, details } on failure) — unwrap here so pages
// deal in plain payloads.
// ─────────────────────────────────────────────────────────────────────────

const BASE = import.meta.env.VITE_API_URL || '/api';

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON response (proxy error page etc.) — fall through to the check
  }
  if (!res.ok || (body && body.success === false)) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.details = body?.details;
    throw err;
  }
  return body;
}

// Multipart upload needs its own fetch call — request()'s default
// Content-Type: application/json / JSON.stringify body would break a CSV
// upload; FormData needs the browser to set its own multipart boundary.
async function uploadRequest(path, file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(BASE + path, { method: 'POST', body: form });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON response — fall through to the check below
  }
  if (!res.ok || (body && body.success === false)) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.details = body;
    throw err;
  }
  return body;
}

export const api = {
  live: () => request('/live'),
  health: () => request('/health'),
  stats: () => request('/stats'),
  series: (range = '24h') => request(`/history/series?range=${encodeURIComponent(range)}`),
  summary: (range = '24h') => request(`/summary?range=${encodeURIComponent(range)}`),
  forecast: () => request('/forecast'),
  trend: () => request('/trend'),
  drift: () => request('/drift'),
  whoami: () => request('/whoami'),
  faultEvents: (status) =>
    request(`/pdm/fault-events${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  faultEvent: (id) => request(`/pdm/fault-events/${id}`),
  faultEventStats: () => request('/pdm/fault-events/stats'),
  reviewFaultEvent: (id, patch) =>
    request(`/pdm/fault-events/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  postReading: (reading) =>
    request('/data', { method: 'POST', body: JSON.stringify(reading) }),
  // A plain URL, not a fetch() call — this one is meant for a browser
  // download (<a href>), which streams the CSV/triggers Content-Disposition
  // directly rather than being parsed as JSON through request().
  faultEventBufferCsvUrl: (status) =>
    `${BASE}/pdm/fault-events/export/csv${status ? `?status=${encodeURIComponent(status)}` : ''}`,
  uploadTrainingCsv: (file) => uploadRequest('/pdm/training/upload', file),
  fitTrainingCandidate: (uploadId) =>
    request(`/pdm/training/${encodeURIComponent(uploadId)}/fit`, { method: 'POST', headers: {}, body: undefined }),
  deployTrainingCandidate: (uploadId) =>
    request(`/pdm/training/${encodeURIComponent(uploadId)}/deploy`, { method: 'POST', headers: {}, body: undefined }),
  discardTrainingCandidate: (uploadId) =>
    request(`/pdm/training/${encodeURIComponent(uploadId)}`, { method: 'DELETE', headers: {}, body: undefined }),
  resetTrainingModel: () => request('/pdm/training/reset', { method: 'POST', headers: {}, body: undefined }),
  trainingRuns: () => request('/pdm/training/runs'),
};
