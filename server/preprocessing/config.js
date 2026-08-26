// ─────────────────────────────────────────────────────────────────────────
// config.js — single source of truth for cadence, windowing, and tolerance
// constants used across buffer.js, missing.js, validator.js, outlier.js,
// transition.js, and faultClassifier.js.
//
// PROVISIONAL VALUES: SAMPLE_INTERVAL_SECONDS is confirmed only against this
// project's own simulator (node-red/flow.json's inject node: repeat: "1",
// i.e. ~1 Hz) — the real production OT system's cadence is NOT yet
// confirmed (see the pending "Step 1" question to the OT/instrumentation
// team). PRESSURE_EQUALIZATION_TOLERANCE_BAR, STATUS_TRANSITION_GRACE_SECONDS,
// STATUS_DEBOUNCE_SAMPLES, MAX_RAMP_RATE_PER_SECOND, and
// MAX_FILLABLE_GAP_SECONDS_BY_METRIC are physically-reasoned placeholders,
// not derived from real pump coast-down/equalization data. Revisit all of
// these once real OT cadence and pump physical-response data are available.
// ─────────────────────────────────────────────────────────────────────────

export const SAMPLE_INTERVAL_SECONDS = 1;
export const WINDOW_DURATION_SECONDS = 60;
export const EXPECTED_SAMPLE_COUNT = Math.round(WINDOW_DURATION_SECONDS / SAMPLE_INTERVAL_SECONDS);

// How long a closed window stays around accepting MERGED (late/reordered)
// inserts before being evicted as REJECTED_STALE.
export const LATE_GRACE_SECONDS = 10;

// Fixed-length, timestamp-sorted, window-boundary-independent tail used only
// so faultClassifier can find a chronological "before" neighbor for a run
// that starts at the very beginning of a window (whose true predecessor is
// in an already-closed/evicted window).
export const RECENT_TAIL_SIZE = 10;

// Hampel neighborhood half-width, in real seconds — outlier.js derives its
// sample-count HALF_WINDOW from this divided by SAMPLE_INTERVAL_SECONDS, so
// a cadence change doesn't silently desync the neighborhood from real time.
export const HALF_WINDOW_SECONDS = 3;

// Per-metric interpolation ceilings: how long a gap can be before a straight
// line is trusted, differentiated by how fast each metric plausibly moves.
// Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
// migration.md Phase 3. The two temperatures have high thermal mass and
// change slowly (long fillable gap); the two pressures and RPM move faster.
export const MAX_FILLABLE_GAP_SECONDS_BY_METRIC = {
  coolantTemperature: 20,
  lubOilTemperature: 20,
  engineRpm: 8,
  fuelPressure: 6,
  lubOilPressure: 6,
  coolantPressure: 6,
};

// The longest any single metric is ever willing to be bridged — used as the
// row-level "is there any point even trying to fill this gap" gate.
export const MAX_FILLABLE_GAP_SECONDS = Math.max(...Object.values(MAX_FILLABLE_GAP_SECONDS_BY_METRIC));

// Implied rate-of-change ceilings (unit/sec) used as a proxy "something
// abrupt likely happened mid-gap" signal, even when status labels match at
// both endpoints of a gap. Both temperatures are intentionally omitted (same
// as motorTemp before them) — thermal mass makes instantaneous ramp rate a
// poor signal; see thresholds.yaml's rateOfChangeMax reasoning for the
// window-mean alternative used there instead.
export const MAX_RAMP_RATE_PER_SECOND = {
  engineRpm: 1500,
  fuelPressure: 3,
  lubOilPressure: 3,
  coolantPressure: 3,
};

// RETIRED (2026-08-26, plan §4.1): served only the deleted
// dischargePressure > suctionPressure rule, which has no engine analogue.

// A status change (or an already-invalid neighbor) within this many seconds
// of a physics check is tolerated as a plausible transition (equalization,
// coast-down, inertia/backflow) rather than flagged.
export const STATUS_TRANSITION_GRACE_SECONDS = 5;

// Reserved for a future debounced-status read (requiring N consecutive
// samples agreeing on status before enforcing state-dependent physics
// rules) — not yet wired into validator.js's single-sample check.
export const STATUS_DEBOUNCE_SAMPLES = 3;
