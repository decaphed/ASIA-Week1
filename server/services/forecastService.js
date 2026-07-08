// ─────────────────────────────────────────────────────────────────────────
// forecastService.js — damped-trend Holt's Linear (additive damped-trend
// ETS) forecasting for the 6 numeric pump metrics.
//
// Why damped trend: plain Holt's Linear extrapolates whatever trend it last
// saw in a straight line forever. The simulated pump's "load" is a
// mean-reverting random walk (see node-red/flow.json) — it drifts back
// toward a steady operating point rather than trending indefinitely — so a
// non-damped model kept over/under-shooting every time it picked up a
// transient trend from noise or a FAULT/STOPPED episode. Damping adds a phi
// (0 < phi <= 1) that decays the trend's contribution to the forecast, so
// short-lived trends flatten out instead of being extrapolated forever.
// phi = 1 recovers plain Holt's Linear exactly, so the grid search below is
// free to fall back to it for any metric where an undamped trend really
// does fit best.
//
// Two more safeguards run inside onNewProcessedRecord() on every new
// processed_telemetry row, each aimed at a different reason a value can look
// "wrong":
//   • regime-aware reset  — `dominantStatus` changing (RUNNING/FAULT/STOPPED)
//     is a trusted signal that the operating point genuinely shifted, so the
//     model resets its level/trend instead of fighting the jump.
//   • outlier guard        — a single minute far outside a metric's normal
//     noise, with NO status change to justify it, isn't fully trusted —
//     its pull on level/trend is capped, though the true error still
//     widens the confidence bounds.
// See the comment on onNewProcessedRecord() for the full reasoning.
//
// Input: as of the preprocessing pipeline, the series fed to this model is
// processed_telemetry's per-metric MEAN over each one-minute window (already
// outlier-capped and quality-scored by the preprocessing pipeline — see
// server/preprocessing/pipeline.js) rather than raw 1 Hz readings. That is a
// deliberate improvement: forecasting a management KPI should run on the
// cleaned, aggregated signal, not on raw sensor noise.
//
// Two things drive the model:
//   • every 15 minutes: a full re-fit against the last 200 processed rows
//     (~3.3 hours) — a grid search over alpha/beta/phi picks the triple that
//     minimises one-step-ahead MSE over that window, and level/trend are
//     re-initialised from the window's first two values then advanced
//     through the rest of the window with the winning alpha/beta/phi.
//   • on every new processed record (once per minute, event-driven — see
//     onNewProcessedRecord): a lightweight "forward slide" that advances
//     level and trend by one ETS update using only that record (alpha/beta/
//     phi are NOT re-estimated here). This replaces a fixed 60-second poll:
//     since processed records themselves only arrive once a minute, timing
//     the slide to ingestion instead of a wall-clock timer means it can
//     never process the same minute twice or skip one because the two
//     clocks drifted apart.
//
// getForecast() just returns whatever is currently cached — it never
// touches the database itself, so it's cheap to call from the controller.
// ─────────────────────────────────────────────────────────────────────────

import * as model from '../models/forecastModel.js';
import { logger } from '../utils/logger.js';

export const METRICS = [
  'flowRate',
  'rpm',
  'vibration',
  'suctionPressure',
  'dischargePressure',
  'motorTemp',
];

