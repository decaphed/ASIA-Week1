"""Unit tests for pdm/app/preprocessing/validator.py — physics-informed
validation (§11.6.2's last bullet)."""

from app.preprocessing.validator import validate_physics


def sample(**overrides) -> dict:
    row = {
        "status": "RUNNING",
        "flowRate": 200.0,
        "rpm": 1500.0,
        "vibration": 2.0,
        "suctionPressure": 3.0,
        "dischargePressure": 8.0,
        "motorTemp": 60.0,
    }
    row.update(overrides)
    return row


def test_in_range_sample_is_valid():
    result = validate_physics(sample())
    assert result["physicsValid"] is True
    assert result["physicsViolations"] is None


def test_each_metric_individually_out_of_range():
    for metric, bad_value in [
        ("flowRate", 999),
        ("rpm", 9999),
        ("vibration", 999),
        ("suctionPressure", 999),
        ("dischargePressure", 999),
        ("motorTemp", 999),
    ]:
        result = validate_physics(sample(**{metric: bad_value}))
        assert result["physicsValid"] is False
        assert f"{metric} out of range" in result["physicsViolations"]


def test_discharge_below_suction_while_running_is_violation():
    result = validate_physics(sample(status="RUNNING", suctionPressure=5.0, dischargePressure=3.0))
    assert result["physicsValid"] is False
    assert "dischargePressure must exceed suctionPressure" in result["physicsViolations"]


def test_discharge_below_suction_while_stopped_is_tolerated():
    result = validate_physics(
        sample(status="STOPPED", suctionPressure=5.0, dischargePressure=4.5, flowRate=0.0, rpm=0.0)
    )
    assert result["physicsValid"] is True


def test_discharge_below_suction_within_transition_grace_window_tolerated():
    prev = sample(status="RUNNING")
    curr = sample(status="STOPPED", suctionPressure=5.0, dischargePressure=4.5)
    result = validate_physics(curr, prev_sample=prev, dt_sec=2)  # within 5s grace window
    assert result["physicsValid"] is True


def test_stopped_with_high_flow_is_violation():
    result = validate_physics(sample(status="STOPPED", flowRate=50.0, rpm=300.0))
    assert result["physicsValid"] is False
    assert "STOPPED status but flow/rpm indicate the pump is running" in result["physicsViolations"]


def test_stopped_with_high_flow_within_grace_window_tolerated():
    prev = sample(status="RUNNING", flowRate=200.0, rpm=1500.0)
    curr = sample(status="STOPPED", flowRate=50.0, rpm=300.0)
    result = validate_physics(curr, prev_sample=prev, dt_sec=1)
    assert result["physicsValid"] is True


def test_null_metric_excluded_from_validation():
    result = validate_physics(sample(vibration=None))
    assert result["physicsValid"] is True
