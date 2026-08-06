// ─────────────────────────────────────────────────────────────────────────
// useFaultEvents.js — Fault Review queue data hook.
// One-line wrapper around usePolling + api.js, following useSensorData.js's
// pattern.
// ─────────────────────────────────────────────────────────────────────────

import { usePolling } from './usePolling.js';
import { getFaultEvents } from '../services/api.js';
import { POLL_INTERVALS } from '../utils/constants.js';

/**
 * Fault Review queue for one status filter — polled every 30s. `status` is
 * passed as usePolling's `key`, so switching the filter tab refetches
 * immediately and drops any in-flight response for the old filter.
 * status === undefined fetches the unfiltered set ("All"); the caller is
 * responsible for dropping NEGATIVE_SAMPLE rows client-side.
 */
export function useFaultEvents(status, intervalMs = POLL_INTERVALS.pdm, enabled = true) {
  return usePolling(() => getFaultEvents(status), intervalMs, { key: status, enabled });
}
