"""precap_features.py — pre-cap feature capture, ported from
server/preprocessing/precapFeatures.js. hampelCap's whole job is to smooth
away exactly the kind of spike/rapid-change signal that would precede a real
pump fault — this module computes a few small descriptive stats over the
SAME raw (pre-cap) per-metric array outlier.hampel_cap consumes, so that
signal is preserved as its own derived feature set instead of being
discarded. Pure function: mirrors aggregation.py's round2()/variance
conventions exactly, including the same js_median parity requirement.

NULL-COERCION PARITY: `values` (stats_window's raw per-metric array, same
array outlier.py's hampel_cap consumes) can contain None — see outlier.py's
matching note. JS's `reduce`/arithmetic coerce `null` to `0` implicitly;
`_as_number()` mirrors that explicitly since Python doesn't.

SUMMATION PARITY: mean/variance use `js_sum` (naive left-to-right float
addition), not the builtin `sum()` — see aggregation.py's matching note;
CPython 3.12+'s compensated `sum()` can round a `.xx5`-boundary mean
differently than JS's `.reduce()` on real data.
"""

from __future__ import annotations

import math
from typing import Any, Optional

from ._stats import js_median, js_number, js_sum
from .aggregation import round2


def compute_precap_features(values: list[Optional[float]]) -> dict[str, Any]:
    """@param values one metric's RAW values across the window, BEFORE
        hampel_cap — the same array pipeline.py hands to outlier.hampel_cap
        (may contain None; see NULL-COERCION PARITY above).
    @returns {rawStdDev, rawRateOfChange, rawMaxExcursion}:
      rawStdDev — population standard deviation of values (same math as
        aggregation.py's per-metric stdDev, on the uncapped series).
      rawRateOfChange — mean of the absolute tick-to-tick differences.
      rawMaxExcursion — the largest absolute deviation of any single raw
        sample from values' own median.
    """
    n = len(values)
    numeric_values = [js_number(v) for v in values]

    mean_val = js_sum(numeric_values) / n
    variance = js_sum((v - mean_val) ** 2 for v in numeric_values) / n
    raw_std_dev = round2(math.sqrt(variance))

    diff_sum = 0.0
    for i in range(1, n):
        diff_sum += abs(numeric_values[i] - numeric_values[i - 1])
    raw_rate_of_change = round2(diff_sum / (n - 1) if n > 1 else 0)

    sorted_values = sorted(numeric_values)
    median = js_median(sorted_values)
    raw_max_excursion = round2(max(abs(v - median) for v in numeric_values))

    return {
        "rawStdDev": raw_std_dev,
        "rawRateOfChange": raw_rate_of_change,
        "rawMaxExcursion": raw_max_excursion,
    }
