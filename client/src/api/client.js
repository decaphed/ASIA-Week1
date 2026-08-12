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
};
