"""Unit tests for pdm/app/features.py (§15.1/D51) — to_vector() raises on a
missing/non-numeric key rather than zero-filling, and produces vectors in
FEATURE_ORDER's fixed order on the happy path.

Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
migration.md Phase 9.
"""

import pytest

from app.features import FEATURE_ORDER, to_vector

FULL_RECORD = {
    "engineRpm": 1500.0,
    "lubOilPressure": 4.5,
    "fuelPressure": 5.2,
    "coolantPressure": 3.6,
    "lubOilTemperature": 80.0,
    "coolantTemperature": 78.0,
}


def test_feature_order_matches_engine_metrics_exactly():
    """Locks FEATURE_ORDER's positional semantics (plan §7 Phase 2 step 2) --
    to_vector()'s vector index meaning is fixed at fit time; any later
    reordering silently invalidates every persisted model artifact."""
    assert FEATURE_ORDER == [
        "engineRpm",
        "lubOilPressure",
        "fuelPressure",
        "coolantPressure",
        "lubOilTemperature",
        "coolantTemperature",
    ]


def test_to_vector_happy_path_matches_feature_order():
    vector = to_vector(FULL_RECORD)
    assert vector == [FULL_RECORD[key] for key in FEATURE_ORDER]


def test_to_vector_raises_on_missing_key():
    record = dict(FULL_RECORD)
    del record["coolantTemperature"]
    with pytest.raises(KeyError):
        to_vector(record)


def test_to_vector_raises_on_none_value():
    record = dict(FULL_RECORD)
    record["coolantPressure"] = None
    with pytest.raises(ValueError):
        to_vector(record)


def test_to_vector_raises_on_non_numeric_value():
    record = dict(FULL_RECORD)
    record["engineRpm"] = "fast"
    with pytest.raises(ValueError):
        to_vector(record)


def test_to_vector_never_zero_fills():
    """A missing field must never silently become 0.0 — it must raise."""
    record = dict(FULL_RECORD)
    del record["fuelPressure"]
    with pytest.raises(KeyError):
        to_vector(record)
