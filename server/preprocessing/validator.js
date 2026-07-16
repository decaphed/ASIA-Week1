// ─────────────────────────────────────────────────────────────────────────
// validator.js — physics-informed validation (Stage 1 of the preprocessing
// pipeline). Ported from node-red/flow.json's preprocess_minute function
// node: same RANGES (imported from utils/validation.js instead of being
// redefined, so the hard-reject boundary and this soft-annotate stage can
// never drift apart), same two cross-variable rules.
//
// This NEVER rejects a reading — it only annotates it, so raw_telemetry
// keeps a complete, unbroken audit trail even for values that later prove
// suspect. Hard rejection of impossible values already happens one layer up,
// in middleware/validateReading.js.
// ─────────────────────────────────────────────────────────────────────────

import { RANGES } from '../utils/validation.js';
import { detectTransition } from './transition.js';
import { PRESSURE_EQUALIZATION_TOLERANCE_BAR } from './config.js';

const METRICS = Object.keys(RANGES);

/**
 * @param {object} sample raw telemetry sample (6 metrics + status).
 * @param {object} [context]
 * @param {object|null} [context.prevSample] the last accepted/merged sample before this one, for transition detection.
 * @param {number|null} [context.dtSec] elapsed seconds since prevSample.
 * @returns {{ physicsValid: boolean, physicsViolations: string[] | null }}
 */
export function validatePhysics(sample, context = {}) {
  const { prevSample = null, dtSec = null } = context;
  const violations = [];

  // A metric that's null was never measured/reconstructed with confidence —
  // there is no truth value for "in range" or "violating," so it must be
  // excluded from validation entirely rather than defaulted (null coerces to
  // 0 in a numeric comparison, which would fabricate a violation).
  for (const metric of METRICS) {
    if (sample[metric] == null) continue;
    const { min, max } = RANGES[metric];
    if (sample[metric] < min || sample[metric] > max) {
      violations.push(`${metric} out of range`);
    }
  }

  const transition = prevSample && dtSec != null
    ? detectTransition({ from: prevSample, to: sample, dtSec })
    : null;
  const tolerated = transition ? transition.suspected && transition.withinGraceWindow : false;

  // A centrifugal pump always adds head while running; while stopped or
  // during pressure equalization, discharge may legitimately approach or dip
  // below suction — tolerate that within a transition grace window.
  if (sample.dischargePressure != null && sample.suctionPressure != null) {
    const withinTolerance = sample.status === 'STOPPED' || tolerated
      ? sample.dischargePressure >= sample.suctionPressure - PRESSURE_EQUALIZATION_TOLERANCE_BAR
      : sample.dischargePressure > sample.suctionPressure;
    if (!withinTolerance) {
      violations.push('dischargePressure must exceed suctionPressure');
    }
  }

  // Status/measurement consistency: a STOPPED pump should show ~zero
  // flow/rpm, but inertia/drainage/backflow/coast-down can keep both nonzero
  // briefly right after a stop — tolerate that within the transition grace
  // window instead of flagging it immediately.
  if (sample.status === 'STOPPED' && sample.flowRate != null && sample.rpm != null) {
    if (!tolerated && (sample.flowRate > 20 || sample.rpm > 200)) {
      violations.push('STOPPED status but flow/rpm indicate the pump is running');
    }
  }

  return {
    physicsValid: violations.length === 0,
    physicsViolations: violations.length ? violations : null,
  };
}
