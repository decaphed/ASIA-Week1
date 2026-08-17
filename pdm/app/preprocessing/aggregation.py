"""aggregation.py — one-minute aggregation, ported from
server/preprocessing/aggregation.js. Per metric: mean/median/min/max/stdDev
(from the outlier-capped, physics-VALID series) plus "last" (the true,
uncapped final valid value — real instantaneous state). Also derives the
operating-status breakdown (dominantStatus + per-status seconds), which uses
the FULL audit window — status classification isn't a physics-validity
concern.

NUMERIC PARITY WARNINGS (see _stats.py for the shared helpers this module
must use, not numpy/pandas equivalents):
  - `round2` uses JS Math.round tie-breaking (ties toward +Infinity), not
    Python's round() (banker's rounding).
  - median uses js_median (upper-middle element on even-length arrays), not
    statistics.median/numpy.median (which average the two middle values).
  - variance is POPULATION variance (ddof=0) — numpy.var(..., ddof=0)
    matches; pandas.Series.var() defaults to ddof=1 (sample variance) and
    would silently diverge if ever substituted here.
  - mean/variance accumulation uses `js_sum` (naive left-to-right float
    addition), not the builtin `sum()` — CPython 3.12+'s builtin `sum()`
    uses compensated summation for floats, which is MORE accurate than JS's
    `.reduce((a,b) => a+b, 0)` and can round a `.xx5`-boundary mean
    differently as a result. Caught by the golden-value parity suite
    (§11.6.5) against real corpus data, not a synthetic fixture — see that
    suite's `real_running_window` fixture.
"""

from __future__ import annotations

import math
from typing import Any

from ._stats import js_median, js_sum, round2
from .config import METRICS

__all__ = ["round2", "aggregate_window"]


def aggregate_window(
    window: list[dict[str, Any]],
    stats_window: list[dict[str, Any]],
    capped_by_metric: dict[str, list[float]],
) -> dict[str, Any]:
    """@param window the full completed audit window (every sample that
        arrived, physics-valid or not), in arrival order.
    @param stats_window same length as window, with physics-invalid runs
        replaced by interpolated values (missing.py::impute_invalid_runs) —
        what capped_by_metric was computed from.
    @param capped_by_metric outlier-capped series per metric, aligned with
        stats_window.
    @returns aggregate stats, status breakdown, sample count, window bounds.
    """
    stats: dict[str, dict[str, Any]] = {}

    for metric in METRICS:
        raw = [sample.get(metric) for sample in stats_window]
        capped = capped_by_metric[metric]

        # A None capped value means that sample's fill row couldn't
        # confidently reconstruct this specific metric — excluding it from
        # arithmetic is required (None can't participate in a numeric
        # reduce/min/max the way JS's null-coerces-to-0 risk would).
        non_null_capped = [v for v in capped if v is not None and math.isfinite(v)]
        if not non_null_capped:
            # Provably unreachable given the ceiling design (pipeline.py
            # already skips a window entirely if every sample fails physics
            # validation before this ever runs) — but fail loudly via the
            # caller if the upstream invariant ever breaks, rather than
            # silently fabricating a value.
            raise ValueError(f'aggregateWindow: metric "{metric}" has no non-null values in this window')
        n = len(non_null_capped)

        mean_val = js_sum(non_null_capped) / n
        sorted_capped = sorted(non_null_capped)
        median_val = js_median(sorted_capped)
        variance = js_sum((v - mean_val) ** 2 for v in non_null_capped) / n

        # "last" is the most recent NON-null raw value for this specific
        # metric — a plain raw[-1] would go None if the window's final
        # sample happened to be a partial-fill row that left this unfilled.
        last_val = None
        for v in reversed(raw):
            if v is not None:
                last_val = v
                break

        stats[metric] = {
            "mean": round2(mean_val),
            "median": round2(median_val),
            "min": min(non_null_capped),
            "max": max(non_null_capped),
            "stdDev": round2(math.sqrt(variance)),
            "last": last_val,
            "count": n,
        }

    # Status classification uses the FULL audit window — a physics violation
    # doesn't invalidate what the sensor reported its own status as.
    status_counts = {"RUNNING": 0, "FAULT": 0, "STOPPED": 0}
    for sample in window:
        status = sample.get("status")
        status_counts[status] = status_counts.get(status, 0) + 1
    dominant_status = sorted(status_counts.keys(), key=lambda s: status_counts[s], reverse=True)[0]

    # Dominant fault signature, same tally/tie-break pattern as
    # dominantStatus above, but counted only over FAULT samples that
    # actually carry a faultType.
    fault_type_counts: dict[str, int] = {}
    for sample in window:
        if sample.get("status") == "FAULT" and sample.get("faultType"):
            fault_type = sample["faultType"]
            fault_type_counts[fault_type] = fault_type_counts.get(fault_type, 0) + 1
    dominant_fault_type = (
        None
        if not fault_type_counts
        else sorted(fault_type_counts.keys(), key=lambda f: fault_type_counts[f], reverse=True)[0]
    )

    return {
        "stats": stats,
        "dominantStatus": dominant_status,
        "dominantFaultType": dominant_fault_type,
        "runningSeconds": status_counts["RUNNING"],
        "faultSeconds": status_counts["FAULT"],
        "stoppedSeconds": status_counts["STOPPED"],
        "sampleCount": len(window),
        "windowStart": window[0]["timestamp"],
        "windowEnd": window[-1]["timestamp"],
    }