const REFIT_WINDOW = 200; // ~3.3 hours of one-minute processed records
const REFIT_INTERVAL_MS = 15 * 60 * 1000;
// Minimum rows before the grid search is allowed to fit. With fewer rows
// the 486-combination alpha/beta/phi search only has a handful of residuals
// to minimise over and will happily drive them to ~0 — an overfit that
// yields a near-zero RMSE and therefore a spuriously tight confidence band
// until the next scheduled refit. 12 rows (~12 minutes) gives 11 residuals,
// enough for the winning MSE to reflect real noise rather than luck.
const MIN_READINGS = 12;
const RESIDUAL_WINDOW = 30;
const ALPHAS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const BETAS = ALPHAS;
// 1.0 = no damping (plain Holt's Linear); lower values decay the trend
// faster. Kept close to 1 at the top of the range since most metrics still
// have *some* real short-term momentum worth extrapolating a little.
const PHIS = [0.8, 0.85, 0.9, 0.95, 0.98, 1.0];
// How many "recent RMSEs" away from the forecast a single reading has to be
// before the outlier guard kicks in and caps how far it's allowed to move
// level/trend. Normal noise rarely exceeds ~2-3x its own RMSE, so 4x is
// reserved for genuinely suspicious points — Node-RED's own Hampel-filter
// outlier capping already handles single-sample glitches inside a minute;
// this guard is the analogous safety net one level up, for a whole minute's
// mean landing far outside the model's expectation (e.g. state lost on a
// Node-RED restart, or a manual-entry test record).
const OUTLIER_Z = 4;

// A regime change only triggers the structural reset (safeguard 1 below)
// once dominantStatus has differed from the last CONFIRMED regime for this
// many consecutive records — the pump flips FAULT/STOPPED/RUNNING often
// enough (see trendService.js's identical constant/rationale) that a single
// blip must not collapse a metric's confidence band / zero its trend for
// what turns out to be one noisy minute. Until confirmed, the record is
// treated as a normal update, still subject to the outlier guard.
const REGIME_PERSISTENCE_ROWS = 3;

// One ETS state per metric: { alpha, beta, phi, level, trend, residuals }.
// Absent until the first successful re-fit.
const state = {};

// The pump's dominant operating regime (RUNNING/FAULT/STOPPED) as of the
// last processed record. Tracked so a *change* — a trusted signal straight
// from the preprocessing pipeline that the operating point has genuinely
// shifted — can be treated as a structural break (reset) rather than
// something ETS tries to smooth through as a trend. refitAll() also sets
// this, so the first onNewProcessedRecord() call after a refit compares
// against the regime that refit already captured, instead of null forcing a
// spurious reset.
let lastStatus = null;

// Tracks an as-yet-unconfirmed regime change: the candidate status and how
// many consecutive records have shown it. Cleared whenever a record matches
// the last confirmed regime again (i.e. the blip reverted) or once the
// change is confirmed and lastStatus advances.
let pendingRegime = null;
let pendingRegimeCount = 0;

// The latest forecast per metric, exactly what getForecast() hands back.
const forecastCache = Object.fromEntries(METRICS.map((m) => [m, null]));

const round2 = (value) => (value == null ? null : Math.round(value * 100) / 100);

/** The mean value for one metric out of a processed_telemetry row. */
const metricMean = (row, metric) => row[`${metric}Mean`];

/** Mean of squared values. */
function meanSquare(values) {
  return values.reduce((sum, v) => sum + v * v, 0) / values.length;
}

/**
 * Run damped-trend Holt's Linear over a chronological series with fixed
 * alpha/beta/phi. Level and trend are initialised from the first two
 * points; every subsequent point produces a one-step-ahead residual.
 * With phi < 1, the trend's influence on both the forecast and the next
 * trend update is discounted, so it decays toward 0 instead of persisting.
 * @returns { level, trend, residuals }
 */
function simulate(series, alpha, beta, phi) {
  let level = series[0];
  let trend = series[1] - series[0];
  const residuals = [];

  for (let t = 1; t < series.length; t++) {
    const actual = series[t];
    const forecast = level + phi * trend;
    residuals.push(actual - forecast);

    const newLevel = alpha * actual + (1 - alpha) * (level + phi * trend);
    const newTrend = beta * (newLevel - level) + (1 - beta) * phi * trend;
    level = newLevel;
    trend = newTrend;
  }

  return { level, trend, residuals };
}

