// ─────────────────────────────────────────────────────────────────────────
// forecastService.js — Holt's Linear (double exponential smoothing) ETS
// forecasting for the 6 numeric pump metrics.
//
// Two timers drive the model:
//   • every 15 minutes: a full re-fit against the last 200 readings — a grid
//     search over alpha/beta picks the pair that minimises one-step-ahead
//     MSE over that window, and level/trend are re-initialised from the
//     window's first two values then advanced through the rest of the
//     window with the winning alpha/beta.
//   • every 60 seconds: a lightweight "forward slide" that advances level
//     and trend by one ETS update using only the single latest reading
//     (alpha/beta are NOT re-estimated here).
//
// getForecast() just returns whatever is currently cached — it never
// touches the database itself, so it's cheap to call from the controller.
// ─────────────────────────────────────────────────────────────────────────

import * as model from '../models/forecastModel.js';
import { logger } from '../utils/logger.js';

const METRICS = [
  'flowRate',
  'rpm',
  'vibration',
  'suctionPressure',
  'dischargePressure',
  'motorTemp',
];

const REFIT_WINDOW = 200;
const REFIT_INTERVAL_MS = 15 * 60 * 1000;
const SLIDE_INTERVAL_MS = 60 * 1000;
const MIN_READINGS = 4;
const RESIDUAL_WINDOW = 30;
const ALPHAS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const BETAS = ALPHAS;

// One ETS state per metric: { alpha, beta, level, trend, residuals }.
// Absent until the first successful re-fit.
const state = {};

// The latest forecast per metric, exactly what getForecast() hands back.
const forecastCache = Object.fromEntries(METRICS.map((m) => [m, null]));

const round2 = (value) => (value == null ? null : Math.round(value * 100) / 100);

/** Mean of squared values. */
function meanSquare(values) {
  return values.reduce((sum, v) => sum + v * v, 0) / values.length;
}

/**
 * Run Holt's Linear method over a chronological series with fixed
 * alpha/beta. Level and trend are initialised from the first two points;
 * every subsequent point produces a one-step-ahead residual.
 * @returns { level, trend, residuals }
 */
function simulate(series, alpha, beta) {
  let level = series[0];
  let trend = series[1] - series[0];
  const residuals = [];

  for (let t = 1; t < series.length; t++) {
    const actual = series[t];
    const forecast = level + trend;
    residuals.push(actual - forecast);

    const newLevel = alpha * actual + (1 - alpha) * (level + trend);
    const newTrend = beta * (newLevel - level) + (1 - beta) * trend;
    level = newLevel;
    trend = newTrend;
  }

  return { level, trend, residuals };
}

/** Grid search alpha/beta over a chronological series, minimising MSE. */
function fitMetric(series) {
  let best = null;

  for (const alpha of ALPHAS) {
    for (const beta of BETAS) {
      const result = simulate(series, alpha, beta);
      const mse = meanSquare(result.residuals);
      if (!best || mse < best.mse) {
        best = { alpha, beta, mse, ...result };
      }
    }
  }

  return best;
}

/** Build the public forecast entry for one metric's current state. */
function computeForecastEntry(metricState) {
  if (!metricState) return null;

  const { level, trend, residuals } = metricState;
  const rmse = residuals.length ? Math.sqrt(meanSquare(residuals)) : 0;
  const nextValue = level + trend;

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
    logger.info(`Forecast refit skipped: only ${rows.length} reading(s) in database (need ${MIN_READINGS})`);
    return;
  }

  // rows are newest-first (id DESC); Holt's method needs chronological order.
  const chronological = rows.slice().reverse();

  for (const metric of METRICS) {
    const series = chronological.map((row) => row[metric]);
    const fit = fitMetric(series);

    state[metric] = {
      alpha: fit.alpha,
      beta: fit.beta,
      level: fit.level,
      trend: fit.trend,
      residuals: fit.residuals.slice(-RESIDUAL_WINDOW),
    };
    forecastCache[metric] = computeForecastEntry(state[metric]);
  }

  logger.info(`Forecast models re-fit from last ${chronological.length} readings`);
}

/** Forward slide: one ETS update per metric using only the latest reading. */
function slideForward() {
  const [latest] = model.getRecentReadings(1);
  if (!latest) return;

  for (const metric of METRICS) {
    const metricState = state[metric];
    if (!metricState) continue; // no fit yet — nothing to slide

    const actual = latest[metric];
    const { alpha, beta, level, trend, residuals } = metricState;
    const forecast = level + trend;
    const error = actual - forecast;

    residuals.push(error);
    if (residuals.length > RESIDUAL_WINDOW) residuals.shift();

    const newLevel = alpha * actual + (1 - alpha) * (level + trend);
    const newTrend = beta * (newLevel - level) + (1 - beta) * trend;
    metricState.level = newLevel;
    metricState.trend = newTrend;

    forecastCache[metric] = computeForecastEntry(metricState);
  }
}

/** @returns the latest cached forecast object for all 6 metrics. */
export function getForecast() {
  return { ...forecastCache };
}

/** Starts the 15-minute re-fit timer and the 60-second forward-slide timer. */
export function startForecastLoop() {
  refitAll();
  setInterval(refitAll, REFIT_INTERVAL_MS);
  setInterval(slideForward, SLIDE_INTERVAL_MS);
  logger.info('Forecast loop started: re-fit every 15m, forward slide every 60s');
}
