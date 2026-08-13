"""config.py — single source of truth for cadence, windowing, and tolerance
constants, ported verbatim from server/preprocessing/config.js. Used across
missing.py, validator.py, outlier.py, transition.py, and fault_classifier.py.

PROVISIONAL VALUES — same status as the JS original: SAMPLE_INTERVAL_SECONDS
is confirmed only against this project's own simulator; the tolerance/ramp
constants are physically-reasoned placeholders, not derived from real pump
coast-down/equalization data.
"""

from ._stats import js_round

# Same 6-metric order as server/services/forecastService.js::METRICS (the
# JS side's single source of truth, already relied on by aggregation.js/
# faultClassifier.js) — order matters for tie-break-by-insertion-order logic
# in aggregation.py's dominantStatus/dominantFaultType port.
METRICS = ["flowRate", "rpm", "vibration", "suctionPressure", "dischargePressure", "motorTemp"]

SAMPLE_INTERVAL_SECONDS = 1
WINDOW_DURATION_SECONDS = 60
# js_round (not Python's banker's-rounding round()), for parity with JS
# Math.round if these constants are ever changed to non-integer-divisible
# values — currently exact (60/1), so both agree today.
EXPECTED_SAMPLE_COUNT = int(js_round(WINDOW_DURATION_SECONDS / SAMPLE_INTERVAL_SECONDS))

# Fixed-length, timestamp-sorted, window-boundary-independent tail used only
# so fault_classifier can find a chronological "before" neighbor for a run
# that starts at the very beginning of a window (whose true predecessor is in
# an already-closed/evicted window). Not used directly by pipeline.py's
# stateless orchestration (prevSample from the request payload plays this
# role instead — see missing.py::impute_invalid_runs), kept for parity with
# the JS constant list.
RECENT_TAIL_SIZE = 10

# Hampel neighborhood half-width, in real seconds — outlier.py derives its
# sample-count HALF_WINDOW from this divided by SAMPLE_INTERVAL_SECONDS, so a
# cadence change doesn't silently desync the neighborhood from real time.
HALF_WINDOW_SECONDS = 3

# Per-metric interpolation ceilings: how long a gap can be before a straight
# line is trusted, differentiated by how fast each metric plausibly moves.
MAX_FILLABLE_GAP_SECONDS_BY_METRIC = {
    "motorTemp": 20,
    "rpm": 8,
    "flowRate": 7,
    "suctionPressure": 6,
    "dischargePressure": 6,
    "vibration": 3,
}

# The longest any single metric is ever willing to be bridged — used as the
# row-level "is there any point even trying to fill this gap" gate.
MAX_FILLABLE_GAP_SECONDS = max(MAX_FILLABLE_GAP_SECONDS_BY_METRIC.values())

# Implied rate-of-change ceilings (unit/sec) used as a proxy "something
# abrupt likely happened mid-gap" signal, even when status labels match at
# both endpoints of a gap.
MAX_RAMP_RATE_PER_SECOND = {
    "rpm": 1500,
    "flowRate": 100,
    "vibration": 5,
    "suctionPressure": 3,
    "dischargePressure": 3,
}

# How far discharge pressure may dip below suction pressure while
# stopped/equalizing without being flagged a physics violation.
PRESSURE_EQUALIZATION_TOLERANCE_BAR = 1.0

# A status change (or an already-invalid neighbor) within this many seconds
# of a physics check is tolerated as a plausible transition (equalization,
# coast-down, inertia/backflow) rather than flagged.
STATUS_TRANSITION_GRACE_SECONDS = 5
