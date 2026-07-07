// ─────────────────────────────────────────────────────────────────────────
// missing.js — missing-sample detection (Stage 3). Ported unchanged from
// node-red/flow.json's preprocess_minute: walks consecutive timestamps in
// the completed window and counts gaps in the ~1 Hz series.
// ─────────────────────────────────────────────────────────────────────────

const GAP_THRESHOLD_SECONDS = 1.5;

/**
 * @param {object[]} window a completed 60-sample window, in arrival order.
 * @returns {number} missingSampleCount — estimated number of ticks that never arrived.
 */
export function detectMissing(window) {
  let missingCount = 0;

  for (let i = 1; i < window.length; i++) {
    const dtSec = (new Date(window[i].timestamp).getTime() - new Date(window[i - 1].timestamp).getTime()) / 1000;
    if (dtSec > GAP_THRESHOLD_SECONDS) {
      missingCount += Math.round(dtSec) - 1;
    }
  }

  return missingCount;
}
