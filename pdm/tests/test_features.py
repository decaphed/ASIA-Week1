"""Unit tests for pdm/app/features.py (§15.1/D51) — to_vector() raises on a
missing/non-numeric key rather than zero-filling, and produces vectors in
FEATURE_ORDER's fixed order on the happy path.
"""

import pytest

from app.features import FEATURE_ORDER, to_vector

FULL_RECORD = {
    "rpm": 1500.0,
    "suctionPressure": 4.5,
    "dischargePressure": 5.2,
    "flowRate": 90.0,
    "motorTemp": 75.0,
    "vibration": 2.0,
}


def test_to_vector_happy_path_matches_feature_order():
    vector = to_vector(FULL_RECORD)
    assert vector == [FULL_RECORD[key] for key in FEATURE_ORDER]


def test_to_vector_raises_on_missing_key():
    record = dict(FULL_RECORD)
    del record["motorTemp"]
    with pytest.raises(KeyError):
        to_vector(record)


def test_to_vector_raises_on_none_value():
    record = dict(FULL_RECORD)
    record["vibration"] = None
    with pytest.raises(ValueError):
        to_vector(record)


def test_to_vector_raises_on_non_numeric_value():
    record = dict(FULL_RECORD)
    record["rpm"] = "fast"
    with pytest.raises(ValueError):
        to_vector(record)


def test_to_vector_never_zero_fills():
    """A missing field must never silently become 0.0 — it must raise."""
    record = dict(FULL_RECORD)
    del record["flowRate"]
    with pytest.raises(KeyError):
        to_vector(record)
