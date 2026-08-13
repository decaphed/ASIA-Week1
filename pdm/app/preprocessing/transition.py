"""transition.py — shared operating-state-transition signal, ported from
server/preprocessing/transition.js. Consumed by both validator.py (which
TOLERATES a suspected transition within the grace window, to avoid
false-flagging equalization/coast-down/inertia) and missing.py (which BLOCKS
gap-fill on the categorical signals, and blocks per-metric fill on that
metric's ramp-rate signal). Same underlying question, answered once, applied
with different policies at different pipeline stages.
"""

from __future__ import annotations

from typing import Any, Optional


def detect_transition(from_sample: dict[str, Any], to_sample: dict[str, Any], dt_sec: Optional[float]) -> dict[str, Any]:
    from .config import MAX_RAMP_RATE_PER_SECOND, STATUS_TRANSITION_GRACE_SECONDS

    status_changed = from_sample.get("status") != to_sample.get("status")
    either_invalid = from_sample.get("physicsValid") is False or to_sample.get("physicsValid") is False

    ramp_exceeded: dict[str, bool] = {}
    any_ramp_exceeded = False
    for metric, max_rate in MAX_RAMP_RATE_PER_SECOND.items():
        from_val = from_sample.get(metric)
        to_val = to_sample.get(metric)
        if from_val is None or to_val is None or not dt_sec:
            ramp_exceeded[metric] = False
            continue
        implied_rate = abs(to_val - from_val) / dt_sec
        ramp_exceeded[metric] = implied_rate > max_rate
        if ramp_exceeded[metric]:
            any_ramp_exceeded = True

    suspected = status_changed or either_invalid or any_ramp_exceeded
    within_grace_window = dt_sec is not None and dt_sec <= STATUS_TRANSITION_GRACE_SECONDS

    return {
        "statusChanged": status_changed,
        "eitherInvalid": either_invalid,
        "rampExceeded": ramp_exceeded,
        "anyRampExceeded": any_ramp_exceeded,
        "suspected": suspected,
        "withinGraceWindow": within_grace_window,
    }
