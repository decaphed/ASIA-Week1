// ─────────────────────────────────────────────────────────────────────────
// thresholds.js — per-metric warn/alarm bands for the management summary.
//
// These mirror the client's alarm configuration (client/src/utils/constants.js
// SENSORS alarm bands) so the server-side excursion tally in summaryService.js
// agrees with what the dashboard paints. Client and server do not share a
// module boundary, so — like OPERATING_RANGE in trendService.js and RANGES in
// preprocessing/validator.js — the values are PORTED here, not imported.
//
// Convention: a value is
//   • "alarm" when it is >= alarmHigh or <= alarmLow,
//   • "warn"  when it is >= warnHigh or <= warnLow (and not already alarm).
// Metrics without a physically-meaningful low bound (vibration, motorTemp)
// simply omit warnLow/alarmLow; the classifier treats absent bounds as
// "never triggered on that side".
// ─────────────────────────────────────────────────────────────────────────

// Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
// migration.md Phase 3. warnLow/warnHigh = Phase 0 p5/p95; alarmLow/alarmHigh
// = Phase 0 p1/p99 (docs/analysis/2026-08-26-train-csv-characterization.md)
// — alarm bounds equal trendService.js's OPERATING_RANGE boundary exactly,
// satisfying rangeConsistency.js's nesting requirement by construction.
export const THRESHOLDS = {
  engineRpm: { warnLow: 444, alarmLow: 382, warnHigh: 1322.65, alarmHigh: 1565 },
  lubOilPressure: { warnLow: 1.939, alarmLow: 0.858, warnHigh: 5.064, alarmHigh: 5.605 },
  fuelPressure: { warnLow: 3.112, alarmLow: 1.396, warnHigh: 12.200, alarmHigh: 16.161 },
  coolantPressure: { warnLow: 1.084, alarmLow: 0.723, warnHigh: 4.458, alarmHigh: 5.950 },
  lubOilTemperature: { warnLow: 74.268, alarmLow: 73.413, warnHigh: 84.978, alarmHigh: 87.350 },
  coolantTemperature: { warnLow: 68.404, alarmLow: 65.740, warnHigh: 88.636, alarmHigh: 91.780 },
};

// The six numeric metrics, in a stable order shared by the series + summary
// responses. Kept alongside the thresholds so both features iterate the same
// canonical list.
export const SUMMARY_METRICS = [
  'engineRpm',
  'lubOilPressure',
  'fuelPressure',
  'coolantPressure',
  'lubOilTemperature',
  'coolantTemperature',
];
