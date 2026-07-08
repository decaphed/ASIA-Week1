// ─────────────────────────────────────────────────────────────────────────
// trendService.js — short-horizon, graded rate-of-change classifier for the
// 6 numeric pump metrics ("Sharply Decreasing", "Stable", etc).
//
// Distinct from the other two time-series services in this directory:
//   • forecastService's damped-trend ETS `trend` is deliberately biased
//     toward flattening (it exists to forecast well, not to describe "how
//     is this moving right now") — not reusable as a rate-of-change signal.
//   • driftService's two-sample z-test answers "has this moved to a new
//     normal over ~2h vs ~15min" — a structural-break question, 3 buckets,
//     no magnitude, much longer horizon than "right now".
// This service answers a third, different question: over the last ~10
// minutes, is this metric moving, which direction, and how sharply.
//
// Method: Mann-Kendall trend test (Mann 1945 / Kendall 1975) for
// significance + Theil-Sen slope estimator (Sen 1968) for magnitude — a
// real, named, paired technique standard in environmental/industrial
// time-series monitoring for exactly this question. Both are non-parametric
// (rank/pairwise-based), which matters here because processed_telemetry
// means, while already Hampel-capped upstream, are not guaranteed Gaussian
// minute to minute — an OLS slope + t-test would be more easily dragged by
// one rough minute than the median-of-pairwise-slopes Theil-Sen estimate.
//
// The 7-way magnitude grading (slight/moderate/sharp x up/down, plus
// stable) is NOT part of Mann-Kendall/Sen — that pair only yields
// "significant or not" + "slope in real units". The grading scheme here is
// a reasonable convention, inspired by continuous-glucose-monitor
// rate-of-change arrow labeling (grade a rate of change into a small
// ordered label set) — it is explicitly not being presented as a named
// standard, and it has not been empirically tuned against real operating
// data; the thresholds below are a documented starting point.
//
// Input: processed_telemetry per-metric MEANs, RUNNING-only (same rationale
// as driftService: a FAULT/STOPPED episode is a known, already-flagged
// event, not a "trend", and must not be allowed to look like a sharp
// slope), same ROW_FETCH_MULTIPLIER over-fetch trick to survive a fault
// episode landing inside the fetched range.
//
// Trigger: event-driven, exactly like driftService — onNewProcessedRecord()
// re-queries and reclassifies every metric on each new processed row, plus
// once at startup. No timers.
// ─────────────────────────────────────────────────────────────────────────

import * as model from '../models/forecastModel.js';
import { METRICS } from './forecastService.js';
import { logger } from '../utils/logger.js';

const WINDOW = 10; // rows (~10 RUNNING minutes) — smallest window for which
// Mann-Kendall's normal approximation is conventionally considered valid;
// deliberately shorter than driftService's 15-row RECENT window since this
// answers a "right now" question, not "new normal".
const ROW_FETCH_MULTIPLIER = 2;
const MIN_ROWS_FOR_TREND = WINDOW;

// A regime change only wipes hysteresis/debounce state once the newest
// this-many rows all agree on the new status — a single FAULT/STOPPED blip
// (the pump flips status far more often than it genuinely trends, see
// runTrendCheck's module data below) must not discard several minutes of
// accumulated held state for what turns out to be one noisy minute.
const REGIME_PERSISTENCE_ROWS = 3;

// Mann-Kendall significance band (asymmetric enter/exit — hysteresis
// against a Z score oscillating right at the boundary from one minute to
// the next). 1.96 is the conventional 95%-CI Mann-Kendall significance
// level in the trend-test literature.
const Z_ENTER = 1.96;
const Z_EXIT = 1.5;

// Magnitude buckets, keyed by % of the sensor's operating range traversed
// over the window. index 0 = stable (no magnitude label).
const BUCKET_NAMES = [null, 'slight', 'moderate', 'sharp'];
const ENTER_THRESHOLDS = [0, 2, 5, 15]; // rangePct
const EXIT_FACTOR = 0.8; // hysteresis: must drop 20% below a bucket's enter threshold before falling out of it

// Operating range (not the wider physics hard-reject RANGES in
// utils/validation.js) — mirrors client/src/utils/constants.js SENSORS'
// min/max. Kept as a plain local table (same "ported, not shared" approach
// preprocessing/validator.js documents for RANGES) since client and server
// don't share a module boundary.
const OPERATING_RANGE = {
  flowRate: { min: 50, max: 300 },
  rpm: { min: 1000, max: 3600 },
  vibration: { min: 0.5, max: 12 },
  suctionPressure: { min: 0.5, max: 3 },
  dischargePressure: { min: 2, max: 12 },
  motorTemp: { min: 20, max: 90 },
};

