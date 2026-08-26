// ─────────────────────────────────────────────────────────────────────────
// constants.js — metric catalogue, alarm bands, and status palette.
//
// THRESHOLDS are PORTED from server/config/thresholds.js (client and server
// do not share a module boundary). Keep the two in sync when bands change.
// ─────────────────────────────────────────────────────────────────────────

// Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
// migration.md Phase 7. engineRpm's label is "Engine Rpm" (title case, not
// all-caps "RPM") per the user's explicit naming decision (plan §12 Q4);
// the other five labels are the plain-English names from plan §2. Units for
// the three pressures and two temperatures are ASSUMED (bar / degC) —
// data/train.csv does not label units for any non-RPM column (plan §2.2).
export const METRICS = [
  { key: 'engineRpm', label: 'Engine Rpm', short: 'RPM', unit: 'RPM', dec: 0 },
  { key: 'lubOilPressure', label: 'Lube Oil Pressure', short: 'OIL-P', unit: 'bar', dec: 2 },
  { key: 'fuelPressure', label: 'Fuel Pressure', short: 'FUEL-P', unit: 'bar', dec: 2 },
  { key: 'coolantPressure', label: 'Coolant Pressure', short: 'CLT-P', unit: 'bar', dec: 2 },
  { key: 'lubOilTemperature', label: 'Lube Oil Temperature', short: 'OIL-T', unit: '°C', dec: 1 },
  { key: 'coolantTemperature', label: 'Coolant Temperature', short: 'CLT-T', unit: '°C', dec: 1 },
];

export const METRIC_BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m]));

// Ported from server/config/thresholds.js — warn/alarm bands per metric.
// Values are the Phase 0 p5/p95 (warn) and p1/p99 (alarm) bands from
// docs/analysis/2026-08-26-train-csv-characterization.md, not hand-guessed.
export const THRESHOLDS = {
  engineRpm: { warnLow: 444, alarmLow: 382, warnHigh: 1322.65, alarmHigh: 1565 },
  lubOilPressure: { warnLow: 1.939, alarmLow: 0.858, warnHigh: 5.064, alarmHigh: 5.605 },
  fuelPressure: { warnLow: 3.112, alarmLow: 1.396, warnHigh: 12.200, alarmHigh: 16.161 },
  coolantPressure: { warnLow: 1.084, alarmLow: 0.723, warnHigh: 4.458, alarmHigh: 5.950 },
  lubOilTemperature: { warnLow: 74.268, alarmLow: 73.413, warnHigh: 84.978, alarmHigh: 87.350 },
  coolantTemperature: { warnLow: 68.404, alarmLow: 65.740, warnHigh: 88.636, alarmHigh: 91.780 },
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
  if (status === 'PENDING_REVIEW') return { label: 'Pending Review', color: '#8a5f00', bg: '#FBF3E0', border: '#ecd9a8' };
  if (status === 'CONFIRMED') return { label: 'Confirmed', color: '#177E4D', bg: '#E4F3EB', border: '#bfe0cd' };
  if (status === 'REJECTED') return { label: 'Rejected', color: '#5f6f7e', bg: '#eef1f4', border: '#dde4ea' };
  if (status === 'DISMISSED') return { label: 'Dismissed', color: '#8a99a8', bg: '#f6f8fa', border: '#e6ebf0' };
  return { label: 'N/A', color: '#8a99a8', bg: '#ffffff', border: '#dde4ea' };
}

// Shown next to the status pill for events auto-labeled from a prior human
// review (fault_events.autoLabeled) — keeps them distinguishable from an
// actual human confirmation at a glance, even though both render CONFIRMED.
export const AUTO_LABEL_BADGE = { label: 'Auto', color: '#5f6f7e', bg: '#eef1f4', border: '#dde4ea' };

// Fault types accepted by PATCH /api/pdm/fault-events/:id (server enum) with
// operator-friendly display labels. Migrated pump -> engine failure modes
// per docs/plan/2026-08-26-pump-to-engine-migration.md §4.2 — engineering
// judgment, not derived from data/train.csv, which carries no fault-type
// supervision at all (plan §3).
export const FAULT_TYPES = [
  { value: 'OIL_PRESSURE_LOSS', label: 'Oil pressure loss' },
  { value: 'COOLANT_OVERHEAT', label: 'Coolant overheat' },
  { value: 'COOLANT_LOSS', label: 'Coolant loss' },
  { value: 'FUEL_STARVATION', label: 'Fuel starvation' },
  { value: 'OVERSPEED', label: 'Engine overspeed' },
  { value: 'OIL_DEGRADATION', label: 'Oil degradation' },
  { value: 'THERMOSTAT_STUCK', label: 'Thermostat stuck' },
  { value: 'OTHER', label: 'Other' },
];

export const FAULT_TYPE_LABEL = Object.fromEntries(FAULT_TYPES.map((f) => [f.value, f.label]));

export function fmt(v, dec = 0) {
  if (v == null || Number.isNaN(v)) return '—';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
