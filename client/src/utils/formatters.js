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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

/** Short "HH:MM" clock label for an ISO timestamp (used on hour-range charts). */
export function formatClock(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "DD MMM HH:MM" label for multi-day ranges, e.g. "05 Jul 14:30". */
export function formatDayTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return `${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Plain-English description of a bucket size in seconds, for the "Each point
 * is a …" hint under the range selector. No jargon — managers read minutes
 * and hours, not "300s buckets".
 */
export function describeBucket(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '';
  const s = Number(seconds);
  if (s < 60) return `Each point is a ${Math.round(s)}-second average`;
  if (s < 3600) {
    const m = Math.round(s / 60);
    return `Each point is a ${m}-minute average`;
  }
  const h = s / 3600;
  const label = Number.isInteger(h) ? `${h}-hour` : `${h.toFixed(1)}-hour`;
  return `Each point is a ${label} average`;
}

/** Seconds elapsed since an ISO timestamp (Infinity if missing/invalid). */
export function secondsSince(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 1000;
}