// Per-metric hysteresis/debounce state, persisted across calls.
const held = {};
function resetHeld(metric) {
  held[metric] = { significant: false, bucketIndex: 0, pendingLabel: null, pendingCount: 0, published: null };
}
for (const m of METRICS) resetHeld(m);

// One trend entry per metric. Absent (null) until MIN_ROWS_FOR_TREND
// RUNNING rows are available.
const trendCache = Object.fromEntries(METRICS.map((m) => [m, null]));

// The pump's last CONFIRMED dominant operating regime — mirrors
// forecastService's `lastStatus`. Only ever advanced on bootstrap or once a
// new status has persisted for REGIME_PERSISTENCE_ROWS rows (see
// runTrendCheck) — never on a single differing row — so a blip that
// reverts before persisting leaves this (and all held state) untouched. A
// confirmed change IS a trusted signal that whatever the window was
// tracking is over; the hysteresis/debounce state (not just the window
// contents) must not survive it, or a stale pre-transition bucket could
// make the first post-transition minutes look like a continuation of a
// trend that never actually happened.
let lastStatus = null;

const round2 = (value) => (value == null ? null : Math.round(value * 100) / 100);
const round1 = (value) => (value == null ? null : Math.round(value * 10) / 10);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The mean value for one metric out of a processed_telemetry row. */
const metricMean = (row, metric) => row[`${metric}Mean`];

/**
 * Mann-Kendall S statistic + normalised Z score, with tie correction.
 * @param series chronological (oldest-first) values.
 */
function mannKendall(series) {
  const n = series.length;
  let s = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      s += Math.sign(series[j] - series[i]);
    }
  }

  const tieCounts = new Map();
  for (const v of series) tieCounts.set(v, (tieCounts.get(v) || 0) + 1);
  let tieCorrection = 0;
  for (const tp of tieCounts.values()) {
    if (tp > 1) tieCorrection += tp * (tp - 1) * (2 * tp + 5);
  }

  const variance = (n * (n - 1) * (2 * n + 5) - tieCorrection) / 18;
  let z = 0;
  if (variance > 0) {
    if (s > 0) z = (s - 1) / Math.sqrt(variance);
    else if (s < 0) z = (s + 1) / Math.sqrt(variance);
  }
  return z;
}

/**
 * Theil-Sen slope estimator: median of all pairwise slopes, in units per
 * WALL-CLOCK MINUTE. Slopes are computed against each row's actual
 * timestamp rather than its row index — rows are ~1 RUNNING minute apart,
 * but a skipped FAULT/STOPPED episode can put several real minutes between
 * two adjacent RUNNING rows, and dividing by row-step there would overstate
 * the rate by the gap factor. Pairs with a non-positive time delta
 * (duplicate/out-of-order timestamps) are skipped rather than allowed to
 * produce an infinite or sign-flipped slope.
 * @param minutes chronological timestamps, in minutes (same length as values).
 * @param values  chronological metric values.
 */
function senSlope(minutes, values) {
  const slopes = [];
  const n = values.length;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const dt = minutes[j] - minutes[i];
      if (dt > 0) slopes.push((values[j] - values[i]) / dt);
    }
  }
  if (slopes.length === 0) return 0;
  slopes.sort((a, b) => a - b);
  const mid = Math.floor(slopes.length / 2);
  return slopes.length % 2 === 0 ? (slopes[mid - 1] + slopes[mid]) / 2 : slopes[mid];
}

/** Step the held magnitude bucket toward rangePct, with hysteresis on the way down. */
function nextBucketIndex(rangePct, heldIndex) {
  let enterIndex = 0;
  for (let i = ENTER_THRESHOLDS.length - 1; i >= 1; i--) {
    if (rangePct >= ENTER_THRESHOLDS[i]) { enterIndex = i; break; }
  }
  if (enterIndex >= heldIndex) return enterIndex; // rising, or steady at/above the held level

  const exitThreshold = heldIndex === 0 ? 0 : ENTER_THRESHOLDS[heldIndex] * EXIT_FACTOR;
  if (rangePct >= exitThreshold) return heldIndex; // within the hysteresis band — stay put

  let dropIndex = 0;
  for (let i = heldIndex - 1; i >= 1; i--) {
    if (rangePct >= ENTER_THRESHOLDS[i]) { dropIndex = i; break; }
  }
  return dropIndex;
}

