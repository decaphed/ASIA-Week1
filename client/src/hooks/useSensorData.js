// ─────────────────────────────────────────────────────────────────────────
// useSensorData.js — the four purpose-built data hooks.
//
// Each is a one-line wrapper around usePolling + an api.js function. Grouping
// them here shows the pattern side by side: pick an endpoint, pick an
// interval, get back {data, error, loading}. Components never call the API or
// manage timers directly — they just call one of these hooks.
// ─────────────────────────────────────────────────────────────────────────

import { usePolling } from './usePolling.js';
import { getLive, getHistory, getStats, getHealth, getForecast, getDrift, getTrend, getProcessedLive } from '../services/api.js';
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

/** ETS forecast per metric — polled every 15s (the model itself only moves every 60s). */
export function useForecast(intervalMs = POLL_INTERVALS.forecast) {
  return usePolling(getForecast, intervalMs);
}

/** Sustained-degradation drift status per metric — polled every 15s (the model itself only re-checks every 60s). */
export function useDrift(intervalMs = POLL_INTERVALS.drift) {
  return usePolling(getDrift, intervalMs);
}

/** Graded short-horizon trend classification per metric — polled every 15s (the model itself only re-checks every 60s). */
export function useTrend(intervalMs = POLL_INTERVALS.trend) {
  return usePolling(getTrend, intervalMs);
}

/** Latest one-minute processed aggregate (quality/imputation) — polled every 15s (the model itself only updates every 60s). */
export function useProcessedLive(intervalMs = POLL_INTERVALS.processed) {
  return usePolling(getProcessedLive, intervalMs);
}
