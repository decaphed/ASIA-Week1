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

export const THRESHOLDS = {
  flowRate: { warnLow: 80, alarmLow: 60, warnHigh: 270, alarmHigh: 295 },
  rpm: { warnLow: 1200, alarmLow: 1050, warnHigh: 3400, alarmHigh: 3550 },
  vibration: { warnHigh: 7.1, alarmHigh: 11.2 },
  suctionPressure: { warnLow: 0.8, alarmLow: 0.6, warnHigh: 2.8, alarmHigh: 2.95 },
  dischargePressure: { warnLow: 3, alarmLow: 2.2, warnHigh: 10.5, alarmHigh: 11.5 },
  motorTemp: { warnHigh: 75, alarmHigh: 85 },
};

// The six numeric metrics, in a stable order shared by the series + summary
// responses. Kept alongside the thresholds so both features iterate the same
// canonical list.
export const SUMMARY_METRICS = [
  'flowRate',
  'rpm',
  'vibration',
  'suctionPressure',
  'dischargePressure',
  'motorTemp',
];
