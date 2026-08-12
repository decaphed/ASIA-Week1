// ─────────────────────────────────────────────────────────────────────────
// constants.js — metric catalogue, alarm bands, and status palette.
//
// THRESHOLDS are PORTED from server/config/thresholds.js (client and server
// do not share a module boundary). Keep the two in sync when bands change.
// ─────────────────────────────────────────────────────────────────────────

export const METRICS = [
  { key: 'flowRate', label: 'Flow Rate', short: 'FLW', unit: 'm³/h', dec: 0 },
  { key: 'rpm', label: 'Pump Speed', short: 'RPM', unit: 'RPM', dec: 0 },
  { key: 'vibration', label: 'Vibration', short: 'VIB', unit: 'mm/s', dec: 2 },
  { key: 'suctionPressure', label: 'Suction Pressure', short: 'SUC', unit: 'bar', dec: 2 },
  { key: 'dischargePressure', label: 'Discharge Pressure', short: 'DIS', unit: 'bar', dec: 2 },
  { key: 'motorTemp', label: 'Motor Temp', short: 'TMP', unit: '°C', dec: 1 },
];

export const METRIC_BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m]));

// Ported from server/config/thresholds.js — warn/alarm bands per metric.
export const THRESHOLDS = {
  flowRate: { warnLow: 80, alarmLow: 60, warnHigh: 270, alarmHigh: 295 },
  rpm: { warnLow: 1200, alarmLow: 1050, warnHigh: 3400, alarmHigh: 3550 },
  vibration: { warnHigh: 7.1, alarmHigh: 11.2 },
  suctionPressure: { warnLow: 0.8, alarmLow: 0.6, warnHigh: 2.8, alarmHigh: 2.95 },
  dischargePressure: { warnLow: 3, alarmLow: 2.2, warnHigh: 10.5, alarmHigh: 11.5 },
  motorTemp: { warnHigh: 75, alarmHigh: 85 },
};

// Status palette used across cards, chips and schematic.
//
// 'unknown' is deliberately NOT a shade of green: a channel with no reading
// must never look the same as one confirmed in-band. See statusOf().
export const SC = {
  ok: { c: '#177E4D', bg: '#E4F3EB', bd: '#bfe0cd', label: 'Normal' },
  warn: { c: '#B27400', bg: '#FBF3E0', bd: '#ecd9a8', label: 'Warning' },
  crit: { c: '#B3282D', bg: '#FBEAE8', bd: '#efc4bf', label: 'Alarm' },
  unknown: { c: '#5f6f7e', bg: '#eef1f4', bd: '#dde4ea', label: 'No data' },
};

/**
 * Classify one value against a metric's band.
 * @returns 'ok' | 'warn' | 'crit' | 'unknown'
 *
 * A missing/NaN reading returns 'unknown', never 'ok' — an absent sensor and
 * a healthy sensor must not render identically on a monitoring dashboard.
 */
export function statusOf(key, value) {
  if (value == null || Number.isNaN(value)) return 'unknown';
  const t = THRESHOLDS[key];
  if (!t) return 'ok';
  if ((t.alarmHigh != null && value >= t.alarmHigh) || (t.alarmLow != null && value <= t.alarmLow)) return 'crit';
  if ((t.warnHigh != null && value >= t.warnHigh) || (t.warnLow != null && value <= t.warnLow)) return 'warn';
  return 'ok';
}

/** True for statuses representing an actual excursion (not ok/unknown). */
export function isExcursion(status) {
  return status === 'warn' || status === 'crit';
}

// Review outcome pill palette (PENDING_REVIEW / CONFIRMED / REJECTED / DISMISSED / N/A).
export function pillFor(status) {
  if (status === 'PENDING_REVIEW') return { label: 'PENDING_REVIEW', color: '#8a5f00', bg: '#FBF3E0', border: '#ecd9a8' };
  if (status === 'CONFIRMED') return { label: 'CONFIRMED', color: '#177E4D', bg: '#E4F3EB', border: '#bfe0cd' };
  if (status === 'REJECTED') return { label: 'REJECTED', color: '#5f6f7e', bg: '#eef1f4', border: '#dde4ea' };
  if (status === 'DISMISSED') return { label: 'DISMISSED', color: '#8a99a8', bg: '#f6f8fa', border: '#e6ebf0' };
  return { label: 'N/A', color: '#8a99a8', bg: '#ffffff', border: '#dde4ea' };
}

// Fault types accepted by PATCH /api/pdm/fault-events/:id (server enum) with
// operator-friendly display labels.
export const FAULT_TYPES = [
  { value: 'CAVITATION', label: 'Cavitation' },
  { value: 'BEARING', label: 'Bearing wear' },
  { value: 'THERMAL', label: 'Motor overheating' },
  { value: 'OTHER', label: 'Other' },
];

export const FAULT_TYPE_LABEL = Object.fromEntries(FAULT_TYPES.map((f) => [f.value, f.label]));

export function fmt(v, dec = 0) {
  if (v == null || Number.isNaN(v)) return '—';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
