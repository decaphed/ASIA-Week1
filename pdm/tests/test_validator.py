"""Unit tests for pdm/app/preprocessing/validator.py — physics-informed
validation (§11.6.2's last bullet).

Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
migration.md Phase 9. The old dischargePressure > suctionPressure test cases
are DELETED, not renamed -- that rule had no engine analogue and was removed
outright in Phase 2 (plan §4.1: no correlation evidence in
docs/analysis/2026-08-26-train-csv-characterization.md supports any of the
proposed cross-variable rules R2-R4). Only R1 (stopped-engine consistency)
remains.
"""

from app.preprocessing.validator import validate_physics


def sample(**overrides) -> dict:
    row = {
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


def test_in_range_sample_is_valid():
    result = validate_physics(sample())
    assert result["physicsValid"] is True
    assert result["physicsViolations"] is None


def test_each_metric_individually_out_of_range():
    for metric, bad_value in [
        ("engineRpm", 9999),
        ("lubOilPressure", 999),
        ("fuelPressure", 999),
        ("coolantPressure", 999),
        ("lubOilTemperature", 999),
        ("coolantTemperature", 999),
    ]:
        result = validate_physics(sample(**{metric: bad_value}))
        assert result["physicsValid"] is False
        assert f"{metric} out of range" in result["physicsViolations"]


def test_stopped_with_high_rpm_is_violation():
    result = validate_physics(sample(status="STOPPED", engineRpm=300.0))
    assert result["physicsValid"] is False
    assert "STOPPED status but engineRpm indicates the engine is running" in result["physicsViolations"]


def test_stopped_with_low_rpm_is_valid():
    result = validate_physics(sample(status="STOPPED", engineRpm=0.0))
    assert result["physicsValid"] is True


def test_stopped_with_high_rpm_within_grace_window_tolerated():
    prev = sample(status="RUNNING", engineRpm=800.0)
    curr = sample(status="STOPPED", engineRpm=300.0)
    result = validate_physics(curr, prev_sample=prev, dt_sec=1)
    assert result["physicsValid"] is True


def test_null_metric_excluded_from_validation():
    result = validate_physics(sample(coolantPressure=None))
    assert result["physicsValid"] is True
