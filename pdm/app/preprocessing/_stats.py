"""Shared numeric helpers used across the preprocessing port, mirroring exact
JS Math.round/Array.sort-based semantics so the Python port doesn't silently
diverge from server/preprocessing/{aggregation,outlier,precapFeatures}.js on
tie-breaking or even-length median behavior (docs/plan/2026-08-05-pdm-
implementation.md §11.6.2's parity concern).

js_round: JS `Math.round(x)` is `floor(x + 0.5)` for ALL reals (including
negatives) — ties round toward +Infinity, not away from zero and not
to-even. Python's builtin `round()` uses banker's rounding (round-half-to-
even) and would silently diverge on exact .5 ties; `numpy.round` also uses
round-half-to-even. Neither is a safe substitute here.

js_median: JS's `medianOf()` (outlier.js/aggregation.js/precapFeatures.js)
is `sorted[Math.floor(sorted.length / 2)]` — for an EVEN-length array this
is the upper-middle element, not the textbook average of the two middle
values `statistics.median`/`numpy.median` would compute. Must be hand-
ported exactly; every ported module importing "median" imports this one
function rather than reimplementing it.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone


def parse_ts_ms(timestamp: str) -> float:
    """Mirror JS `Date.parse(timestamp)` -> epoch milliseconds. Python 3.12's
    `datetime.fromisoformat` accepts a trailing 'Z' natively (3.11+), so no
    manual '+00:00' substitution is needed given pdm/Dockerfile's pin."""
    return datetime.fromisoformat(timestamp).timestamp() * 1000


def ms_to_iso(ms: float) -> str:
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def js_round(value: float) -> float:
    return math.floor(value + 0.5)


def js_median(values: list[float]) -> float:
    sorted_values = sorted(values)
    return sorted_values[len(sorted_values) // 2]


def round2(value: float) -> float:
    return js_round(value * 100) / 100


def js_number(value: float | None) -> float:
    """Mirror JS's implicit `null` -> `0` coercion in numeric arithmetic
    (`Math.abs(null - x)`, `Array.sort((a,b) => a-b)` on a mixed array,
    `[...].reduce((a,b) => a+b, 0)`). Used only where the JS original's
    array can genuinely contain `null` and still flows into plain
    arithmetic without an explicit null-check first — see outlier.py's and
    precap_features.py's NULL-COERCION PARITY notes."""
    return 0.0 if value is None else value
