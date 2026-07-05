// ─────────────────────────────────────────────────────────────────────────
// formatters.js — small, pure display helpers.
//
// Keeping formatting in one place means numbers, dates and "N seconds ago"
// look consistent everywhere and every function safely handles null/undefined
// (which happens before the first reading arrives or when the backend is down).
// ─────────────────────────────────────────────────────────────────────────

/** Fixed-decimal number, or "--" when there's nothing to show. */
export function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  return Number(value).toFixed(digits);
}

/** Local time only, e.g. "10:00:00 AM". */
export function formatTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--' : d.toLocaleTimeString();
}

/** Local date + time, e.g. "7/5/2026, 10:00:00 AM". */
export function formatDateTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--' : d.toLocaleString();
}

/** Seconds elapsed since an ISO timestamp (Infinity if missing/invalid). */
export function secondsSince(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 1000;
}