/** Grid search alpha/beta/phi over a chronological series, minimising MSE. */
function fitMetric(series) {
  let best = null;

  for (const alpha of ALPHAS) {
    for (const beta of BETAS) {
      for (const phi of PHIS) {
        const result = simulate(series, alpha, beta, phi);
        const mse = meanSquare(result.residuals);
        if (!best || mse < best.mse) {
          best = { alpha, beta, phi, mse, ...result };
        }
      }
    }
  }

  return best;
}

/** Build the public forecast entry for one metric's current state. */
function computeForecastEntry(metricState) {
  if (!metricState) return null;

  const { level, trend, phi, residuals } = metricState;
  const rmse = residuals.length ? Math.sqrt(meanSquare(residuals)) : 0;
  const nextValue = level + phi * trend;

  // A NaN here (e.g. a bad reading poisoning the recursive ETS update)
  // would otherwise produce an object whose fields are all NaN — which
  // JSON.stringify silently turns into null on the wire, so the client
  // sees a *truthy* forecast object it can't distinguish from "no data
  // yet". Returning null outright keeps that distinction honest.
  if (!Number.isFinite(nextValue)) return null;

  return {
    level: round2(level),
    trend: round2(trend),
    forecast: round2(nextValue),
    lowerBound: round2(nextValue - 1.96 * rmse),
    upperBound: round2(nextValue + 1.96 * rmse),
  };
}

/** Full re-fit: grid search + re-initialisation from the last 200 rows. */
function refitAll() {
  const rows = model.getRecentReadings(REFIT_WINDOW);

  if (rows.length < MIN_READINGS) {
    for (const metric of METRICS) {
      delete state[metric];
      forecastCache[metric] = null;
    }
    lastStatus = null;
    logger.info(`Forecast refit skipped: only ${rows.length} processed record(s) in database (need ${MIN_READINGS})`);
    return;
  }

  // rows are newest-first (id DESC); Holt's method needs chronological order.
  const chronological = rows.slice().reverse();

  for (const metric of METRICS) {
    const series = chronological.map((row) => metricMean(row, metric));
    const fit = fitMetric(series);

    state[metric] = {
      alpha: fit.alpha,
      beta: fit.beta,
      phi: fit.phi,
      level: fit.level,
      trend: fit.trend,
      residuals: fit.residuals.slice(-RESIDUAL_WINDOW),
    };
    forecastCache[metric] = computeForecastEntry(state[metric]);
  }

  // Anchor regime-change detection to the regime this refit already saw, so
  // onNewProcessedRecord()'s next call only resets on a genuine change from
  // here — not on the fact that lastStatus happened to be null.
  lastStatus = chronological[chronological.length - 1].dominantStatus;

  logger.info(`Forecast models re-fit from last ${chronological.length} processed record(s)`);
}

/**
 * Forward slide: one ETS update per metric using the just-arrived processed
 * record. Called directly by processedController after a successful insert
 * — see the module comment for why this replaced a fixed 60-second timer.
 *
 * Two safeguards run here, in order, before a new minute's mean is trusted
 * to move a metric's level/trend:
 *
 *   1. Regime-aware RESET — `dominantStatus` (RUNNING/FAULT/STOPPED) is a
 *      trusted signal from the preprocessing pipeline that the pump's
 *      operating point has genuinely changed. That's a structural break, not
 *      a trend, so instead of letting the existing alpha/beta/phi fight
 *      through the jump, every metric's level/trend/residuals are reset to
 *      start fresh from the first record of the new regime. alpha/beta/phi
 *      themselves are kept — they describe how reactive this metric
 *      generally is, which is still valid across regimes; only "where is it
 *      right now" resets. (Consequence, deliberately accepted: right after a
 *      reset, residuals is empty, so rmse = 0 and the confidence band
 *      collapses to a single point for a few ticks — that's an honest "no
 *      error history for this regime yet", not a bug.)
 *
 *   2. Outlier GUARD — if `dominantStatus` did NOT change but a single
 *      minute's mean is still far outside this metric's own recent noise
 *      (its RMSE), there's no trusted signal confirming it's real. Rather
 *      than fully believing it, the *update* to level/trend is capped at a
 *      plausible size. The true (uncapped) error is still recorded in
 *      `residuals` though, so the model's confidence bounds honestly widen —
 *      it just means "I'm less sure right now", without letting one
 *      suspicious point drag the central forecast around.
 */
