"""validator.py — physics-informed validation, ported from
server/preprocessing/validator.js. Reads RANGES from engine-physics.yaml
(pdm/app/physics.py) instead of a hardcoded copy — the same file
server/utils/validation.js now also loads from (docs/plan/2026-08-05-pdm-
implementation.md §11.5 item 3 / §11.6.1).

This NEVER rejects a reading — it only annotates it. Hard rejection of
impossible values stays in Node (middleware/validateReading.js), unaffected
by this migration.

Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
migration.md Phase 2 step 4 / §4.1. The old dischargePressure > suctionPressure
rule (centrifugal-pump head reasoning) has NO engine analogue and is deleted
outright, not renamed. Per docs/analysis/2026-08-26-train-csv-
characterization.md, every pairwise correlation among the six engine metrics
is |r| <= 0.072 — far below the plan's |r| >= 0.15 evidentiary bar — so the
proposed cross-variable rules R2 (oil pressure vs. speed), R3 (coolant
pressure vs. coolant temp), and R4 (oil/coolant temp coupling) are NOT
implemented for lack of evidence. Only R1 (stopped-engine consistency, the
direct port of the surviving pump STOPPED rule) remains.
"""

from __future__ import annotations

from typing import Any, Optional

from ..physics import load_ranges
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

    # R1 — status/measurement consistency: a STOPPED engine should show ~zero
    # RPM, but inertia/coast-down can keep it nonzero briefly right after a
    # stop — tolerate within the grace window. This cannot be validated
    # against data/train.csv itself (no status column there); it can only be
    # exercised once the Phase 5 engine simulator emits status.
    engine_rpm = sample.get("engineRpm")
    if sample.get("status") == "STOPPED" and engine_rpm is not None:
        if not tolerated and engine_rpm > 200:
            violations.append("STOPPED status but engineRpm indicates the engine is running")

    return {
        "physicsValid": len(violations) == 0,
        "physicsViolations": violations if violations else None,
    }
