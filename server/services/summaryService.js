// ─────────────────────────────────────────────────────────────────────────
// summaryService.js — computation behind GET /api/summary and the
// downsampled series behind GET /api/history/series.
//
// Both features share a single SQL primitive (model.getSeries — one bucketed
// AVG-per-metric query) and a single window definition, so they live together
// here. Controllers stay thin: they validate the `range` query string, call
// one of the two functions below, and envelope the result.
//
// Window filtering is done in SQL on epoch seconds (see sensorModel.js) — this
// service never compares timestamps itself; it only shapes and derives.
// ─────────────────────────────────────────────────────────────────────────

import * as model from '../models/sensorModel.js';
import { THRESHOLDS, SUMMARY_METRICS } from '../config/thresholds.js';

// Series ranges → { sinceModifier, bucketSeconds }. Bucket sizes are chosen so
// each range yields ≤ ~170 points: 1h/60=60, 8h/300≈96, 24h/900=96, 7d/3600=168.
const SERIES_RANGES = {
  '1h': { sinceModifier: '1 hours', bucketSeconds: 60 },
  '8h': { sinceModifier: '8 hours', bucketSeconds: 300 },
  '24h': { sinceModifier: '24 hours', bucketSeconds: 900 },
  '7d': { sinceModifier: '7 days', bucketSeconds: 3600 },
};
const DEFAULT_SERIES_RANGE = '24h';

// Summary ranges → window + the (fine) bucket used only for the excursion
// tally. A finer bucket than the series charts use makes each excursion a
// tighter, more event-like period without being expensive.
const SUMMARY_RANGES = {
  '24h': { sinceModifier: '24 hours', excursionBucketSeconds: 60 },
  '7d': { sinceModifier: '7 days', excursionBucketSeconds: 300 },
};
const DEFAULT_SUMMARY_RANGE = '24h';

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

export const isValidSeriesRange = (range) => Object.hasOwn(SERIES_RANGES, range);
export const isValidSummaryRange = (range) => Object.hasOwn(SUMMARY_RANGES, range);
export { DEFAULT_SERIES_RANGE, DEFAULT_SUMMARY_RANGE };

/**
 * Downsampled per-metric time series for the trend charts.
 * @param {string} range one of SERIES_RANGES keys (validated by the caller).
 * @returns { range, bucketSeconds, points: [{ t, ...sixMetrics }] }
 */
export async function getSeries(range) {
  const { sinceModifier, bucketSeconds } = SERIES_RANGES[range];
  const rows = await model.getSeries({ bucketSeconds, sinceModifier });

  const points = rows.map((row) => ({
    t: row.t,
    engineRpm: round2(row.engineRpm),
    lubOilPressure: round2(row.lubOilPressure),
    fuelPressure: round2(row.fuelPressure),
    coolantPressure: round2(row.coolantPressure),
    lubOilTemperature: round2(row.lubOilTemperature),
    coolantTemperature: round2(row.coolantTemperature),
  }));

  return { range, bucketSeconds, points };
}

// Severity of a single value against one metric's band. 0 = normal, 1 = warn,
// 2 = alarm. Absent bounds never trigger.
function severity(value, band) {
  if (value == null) return 0;
  if ((band.alarmHigh != null && value >= band.alarmHigh) ||
      (band.alarmLow != null && value <= band.alarmLow)) {
    return 2;
  }
  if ((band.warnHigh != null && value >= band.warnHigh) ||
      (band.warnLow != null && value <= band.warnLow)) {
    return 1;
  }
  return 0;
}

/**
 * Count excursion EVENTS (not samples) across all six sensors.
 *
 * These are distinct excursion PERIODS derived from bucket averages: we walk
 * each sensor's buckets oldest-first and count only the TRANSITIONS from a
 * less-severe state into warn (→ warn) and into alarm (→ alarm). A sensor that
 * sits in warn across many consecutive buckets is one warn event, not many;
 * escalating warn→alarm counts a fresh alarm event. Empty buckets are absent
 * from the row set, so "previous" means the previous non-empty bucket.
 */
function countExcursions(buckets) {
  let warn = 0;
  let alarm = 0;

  for (const metric of SUMMARY_METRICS) {
    const band = THRESHOLDS[metric];
    let prev = 0;
    for (const row of buckets) {
      const cur = severity(row[metric], band);
      if (cur === 2 && prev < 2) alarm += 1;
      else if (cur === 1 && prev < 1) warn += 1;
      prev = cur;
    }
  }

  return { warn, alarm };
}

/**
 * Management summary of the window: availability, real run-time, per-sensor
 * min/max/avg, and distinct excursion counts.
 * @param {string} range one of SUMMARY_RANGES keys (validated by the caller).
 */
export async function getSummary(range) {
  const { sinceModifier, excursionBucketSeconds } = SUMMARY_RANGES[range];
  const agg = await model.getSummaryAggregate({ sinceModifier });

  const sampleCount = agg.sampleCount || 0;
  const runningCount = agg.runningCount || 0;
  const from = agg.firstTs || null;
  const to = agg.lastTs || null;

  // Availability: fraction of samples in a RUNNING state. Null with no samples.
  const availabilityPct = sampleCount === 0
    ? null
    : round1((100 * runningCount) / sampleCount);

  // Real run-time: RUNNING samples scaled by the mean per-sample wall-clock
  // spacing actually observed in the window (span / samples), so ingest gaps
  // and non-1 Hz rates don't distort it. Needs ≥ 2 samples to have a span.
  let runHours = null;
  if (sampleCount >= 2 && from && to) {
    const windowSpanSeconds = (Date.parse(to) - Date.parse(from)) / 1000;
    runHours = round2((runningCount * (windowSpanSeconds / sampleCount)) / 3600);
  }

  // Per-sensor min/max/avg straight from the aggregate row.
  const perSensor = {};
  for (const metric of SUMMARY_METRICS) {
    perSensor[metric] = {
      min: round2(agg[`${metric}Min`]),
      max: round2(agg[`${metric}Max`]),
      avg: round2(agg[`${metric}Avg`]),
    };
  }

  // Excursions from the fine-bucket downsample (cheap: reuses getSeries SQL).
  const buckets = await model.getSeries({ bucketSeconds: excursionBucketSeconds, sinceModifier });
  const excursions = countExcursions(buckets);

  return {
    range,
    from,
    to,
    sampleCount,
    availabilityPct,
    runHours,
    excursions,
    perSensor,
  };
}