export function onNewProcessedRecord(row) {
  if (!row) return;

  // Bootstrap: if nothing has been fit yet (fresh database, or fewer than
  // MIN_READINGS existed at the last refitAll()), a new record might be
  // exactly the one that crosses the threshold. Without this, the only
  // thing that re-attempts a fit is the 15-minute refit timer, so a forecast
  // could sit at `null` for up to 15 minutes after enough data exists just
  // because no *scheduled* refit happened to land after the threshold was
  // crossed. Re-fitting here is cheap (a handful of rows, not the full
  // REFIT_WINDOW) and refitAll() itself is the source of truth for "do we
  // have enough data" (MIN_READINGS), so this can't produce a bad fit.
  if (Object.keys(state).length === 0) {
    refitAll();
    return;
  }

  let confirmedRegimeChange = false;
  if (lastStatus !== null && row.dominantStatus !== lastStatus) {
    pendingRegimeCount = pendingRegime === row.dominantStatus ? pendingRegimeCount + 1 : 1;
    pendingRegime = row.dominantStatus;
    confirmedRegimeChange = pendingRegimeCount >= REGIME_PERSISTENCE_ROWS;
  } else {
    // Back at the confirmed regime (or this is the very first record) —
    // nothing pending.
    pendingRegime = null;
    pendingRegimeCount = 0;
  }

  for (const metric of METRICS) {
    const metricState = state[metric];
    if (!metricState) continue; // no fit yet — nothing to slide

    const actual = metricMean(row, metric);

    if (confirmedRegimeChange) {
      metricState.level = actual;
      metricState.trend = 0;
      metricState.residuals = [];
      forecastCache[metric] = computeForecastEntry(metricState);
      continue;
    }

    const { alpha, beta, phi, level, trend, residuals } = metricState;
    const forecast = level + phi * trend;

    // Judge this reading against the noise level known BEFORE seeing it,
    // so one huge point can't inflate the very bar it's being measured
    // against.
    const priorRmse = residuals.length ? Math.sqrt(meanSquare(residuals)) : 0;
    const rawError = actual - forecast;

    let effectiveActual = actual;
    if (priorRmse > 0 && Math.abs(rawError) > OUTLIER_Z * priorRmse) {
      const cappedError = Math.sign(rawError) * OUTLIER_Z * priorRmse;
      effectiveActual = forecast + cappedError;
    }

    // Track the TRUE error (not the capped one) so RMSE / confidence
    // bounds still honestly reflect how surprising this reading was.
    residuals.push(rawError);
    if (residuals.length > RESIDUAL_WINDOW) residuals.shift();

    const newLevel = alpha * effectiveActual + (1 - alpha) * (level + phi * trend);
    const newTrend = beta * (newLevel - level) + (1 - beta) * phi * trend;
    metricState.level = newLevel;
    metricState.trend = newTrend;

    forecastCache[metric] = computeForecastEntry(metricState);
  }

  if (confirmedRegimeChange) {
    lastStatus = row.dominantStatus;
    pendingRegime = null;
    pendingRegimeCount = 0;
  }
}

/** @returns the latest cached forecast object for all 6 metrics. */
export function getForecast() {
  return { ...forecastCache };
}

/** Starts the 15-minute re-fit timer. Per-record updates are event-driven — see onNewProcessedRecord. */
export function startForecastLoop() {
  refitAll();
  setInterval(refitAll, REFIT_INTERVAL_MS);
  logger.info('Forecast loop started: re-fit every 15m; forward slide runs on each new processed record');
}
