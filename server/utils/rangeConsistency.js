// ─────────────────────────────────────────────────────────────────────────
// rangeConsistency.js — startup guard for the three hand-maintained
// per-metric range tables: RANGES (validation.js, hard physics-reject
// bounds), OPERATING_RANGE (trendService.js, normal operating envelope —
// mirrors client/src/utils/constants.js SENSORS min/max) and THRESHOLDS
// (config/thresholds.js, warn/alarm bands).
//
// These are NOT supposed to be equal — they nest by design:
//   RANGES (widest, physically-possible)
//     ⊇ OPERATING_RANGE (normal envelope)
//       ⊇ THRESHOLDS bounds (warn/alarm, only trip inside the envelope)
// A three-way equality check would be wrong on purpose. What actually must
// hold is the nesting: an operating range that falls outside the physically
// possible range, or an alarm band that sits outside the operating range,
// means someone edited one table without checking the others — exactly the
// drift risk called out where each table is defined ("PORTED here, not
// imported"). Assert it once at startup so that drift fails loudly instead
// of silently producing wrong trend/quality labels.
// ─────────────────────────────────────────────────────────────────────────

import { RANGES } from './validation.js';
import { OPERATING_RANGE } from '../services/trendService.js';
import { THRESHOLDS } from '../config/thresholds.js';

export function assertRangeConsistency() {
  const errors = [];

  for (const metric of Object.keys(OPERATING_RANGE)) {
    const physical = RANGES[metric];
    const operating = OPERATING_RANGE[metric];

    if (!physical) {
      errors.push(`${metric}: no matching entry in RANGES (validation.js)`);
      continue;
    }

    if (operating.min < physical.min || operating.max > physical.max) {
      errors.push(
        `${metric}: OPERATING_RANGE [${operating.min}, ${operating.max}] falls outside `
        + `RANGES [${physical.min}, ${physical.max}]`,
      );
    }

    const bounds = THRESHOLDS[metric] || {};
    for (const [key, value] of Object.entries(bounds)) {
      if (value === null || value === undefined) continue;
      if (value < operating.min || value > operating.max) {
        errors.push(
          `${metric}: THRESHOLDS.${key} (${value}) falls outside `
          + `OPERATING_RANGE [${operating.min}, ${operating.max}]`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Range table consistency check failed:\n  ${errors.join('\n  ')}`);
  }
}
