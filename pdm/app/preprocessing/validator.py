"""validator.py — physics-informed validation, ported from
server/preprocessing/validator.js. Reads RANGES from pump-physics.yaml
(pdm/app/physics.py) instead of a hardcoded copy — the same file
server/utils/validation.js now also loads from (docs/plan/2026-08-05-pdm-
implementation.md §11.5 item 3 / §11.6.1).

This NEVER rejects a reading — it only annotates it. Hard rejection of
impossible values stays in Node (middleware/validateReading.js), unaffected
by this migration.
"""

from __future__ import annotations

from typing import Any, Optional

from ..physics import load_ranges
from .config import PRESSURE_EQUALIZATION_TOLERANCE_BAR
from .transition import detect_transition

RANGES = load_ranges()
METRICS = list(RANGES.keys())


def validate_physics(
    sample: dict[str, Any],
    prev_sample: Optional[dict[str, Any]] = None,
    dt_sec: Optional[float] = None,
) -> dict[str, Any]:
    violations: list[str] = []

    # A metric that's null was never measured/reconstructed with confidence —
    # exclude it from validation entirely rather than defaulting (None would
    # need coercion to compare, which risks fabricating a violation).
    for metric in METRICS:
        value = sample.get(metric)
        if value is None:
            continue
        bounds = RANGES[metric]
        if value < bounds["min"] or value > bounds["max"]:
            violations.append(f"{metric} out of range")

    transition = (
        detect_transition(prev_sample, sample, dt_sec)
        if prev_sample is not None and dt_sec is not None
        else None
    )
    tolerated = bool(transition and transition["suspected"] and transition["withinGraceWindow"])

    # A centrifugal pump always adds head while running; while stopped or
    # during pressure equalization, discharge may legitimately approach or
    # dip below suction — tolerate that within a transition grace window.
    discharge = sample.get("dischargePressure")
    suction = sample.get("suctionPressure")
    if discharge is not None and suction is not None:
        if sample.get("status") == "STOPPED" or tolerated:
            within_tolerance = discharge >= suction - PRESSURE_EQUALIZATION_TOLERANCE_BAR
        else:
            within_tolerance = discharge > suction
        if not within_tolerance:
            violations.append("dischargePressure must exceed suctionPressure")

    # Status/measurement consistency: a STOPPED pump should show ~zero
    # flow/rpm, but inertia/drainage/backflow/coast-down can keep both
    # nonzero briefly right after a stop — tolerate within the grace window.
    flow_rate = sample.get("flowRate")
    rpm = sample.get("rpm")
    if sample.get("status") == "STOPPED" and flow_rate is not None and rpm is not None:
        if not tolerated and (flow_rate > 20 or rpm > 200):
            violations.append("STOPPED status but flow/rpm indicate the pump is running")

    return {
        "physicsValid": len(violations) == 0,
        "physicsViolations": violations if violations else None,
    }
