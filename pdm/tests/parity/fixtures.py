"""Golden-value parity suite fixtures (docs/plan/2026-08-05-pdm-
implementation.md §11.6.5) — single source of truth for the raw sample
sequences run through BOTH the JS reference pipeline
(server/scripts/parity/run_js_pipeline.mjs) and the Python pipeline
(pdm/app/preprocessing/pipeline.py::process_window), so both languages see
byte-identical input.

Every synthetic fixture is a single, self-contained 60-second window with NO
prevSample context (prev_sample=None / no preceding samples fed to the JS
harness before this window). This is a deliberate scoping choice, not an
oversight: pipeline.py's module docstring already documents that cross-
window fill-row attribution (a gap straddling two windows) is a known,
flagged simplification versus the JS original — exercising that boundary
here would conflate "is the Python port's own-window logic correct" with
"is the already-documented cross-window simplification a problem," which
are two different questions. This suite answers the first one cleanly;
the second is explicitly out of scope here.

Every synthetic fixture's samples fall within the same epoch-aligned
60-second window ([2026-01-01T00:00:00.000Z, 2026-01-01T00:01:00.000Z)) so
buffer.js's windowStartMsFor() closes exactly one window per fixture.

`real_running_window` is the one exception: it's read directly from the
validated synthetic corpus (data/pump-telemetry/, §13 of the plan doc)
rather than hand-built, to exercise real jitter/noise shape the synthetic
fixtures above don't have. Gap/physics-violation/outlier fixtures can't be
sourced from that corpus — §13.2's validation confirms it has no gaps, no
out-of-range values, and no isolated single-tick spikes by construction —
so those five stay synthetic; this fixture only covers the "normal
operation, real data" case. Skipped (not failed) if the corpus isn't
present in the checkout.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

WINDOW_START = datetime(2026, 1, 1, tzinfo=timezone.utc)
WINDOW_END = WINDOW_START + timedelta(seconds=60)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
CORPUS_DIR = REPO_ROOT / "data" / "pump-telemetry"

# A real, hand-verified 60-second RUNNING window from the corpus: day
# 2026-05-15, [20:00:00, 20:01:00)Z. That day's only fault episode
# (EP0057, DRY_RUN) runs 11:54:54-12:03:55Z per
# data/pump-telemetry-episodes.csv — nearly eight hours clear of this
# window, so it's unambiguously quiet, steady-state RUNNING data.
REAL_WINDOW_DATE = "2026-05-15"
REAL_WINDOW_START = datetime(2026, 5, 15, 20, 0, 0, tzinfo=timezone.utc)
REAL_WINDOW_END = REAL_WINDOW_START + timedelta(seconds=60)


def _ts(seconds: float) -> str:
    return (WINDOW_START + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


def _sample(seconds: float, **overrides) -> dict:
    row = {
        "timestamp": _ts(seconds),
        "status": "RUNNING",
        "flowRate": 200.0,
        "rpm": 1500.0,
        # small deterministic jitter so Hampel MAD isn't degenerately zero
        # on a perfectly flat baseline (see outlier.py's test suite for why).
        "vibration": round(2.0 + (seconds % 3) * 0.05, 2),
        "suctionPressure": 3.0,
        "dischargePressure": 8.0,
        "motorTemp": 60.0,
    }
    row.update(overrides)
    return row


def _normal_operation() -> list[dict]:
    return [_sample(i) for i in range(60)]


def _gap_requiring_fill() -> list[dict]:
    # Seconds 20-24 never arrive (5-second dropout) — exceeds vibration's
    # own (lower) MAX_FILLABLE_GAP_SECONDS_BY_METRIC ceiling, so vibration
    # is expected to come back partially unfilled on this gap, exercising
    # the per-metric-ceiling code path in both languages too.
    return [_sample(i) for i in range(60) if not (20 <= i <= 24)]


def _physics_violation_sensor_fault() -> list[dict]:
    # A short flatlined run (2 samples pinned at the exact same
    # out-of-range value, with valid neighbors on both sides) —
    # fault_classifier.py/faultClassifier.js's SENSOR_FAULT flatline
    # signature — must get interpolated/repaired identically by both
    # languages.
    samples = _normal_operation()
    for i in (30, 31):
        samples[i] = _sample(i, vibration=-5.0)  # out of range (min=0)
    return samples


def _outlier_requiring_capping() -> list[dict]:
    # A single-sample spike, well isolated (varied baseline nearby so the
    # local MAD isn't degenerate-zero) — must get Hampel-capped identically.
    samples = _normal_operation()
    samples[30] = _sample(30, vibration=20.0)
    return samples


def _abnormal_operation_no_capping() -> list[dict]:
    # A genuine 4-sample FAULT episode with an explicit faultType and a
    # clearly out-of-range reading — fault_classifier's strongest
    # NOT_SENSOR_FAULT signal (explicit FAULT+faultType). Must NOT be
    # repaired or capped in either language, and must NOT penalize
    # physicsPassRate/qualityScore (§10.5's reminder).
    samples = _normal_operation()
    for i in range(30, 34):
        samples[i] = _sample(i, status="FAULT", faultType="BEARING", vibration=30.0)
    return samples


def _real_running_window() -> list[dict] | None:
    """Read the fixed real window described above from the corpus. Returns
    None (not an exception) if the corpus isn't present in this checkout —
    the test collection guards on this and skips rather than fails."""
    day_dir = CORPUS_DIR / f"date={REAL_WINDOW_DATE}"
    if not day_dir.exists():
        return None

    import pandas as pd

    day = pd.read_parquet(day_dir)
    day["timestamp"] = pd.to_datetime(day["timestamp"], utc=True)
    day = day.sort_values("timestamp").reset_index(drop=True)
    window = day[(day["timestamp"] >= REAL_WINDOW_START) & (day["timestamp"] < REAL_WINDOW_END)]

    assert len(window) == 60, (
        f"real_running_window: expected exactly 60 rows in "
        f"[{REAL_WINDOW_START}, {REAL_WINDOW_END}), got {len(window)} — "
        "corpus content may have changed since this fixture was pinned"
    )
    assert (window["status"] == "RUNNING").all(), (
        "real_running_window: expected an all-RUNNING window — corpus content "
        "may have changed since this fixture was pinned"
    )

    return [
        {
            "timestamp": row["timestamp"].strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "status": row["status"],
            "flowRate": float(row["flowRate"]),
            "rpm": float(row["rpm"]),
            "vibration": float(row["vibration"]),
            "suctionPressure": float(row["suctionPressure"]),
            "dischargePressure": float(row["dischargePressure"]),
            "motorTemp": float(row["motorTemp"]),
        }
        for _, row in window.iterrows()
    ]


FIXTURES: dict[str, list[dict]] = {
    "normal_operation": _normal_operation(),
    "gap_requiring_fill": _gap_requiring_fill(),
    "physics_violation_sensor_fault": _physics_violation_sensor_fault(),
    "outlier_requiring_capping": _outlier_requiring_capping(),
    "abnormal_operation_no_capping": _abnormal_operation_no_capping(),
}

# WINDOW_START/WINDOW_END for the real-corpus fixture differ from the
# synthetic fixtures' epoch — test_golden_values.py looks up the right pair
# per fixture via FIXTURE_WINDOWS rather than assuming the module-level
# WINDOW_START/WINDOW_END apply to every entry.
FIXTURE_WINDOWS: dict[str, tuple[datetime, datetime]] = {
    name: (WINDOW_START, WINDOW_END) for name in FIXTURES
}

_real_window = _real_running_window()
if _real_window is not None:
    FIXTURES["real_running_window"] = _real_window
    FIXTURE_WINDOWS["real_running_window"] = (REAL_WINDOW_START, REAL_WINDOW_END)
