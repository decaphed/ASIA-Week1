// ─────────────────────────────────────────────────────────────────────────
// useSensorData.js — the four purpose-built data hooks.
//
// Each is a one-line wrapper around usePolling + an api.js function. Grouping
// them here shows the pattern side by side: pick an endpoint, pick an
// interval, get back {data, error, loading}. Components never call the API or
// manage timers directly — they just call one of these hooks.
// ─────────────────────────────────────────────────────────────────────────

import { usePolling } from './usePolling.js';
import { getLive, getHistory, getStats, getHealth, getForecast, getDrift, getTrend, getProcessedLive, getSeries, getSummary } from '../services/api.js';
import { POLL_INTERVALS } from '../utils/constants.js';

/** Latest reading — polled every second to drive cards + charts. */
export function useLiveData(intervalMs = POLL_INTERVALS.live) {
  return usePolling(getLive, intervalMs);
}

/** Latest 100 readings — polled every 5s for the history table. */
export function useHistory(intervalMs = POLL_INTERVALS.history) {
  return usePolling(() => getHistory({ page: 1, limit: 100, sort: 'desc' }), intervalMs);
}

/** Aggregate statistics — polled every 5s. */
export function useStats(intervalMs = POLL_INTERVALS.stats) {
  return usePolling(getStats, intervalMs);
}

/** Backend/DB health — polled every 5s for the status indicators. */
export function useHealth(intervalMs = POLL_INTERVALS.health) {
  return usePolling(getHealth, intervalMs);
}

/** ETS forecast per metric — polled every 15s (the model itself only moves every 60s).
 *  Pass enabled=false to pause the poll while the data isn't being shown. */
export function useForecast(intervalMs = POLL_INTERVALS.forecast, enabled = true) {
  return usePolling(getForecast, intervalMs, { enabled });
}

/** Sustained-degradation drift status per metric — polled every 15s (the model itself only re-checks every 60s). */
export function useDrift(intervalMs = POLL_INTERVALS.drift) {
  return usePolling(getDrift, intervalMs);
}

/** Graded short-horizon trend classification per metric — polled every 15s (the model itself only re-checks every 60s).
 *  Pass enabled=false to pause the poll while the data isn't being shown. */
export function useTrend(intervalMs = POLL_INTERVALS.trend, enabled = true) {
  return usePolling(getTrend, intervalMs, { enabled });
}

/** Latest one-minute processed aggregate (quality/imputation) — polled every 15s (the model itself only updates every 60s). */
export function useProcessedLive(intervalMs = POLL_INTERVALS.processed) {
  return usePolling(getProcessedLive, intervalMs);
}

/**
 * Bucketed historical trend for a range (1h/8h/24h/7d) — polled every 60s.
 * `range` is passed as usePolling's `key`, so changing it refetches
 * immediately and drops any response still in flight for the old range.
 * A null range means "use the in-memory live buffer instead" — the poll is
 * paused entirely rather than hitting the endpoint with a bad range.
 */
export function useSeries(range, intervalMs = POLL_INTERVALS.series) {
  return usePolling(() => getSeries(range), intervalMs, { key: range, enabled: range != null });
}

/** Period summary (availability/run hours/excursions/per-sensor) for a range —
 *  polled every 60s. `range` is the poll key: changing it refetches and
 *  invalidates in-flight responses for the old range. */
export function useSummary(range, intervalMs = POLL_INTERVALS.summary) {
  return usePolling(() => getSummary(range), intervalMs, { key: range });
}
