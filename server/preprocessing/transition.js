// ─────────────────────────────────────────────────────────────────────────
// transition.js — shared operating-state-transition signal, consumed by
// both validator.js (which TOLERATES a suspected transition within the
// grace window, to avoid false-flagging equalization/coast-down/inertia) and
// missing.js (which BLOCKS gap-fill on the categorical signals, and blocks
// per-metric fill on that metric's ramp-rate signal). Same underlying
// question, answered once, applied with different policies at different
// pipeline stages — not two independently-tuned heuristics reading the same
// signal.
// ─────────────────────────────────────────────────────────────────────────

import { MAX_RAMP_RATE_PER_SECOND, STATUS_TRANSITION_GRACE_SECONDS } from './config.js';

/**
 * @param {object} args
 * @param {object} args.from the earlier sample.
 * @param {object} args.to the later sample.
 * @param {number} args.dtSec elapsed seconds between them.
 * @returns {{
 *   statusChanged: boolean,
 *   eitherInvalid: boolean,
 *   rampExceeded: Record<string, boolean>,
 *   anyRampExceeded: boolean,
 *   suspected: boolean,
 *   withinGraceWindow: boolean,
 * }}
 */
export function detectTransition({ from, to, dtSec }) {
  const statusChanged = from.status !== to.status;
  const eitherInvalid = from.physicsValid === false || to.physicsValid === false;

  const rampExceeded = {};
  let anyRampExceeded = false;
  for (const [metric, maxRate] of Object.entries(MAX_RAMP_RATE_PER_SECOND)) {
    if (from[metric] == null || to[metric] == null || !dtSec) {
      rampExceeded[metric] = false;
      continue;
    }
    const impliedRate = Math.abs(to[metric] - from[metric]) / dtSec;
    rampExceeded[metric] = impliedRate > maxRate;
    if (rampExceeded[metric]) anyRampExceeded = true;
  }

  const suspected = statusChanged || eitherInvalid || anyRampExceeded;
  const withinGraceWindow = dtSec != null && dtSec <= STATUS_TRANSITION_GRACE_SECONDS;

  return { statusChanged, eitherInvalid, rampExceeded, anyRampExceeded, suspected, withinGraceWindow };
}
