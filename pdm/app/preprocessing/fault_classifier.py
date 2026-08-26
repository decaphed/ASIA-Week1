"""fault_classifier.py — ported from server/preprocessing/faultClassifier.js.
Distinguishes invalid data caused by sensor/wiring/scaling/configuration/
communication failure (SENSOR_FAULT, safe to repair in the stats-facing
copy) from valid measurements indicating genuine abnormal physical operation
(NOT_SENSOR_FAULT, must be preserved unrepaired as evidence for PdM/fault-
diagnosis/alarm analysis — see §10.5's reminder that real fault signal must
not be capped/repaired away).

No ground-truth fault signal exists in this data model — this is inherently
a statistical-signature heuristic. Any run this classifier can't confidently
attribute to a sensor-fault signature defaults to NOT_SENSOR_FAULT (never
repaired) rather than guessing.
"""

from __future__ import annotations

from typing import Any, Optional

EPSILON = 1e-6

METRICS = ["engineRpm", "lubOilPressure", "fuelPressure", "coolantPressure", "lubOilTemperature", "coolantTemperature"]


def _violates_range(sample: dict[str, Any], metric: str, ranges: dict[str, dict[str, float]]) -> bool:
    value = sample.get(metric)
    if value is None:
        return False
    bounds = ranges[metric]
    return value < bounds["min"] or value > bounds["max"]


def _is_flatlined(run: list[dict[str, Any]], metric: str) -> bool:
    values = [s[metric] for s in run if s.get(metric) is not None]
    if len(values) < 2:
        return False
    return all(abs(v - values[0]) < EPSILON for v in values)


def _is_pinned_at_boundary(run: list[dict[str, Any]], metric: str, ranges: dict[str, dict[str, float]]) -> bool:
    bounds = ranges[metric]
    values = [s[metric] for s in run if s.get(metric) is not None]
    if not values:
        return False
    return all(abs(v - bounds["min"]) < EPSILON or abs(v - bounds["max"]) < EPSILON for v in values)


def _is_spike_and_return(
    run: list[dict[str, Any]],
    before: Optional[dict[str, Any]],
    after: Optional[dict[str, Any]],
    metric: str,
) -> bool:
    if not before or not after or len(run) > 2:
        return False
    if before.get(metric) is None or after.get(metric) is None or run[0].get(metric) is None:
        return False
    excursion = abs(run[0][metric] - before[metric])
    if excursion < EPSILON:
        return False
    residual = abs(after[metric] - before[metric])
    return residual < excursion * 0.3


def classify_invalid_run(
    run: list[dict[str, Any]],
    before: Optional[dict[str, Any]],
    after: Optional[dict[str, Any]],
    ranges: dict[str, dict[str, float]],
) -> str:
    """@returns 'SENSOR_FAULT' | 'NOT_SENSOR_FAULT'"""
    if not run:
        return "NOT_SENSOR_FAULT"

    # An explicit, upstream-diagnosed fault status is the strongest available
    # signal that this is genuine abnormal operation, not a sensor problem.
    if any(s.get("status") == "FAULT" and s.get("faultType") for s in run):
        return "NOT_SENSOR_FAULT"

    excursion_metrics = [m for m in METRICS if any(_violates_range(s, m, ranges) for s in run)]

    for metric in excursion_metrics:
        if _is_flatlined(run, metric):
            return "SENSOR_FAULT"
        if _is_pinned_at_boundary(run, metric, ranges):
            return "SENSOR_FAULT"
        if _is_spike_and_return(run, before, after, metric):
            return "SENSOR_FAULT"

    # Two or more metrics moving out of range together is far more consistent
    # with a real, physically-coherent process fault than with sensor noise.
    if len(excursion_metrics) >= 2:
        return "NOT_SENSOR_FAULT"

    # A long run is more consistent with a genuine regime transition than a
    # transient sensor glitch.
    if len(run) >= 4:
        return "NOT_SENSOR_FAULT"

    return "NOT_SENSOR_FAULT"
