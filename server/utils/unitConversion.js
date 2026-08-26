// ─────────────────────────────────────────────────────────────────────────
// unitConversion.js — §10.4.1 Stage B's fixed per-metric source-unit lists
// and conversion functions. Every metric's internal unit (what
// engine-physics.yaml's RANGES and this system's own six metrics are always
// expressed in) is always the identity entry in its list — a mapped column
// declared in the internal unit is a no-op conversion, not a special case.
//
// Deliberately a short, FIXED list per metric — no free-text unit entry,
// no unit-string parsing/guessing. §10.4.1's own reasoning for banning
// fuzzy column-name matching applies equally here: an operator's unit
// choice is only as trustworthy as the human asserting it.
//
// Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
// migration.md Phase 3. flowRate and vibration have no engine analogue and
// are dropped outright (not renamed). The three pressure metrics' and two
// temperatures' internal units (bar, degC) are themselves UNCONFIRMED —
// data/train.csv does not label units for any non-RPM column (plan §2.2) —
// so these bar/psi/kPa and degC/degF/K conversion tables are offered on the
// same ASSUMED basis as engine-physics.yaml, not a confirmed spec.
// ─────────────────────────────────────────────────────────────────────────

const PSI_TO_BAR = 0.06894757293168361;

export const UNIT_CONVERSIONS = {
  engineRpm: {
    RPM: (v) => v,
  },
  lubOilPressure: {
    bar: (v) => v,
    psi: (v) => v * PSI_TO_BAR,
    kPa: (v) => v * 0.01,
  },
  fuelPressure: {
    bar: (v) => v,
    psi: (v) => v * PSI_TO_BAR,
    kPa: (v) => v * 0.01,
  },
  coolantPressure: {
    bar: (v) => v,
    psi: (v) => v * PSI_TO_BAR,
    kPa: (v) => v * 0.01,
  },
  lubOilTemperature: {
    '°C': (v) => v,
    '°F': (v) => ((v - 32) * 5) / 9,
    K: (v) => v - 273.15,
  },
  coolantTemperature: {
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
