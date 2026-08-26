"""Unit tests for pdm/app/preprocessing/aggregation.py — one-minute
aggregation (§11.6.2's last bullet).

Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
migration.md Phase 9. "vibration" (the pump metric these tests were built
around) is replaced with "coolantTemperature" as the metric under test —
arbitrary choice, any of the 6 engine metrics would exercise the same code
path identically.
"""

import pytest

from app.preprocessing.aggregation import aggregate_window
from app.preprocessing.config import METRICS


def make_uniform_sample(**overrides) -> dict:
    row = {
        "timestamp": "2026-01-01T00:00:00.000Z",
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


def test_mean_median_min_max_stddev_known_values():
    # Even-length series (4 samples) to also pin the upper-middle median.
    values = [1.0, 2.0, 3.0, 4.0]
    window = [make_uniform_sample(timestamp=f"2026-01-01T00:00:0{i}.000Z") for i in range(4)]
    stats_window = window
    capped_by_metric = {m: (values if m == "coolantTemperature" else [2.0] * 4) for m in METRICS}

    result = aggregate_window(window, stats_window, capped_by_metric)
    vib = result["stats"]["coolantTemperature"]

    assert vib["mean"] == 2.5
    assert vib["median"] == 3.0  # upper-middle, not (2+3)/2 = 2.5
    assert vib["min"] == 1.0
    assert vib["max"] == 4.0
    # population variance = mean((x - mean)^2) = 1.25, stdDev = sqrt(1.25)
    assert vib["stdDev"] == 1.12


def test_last_skips_trailing_null_metric_fill_row():
    window = [
        make_uniform_sample(timestamp="2026-01-01T00:00:00.000Z", coolantTemperature=2.0),
        make_uniform_sample(timestamp="2026-01-01T00:00:01.000Z", coolantTemperature=2.5),
        make_uniform_sample(timestamp="2026-01-01T00:00:02.000Z", coolantTemperature=None),  # trailing unfilled
    ]
    capped_by_metric = {m: [2.0, 2.5, 2.4] for m in METRICS}  # capped value for the last row still numeric
    result = aggregate_window(window, window, capped_by_metric)
    assert result["stats"]["coolantTemperature"]["last"] == 2.5  # skips the None raw value


def test_all_null_for_a_metric_raises():
    window = [make_uniform_sample(coolantTemperature=None)]
    capped_by_metric = {m: ([None] if m == "coolantTemperature" else [2.0]) for m in METRICS}
    with pytest.raises(ValueError):
        aggregate_window(window, window, capped_by_metric)


def test_dominant_status_tie_break_order():
    window = [
        make_uniform_sample(status="STOPPED"),
        make_uniform_sample(status="FAULT"),
        make_uniform_sample(status="RUNNING"),
    ]
    capped_by_metric = {m: [2.0, 2.0, 2.0] for m in METRICS}
    result = aggregate_window(window, window, capped_by_metric)
    # All tied at 1 each — RUNNING wins by insertion-order tie-break.
    assert result["dominantStatus"] == "RUNNING"


def test_population_variance_not_sample_variance():
    values = [10.0, 10.0, 10.0, 20.0]  # mean=12.5
    window = [make_uniform_sample() for _ in values]
    capped_by_metric = {m: (values if m == "coolantTemperature" else [2.0] * 4) for m in METRICS}
    result = aggregate_window(window, window, capped_by_metric)
    # population variance = ((-2.5)^2*3 + 7.5^2) / 4 = (18.75 + 56.25) / 4 = 18.75
    # stdDev = sqrt(18.75) ~= 4.33 (ddof=1 sample variance would give 25.0, stdDev ~5.0)
    assert result["stats"]["coolantTemperature"]["stdDev"] == 4.33
