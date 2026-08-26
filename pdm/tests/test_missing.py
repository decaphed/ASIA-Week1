"""Unit tests for pdm/app/preprocessing/missing.py — gap detection, gap-fill
generation, and physics-invalid-run repair/preservation (§11.6.2's last
bullet). Mirrors test_rules.py's plain-assert, hand-built-fixture style.

Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
migration.md Phase 9. "vibration"/"motorTemp" (the pump metrics these tests
were built around, chosen for their 3s/20s gap-ceiling contrast) are
replaced with "coolantPressure" (6s ceiling) / "coolantTemperature" (20s
ceiling) — same contrast, different concrete metrics.
"""

from datetime import datetime, timedelta, timezone

from app.preprocessing.missing import detect_missing, generate_fill_samples, impute_invalid_runs

BASE = datetime(2026, 1, 1, tzinfo=timezone.utc)
RANGES = {
    "engineRpm": {"min": 0, "max": 2500},
    "lubOilPressure": {"min": 0, "max": 8.5},
    "fuelPressure": {"min": 0, "max": 23},
    "coolantPressure": {"min": 0, "max": 9},
    "lubOilTemperature": {"min": 65, "max": 95},
    "coolantTemperature": {"min": 60, "max": 108},
}
METRICS = list(RANGES.keys())


def ts(seconds: float) -> str:
    return (BASE + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


def sample(seconds: float, **overrides) -> dict:
    row = {
        "timestamp": ts(seconds),
        "status": "RUNNING",
        "engineRpm": 800.0,
        "lubOilPressure": 4.0,
        "fuelPressure": 8.0,
        "coolantPressure": 3.0,
        "lubOilTemperature": 80.0,
        "coolantTemperature": 78.0,
    }
    row.update(overrides)
    return row


# ── detect_missing ──────────────────────────────────────────────────────


def test_detect_missing_no_gaps():
    samples = [sample(i) for i in range(5)]
    assert detect_missing(samples) == 0


def test_detect_missing_residual_gap():
    samples = [sample(0), sample(10)]  # 9-tick gap
    assert detect_missing(samples) == 9


def test_detect_missing_leading_and_trailing_boundary_gaps():
    samples = [sample(5), sample(6)]
    count = detect_missing(samples, window_start=ts(0), window_end=ts(10))
    # leading gap ~5s, trailing gap ~4s, both above the 1.5s threshold
    assert count == 5 + 4


# ── generate_fill_samples ───────────────────────────────────────────────


def test_generate_fill_samples_no_last_sample_returns_empty():
    assert generate_fill_samples(None, sample(5), METRICS) == []


def test_generate_fill_samples_fills_within_ceiling():
    # 3-second gap: well within coolantPressure's ceiling (6s, the tightest
    # of all six metrics along with engineRpm/fuelPressure/lubOilPressure),
    # so every metric — including coolantPressure — still fills.
    last = sample(0, coolantPressure=2.0)
    new = sample(3, coolantPressure=5.0)
    fills = generate_fill_samples(last, new, METRICS)
    assert len(fills) == 2
    assert all(f["provenance"] == "IMPUTED" for f in fills)
    # linear interpolation: coolantPressure goes 2.0 -> 5.0 over 3 evenly spaced ticks
    assert fills[0]["coolantPressure"] == 3.0
    assert fills[1]["coolantPressure"] == 4.0


def test_generate_fill_samples_gap_exceeding_max_ceiling_returns_empty():
    last = sample(0)
    new = sample(1000)  # exceeds MAX_FILLABLE_GAP_SECONDS for every metric
    assert generate_fill_samples(last, new, METRICS) == []


def test_generate_fill_samples_per_metric_ceiling_leaves_that_metric_unfilled():
    # coolantPressure's ceiling is 6s; coolantTemperature's is 20s — a 7s
    # gap fills coolantTemperature but not coolantPressure.
    last = sample(0, coolantPressure=2.0, coolantTemperature=60.0)
    new = sample(7, coolantPressure=10.0, coolantTemperature=65.0)
    fills = generate_fill_samples(last, new, METRICS)
    assert len(fills) == 6
    for fill in fills:
        assert fill["coolantPressure"] is None
        assert "coolantPressure" in fill["unfilledMetrics"]
        assert fill["coolantTemperature"] is not None


def test_generate_fill_samples_blocked_by_status_change():
    last = sample(0, status="RUNNING")
    new = sample(3, status="STOPPED")
    assert generate_fill_samples(last, new, METRICS) == []


def test_generate_fill_samples_blocked_by_either_invalid():
    last = sample(0, physicsValid=False)
    new = sample(3)
    assert generate_fill_samples(last, new, METRICS) == []


# ── impute_invalid_runs ─────────────────────────────────────────────────


def test_impute_invalid_runs_sensor_fault_flatlined_gets_interpolated():
    window = [
        sample(0, coolantPressure=2.0, physicsValid=True),
        sample(1, coolantPressure=-5.0, physicsValid=False, physicsViolations=["coolantPressure out of range"]),
        sample(2, coolantPressure=-5.0, physicsValid=False, physicsViolations=["coolantPressure out of range"]),
        sample(3, coolantPressure=2.4, physicsValid=True),
    ]
    result = impute_invalid_runs(window, METRICS, RANGES)
    assert result[1]["imputedForPhysics"] is True
    assert result[2]["imputedForPhysics"] is True
    # interpolated, not left at the flatlined -5.0 reading
    assert result[1]["coolantPressure"] != -5.0
    assert result[2]["coolantPressure"] != -5.0


def test_impute_invalid_runs_not_sensor_fault_preserved_as_abnormal():
    # Explicit FAULT status + faultType is the strongest NOT_SENSOR_FAULT
    # signal — must be preserved untouched, not repaired.
    window = [
        sample(0, physicsValid=True),
        sample(1, status="FAULT", faultType="COOLANT_LOSS", coolantPressure=30.0, physicsValid=False,
               physicsViolations=["coolantPressure out of range"]),
        sample(2, physicsValid=True),
    ]
    result = impute_invalid_runs(window, METRICS, RANGES)
    assert result[1]["abnormalOperation"] is True
    assert "imputedForPhysics" not in result[1]
    assert result[1]["coolantPressure"] == 30.0  # untouched


def test_impute_invalid_runs_run_touching_window_start_uses_before_context():
    window = [
        sample(0, coolantPressure=-5.0, physicsValid=False, physicsViolations=["coolantPressure out of range"]),
        sample(1, coolantPressure=2.5, physicsValid=True),
    ]
    before_context = sample(-1, coolantPressure=2.0, physicsValid=True)
    result = impute_invalid_runs(window, METRICS, RANGES, before_context=before_context)
    assert result[0]["imputedForPhysics"] is True
    assert result[0]["coolantPressure"] != -5.0


def test_impute_invalid_runs_run_touching_window_end_no_after_neighbor():
    window = [
        sample(0, coolantPressure=2.0, physicsValid=True),
        sample(1, coolantPressure=-5.0, physicsValid=False, physicsViolations=["coolantPressure out of range"]),
    ]
    result = impute_invalid_runs(window, METRICS, RANGES)
    # Flatlined-with-no-after-neighbor: still classified SENSOR_FAULT via
    # the flatline check (single value counts as flatlined only with >=2
    # points, so here it falls through to NOT_SENSOR_FAULT/no-repair path)
    # — assert it doesn't crash and preserves array length.
    assert len(result) == 2
