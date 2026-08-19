// ─────────────────────────────────────────────────────────────────────────
// unitConversion.js — §10.4.1 Stage B's fixed per-metric source-unit lists
// and conversion functions. Every metric's internal unit (what
// pump-physics.yaml's RANGES and this system's own six metrics are always
// expressed in) is always the identity entry in its list — a mapped column
// declared in the internal unit is a no-op conversion, not a special case.
//
// Deliberately a short, FIXED list per metric — no free-text unit entry,
// no unit-string parsing/guessing. §10.4.1's own reasoning for banning
// fuzzy column-name matching applies equally here: an operator's unit
// choice is only as trustworthy as the human asserting it.
//
// vibration's list deliberately excludes 'g' (acceleration) — converting
// acceleration to velocity requires the vibration frequency (v = a / 2πf),
// which a scalar CSV column can't supply. Offering a fixed-multiplier
// "g -> mm/s" conversion would be physically wrong and would fabricate
// confidence this system's design repeatedly refuses to fabricate (§3.2).
// ─────────────────────────────────────────────────────────────────────────

const PSI_TO_BAR = 0.06894757293168361;

export const UNIT_CONVERSIONS = {
  flowRate: {
    'L/min': (v) => v,
    GPM: (v) => v * 3.785411784,
    'm3/h': (v) => (v * 1000) / 60,
  },
  rpm: {
    rpm: (v) => v,
  },
  vibration: {
    'mm/s': (v) => v,
    'in/s': (v) => v * 25.4,
  },
  suctionPressure: {
    bar: (v) => v,
    psi: (v) => v * PSI_TO_BAR,
    kPa: (v) => v * 0.01,
  },
  dischargePressure: {
    bar: (v) => v,
    psi: (v) => v * PSI_TO_BAR,
    kPa: (v) => v * 0.01,
  },
  motorTemp: {
    '°C': (v) => v,
    '°F': (v) => ((v - 32) * 5) / 9,
    K: (v) => v - 273.15,
  },
};

/** @returns the list of valid unit strings for a metric, or undefined if the metric name isn't recognized. */
export function unitsForMetric(metric) {
  const table = UNIT_CONVERSIONS[metric];
  return table ? Object.keys(table) : undefined;
}

/**
 * @returns the converted numeric value, or null if the metric/unit
 *   combination isn't valid (caller should have already validated this via
 *   unitsForMetric before calling — this returns null rather than throwing
 *   so a batch conversion loop can collect all bad values at once).
 */
export function convertToInternalUnit(metric, unit, value) {
  const table = UNIT_CONVERSIONS[metric];
  const fn = table?.[unit];
  if (!fn || typeof value !== 'number' || !Number.isFinite(value)) return null;
  return fn(value);
}