/**
 * Classify one metric's windowed series, applying significance hysteresis,
 * bucket hysteresis, and a 2-evaluation debounce before a label CHANGE is
 * actually published (the numeric fields still refresh every call once a
 * label is confirmed — only the label itself is protected from flicker).
 */
function classify(metric, minutes, series) {
  const z = mannKendall(series);
  const slope = senSlope(minutes, series);
  // Elapsed real time across the window, so rangePct describes what the
  // slope amounts to over the minutes the window actually spans.
  const spanMinutes = minutes[minutes.length - 1] - minutes[0];
  const { min, max } = OPERATING_RANGE[metric];
  const rangePct = (Math.abs(slope) * spanMinutes) / (max - min) * 100;

  const h = held[metric];
  if (h.significant) {
    if (Math.abs(z) < Z_EXIT) h.significant = false;
  } else if (Math.abs(z) > Z_ENTER) {
    h.significant = true;
  }

  h.bucketIndex = nextBucketIndex(rangePct, h.bucketIndex);

  const rawDirection = slope > 0 ? 'up' : slope < 0 ? 'down' : 'stable';
  const isTrending = h.significant && h.bucketIndex > 0 && rawDirection !== 'stable';

  const magnitude = isTrending ? BUCKET_NAMES[h.bucketIndex] : null;
  const direction = isTrending ? rawDirection : 'stable';
  const label = isTrending
    ? `${capitalize(magnitude)} ${rawDirection === 'up' ? 'Increasing' : 'Decreasing'}`
    : 'Stable';

  const candidate = {
    direction,
    magnitude,
    label,
    slopePerMin: round2(slope),
    rangePct: round1(rangePct),
    z: round2(z),
    significant: h.significant,
  };

  if (h.published === null || label === h.pendingLabel) {
    h.pendingLabel = label;
    h.pendingCount += 1;
    if (h.published === null || h.pendingCount >= 2) h.published = candidate;
  } else {
    h.pendingLabel = label;
    h.pendingCount = 1;
  }

  return h.published;
}

/** Pull the latest window, reclassify every metric, refresh the cache. */
function runTrendCheck() {
  const rows = model.getRecentReadings(WINDOW * ROW_FETCH_MULTIPLIER);

  if (rows.length === 0) return;

  // rows are newest-first. lastStatus is only ever advanced here — on
  // bootstrap, or once the newest REGIME_PERSISTENCE_ROWS rows all agree on
  // a status different from the last confirmed one — so an unconfirmed
  // blip leaves lastStatus (and all held hysteresis/debounce state) alone.
  const newestStatus = rows[0].dominantStatus;
  if (lastStatus === null) {
    lastStatus = newestStatus;
  } else if (newestStatus !== lastStatus) {
    const confirmed = rows.length >= REGIME_PERSISTENCE_ROWS
      && rows.slice(0, REGIME_PERSISTENCE_ROWS).every((row) => row.dominantStatus === newestStatus);
    if (confirmed) {
      for (const metric of METRICS) resetHeld(metric);
      logger.info(`Trend state reset: regime changed ${lastStatus} -> ${newestStatus} (confirmed over ${REGIME_PERSISTENCE_ROWS} rows)`);
      lastStatus = newestStatus;
    }
  }

  const runningOnly = rows.slice().reverse().filter((row) => row.dominantStatus === 'RUNNING');

  if (runningOnly.length < MIN_ROWS_FOR_TREND) {
    for (const metric of METRICS) trendCache[metric] = null;
    logger.info(`Trend check skipped: only ${runningOnly.length} RUNNING processed record(s) available (need ${MIN_ROWS_FOR_TREND})`);
    return;
  }

  const window = runningOnly.slice(-WINDOW);
  const minutes = window.map((row) => Date.parse(row.timestamp) / 60000);
  for (const metric of METRICS) {
    const series = window.map((row) => metricMean(row, metric));
    trendCache[metric] = classify(metric, minutes, series);
  }
}

/** @returns the latest cached trend classification for all 6 metrics. */
export function getTrend() {
  return { ...trendCache };
}

/**
 * Called by processedService.saveAndTrigger after each new processed
 * record is stored. Re-runs the full windowed check (cheap: O(WINDOW^2)
 * pairwise Mann-Kendall/Sen work over ~10 rows) rather than maintaining
 * incremental state — at this window size there's no benefit to the added
 * complexity of an incremental update.
 */
export function onNewProcessedRecord() {
  runTrendCheck();
}

/** Runs an initial check on startup to pick up any history already stored. */
export function startTrendLoop() {
  runTrendCheck();
  logger.info('Trend classification loop started: initial check run; subsequent checks are event-driven (see onNewProcessedRecord)');
}
