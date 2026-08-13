"""outlier.py — Hampel-filter outlier detection, ported from
server/preprocessing/outlier.js: median + MAD (median absolute deviation),
scaled by 1.4826 to be a consistent estimator of standard deviation under
normality. Outliers are CAPPED to their LOCAL median, never deleted.

Uses a SLIDING local window (± HALF_WINDOW samples), not one median for the
entire minute — see the JS original's comments for the full reasoning
(a genuine ramp stays uncapped within a local neighborhood; a single
window-wide median would falsely flag large swaths of a real ramp).

NUMERIC PARITY WARNING: js_median (see _stats.py) must be used here, never
numpy.median/statistics.median — JS's medianOf() takes the UPPER-MIDDLE
element on an even-length array, not the textbook average of the two middle
values. Using a library median would silently diverge from the JS original
on every even-sized neighborhood.

NULL-COERCION PARITY: `values` can contain None — an IMPUTED fill row whose
per-metric ceiling was exceeded (unfilledMetrics) but that was never part of
an invalid run (so missing.py::impute_invalid_runs never touched or excluded
it) still flows into this function untouched, same as in the JS original.
JS's `Math.abs(null - median)` and `Array.sort((a,b) => a-b)` both coerce
`null` to `0` implicitly in arithmetic — Python raises TypeError on None
arithmetic instead of silently matching that, so `js_number()` (_stats.py)
performs the same coercion explicitly, only for the sort/threshold math;
`capped[i]` still preserves the original None if that index isn't flagged
an outlier, exactly as aggregation.py's null-filtering comment expects.
"""

from __future__ import annotations

from typing import Optional

from ._stats import js_median, js_number, js_round
from .config import HALF_WINDOW_SECONDS, SAMPLE_INTERVAL_SECONDS

# Derived from real seconds / cadence, not hardcoded, so a cadence change
# doesn't silently desync the neighborhood size from real elapsed time.
# js_round (not Python's banker's-rounding round()), for parity with JS
# Math.round if these constants are ever changed to non-integer-divisible
# values — currently exact (3/1), so both agree today.
HALF_WINDOW = max(1, int(js_round(HALF_WINDOW_SECONDS / SAMPLE_INTERVAL_SECONDS)))


def hampel_cap(
    values: list[Optional[float]],
    k: float = 3,
    exclude_mask: Optional[list[bool]] = None,
) -> dict[str, object]:
    """@param values one metric's raw values across the window (may contain
        None — see the NULL-COERCION PARITY note above).
    @param k outlier threshold in MAD units.
    @param exclude_mask same length as values; True at indices flagged
        abnormalOperation by missing.py::impute_invalid_runs. Excluded
        samples are never capped themselves, AND are filtered out of every
        OTHER point's neighborhood so they can't drag a neighbor's
        median/MAD baseline toward them.
    @returns {"capped": list[float | None], "outlierCount": int}
    """
    n = len(values)
    capped = list(values)
    outlier_count = 0

    for i in range(n):
        if exclude_mask and exclude_mask[i]:
            continue  # never capped; capped[i] stays values[i]

        start = max(0, i - HALF_WINDOW)
        end = min(n, i + HALF_WINDOW + 1)
        neighborhood = values[start:end]

        if exclude_mask:
            filtered = [v for idx, v in enumerate(neighborhood) if not exclude_mask[start + idx]]
            # If every neighbor is excluded (a long abnormal-operation run),
            # fall back to the unfiltered neighborhood for this one point
            # rather than computing median/MAD over an empty array.
            if filtered:
                neighborhood = filtered

        numeric_neighborhood = [js_number(v) for v in neighborhood]
        median = js_median(numeric_neighborhood)
        mad = 1.4826 * js_median([abs(v - median) for v in numeric_neighborhood])

        if mad > 0 and abs(js_number(values[i]) - median) > k * mad:
            outlier_count += 1
            capped[i] = median

    return {"capped": capped, "outlierCount": outlier_count}
