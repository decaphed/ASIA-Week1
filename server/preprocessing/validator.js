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

const METRICS = Object.keys(RANGES);

/**
 * @param {object} sample raw telemetry sample (6 metrics + status).
 * @returns {{ physicsValid: boolean, physicsViolations: string[] | null }}
 */
export function validatePhysics(sample) {
  const violations = [];

  for (const metric of METRICS) {
    const { min, max } = RANGES[metric];
    if (sample[metric] < min || sample[metric] > max) {
      violations.push(`${metric} out of range`);
    }
  }

  // A centrifugal pump always adds head, so discharge pressure must exceed
  // suction pressure while running.
  if (sample.dischargePressure <= sample.suctionPressure) {
    violations.push('dischargePressure must exceed suctionPressure');
  }

  // Status/measurement consistency: a STOPPED pump should show ~zero flow/rpm.
  if (sample.status === 'STOPPED' && (sample.flowRate > 20 || sample.rpm > 200)) {
    violations.push('STOPPED status but flow/rpm indicate the pump is running');
  }

  return {
    physicsValid: violations.length === 0,
    physicsViolations: violations.length ? violations : null,
  };
}
