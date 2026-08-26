"""Tests for pdm/app/training_quality.py's CSV quality gate — the
tabular-CSV counterpart to preprocessing/quality.py's per-window gate.

Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
migration.md Phase 9. training_quality.py itself needed no code changes for
this migration (it derives REQUIRED_COLUMNS/feature_columns from
training.py's TRAIN_CSV_COLUMN_MAP and ranges from engine-physics.yaml via
load_ranges(), both already fixed in Phase 2/1) — only this fixture's column
names were pump-shaped.
"""

import pandas as pd
import pytest

from app.training_quality import MIN_MINORITY_SHARE, MIN_ROWS, assess


def _good_df(n=300):
    # Engine_RPM is strictly increasing across all n rows, which alone
    # guarantees every full row is unique (no accidental duplicates)
    # regardless of how the other, smaller-range columns happen to cycle —
    # a periodic column (e.g. `4.5 + (i % 10) * 0.01`) combined with the
    # other columns' periods can produce a combined row-uniqueness period
    # far shorter than n, silently reintroducing duplicate rows for larger
    # n (same bug class already fixed in test_training_endpoints.py's
    # _good_csv_bytes()). Values stay comfortably inside engine-physics.yaml's
    # ranges (engineRpm 0-2500, lubOilPressure 0-8.5, fuelPressure 0-23,
    # coolantPressure 0-9, lubOilTemperature 65-95, coolantTemperature 60-108).
    return pd.DataFrame({
        "Engine_RPM": [800.0 + i for i in range(n)],
        "Lub_Oil_Pressure": [4.0 + (i % 10) * 0.01 for i in range(n)],
        "Fuel_Pressure": [8.0 + (i % 10) * 0.01 for i in range(n)],
        "Coolant_Pressure": [3.0 + (i % 10) * 0.01 for i in range(n)],
        "Lub_Oil_Temperature": [78.0 + (i % 15) * 0.1 for i in range(n)],
        "Coolant_Temperature": [76.0 + (i % 15) * 0.1 for i in range(n)],
        "Engine_Condition": [0, 1] * (n // 2),
    })


def test_good_csv_passes():
    result = assess(_good_df())
    assert result["verdict"] == "PASS"
    assert result["qualityScore"] >= 70
    assert result["reasons"] == []


def test_missing_required_column_is_hard_rejected():
    df = _good_df().drop(columns=["Coolant_Temperature"])
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert any("Coolant_Temperature" in r for r in result["reasons"])


def test_too_few_rows_is_hard_rejected():
    df = _good_df(n=MIN_ROWS - 10)
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert any("row" in r.lower() for r in result["reasons"])


def test_high_missing_rate_drags_score_below_pass():
    df = _good_df(n=400)
    df.loc[: int(len(df) * 0.95), "Coolant_Temperature"] = None
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert result["missingRate"] > 0


def test_high_duplicate_rate_drags_score_below_pass():
    base = _good_df(n=2)  # exactly one row per label — the minimum for the minority-share check to pass
    df = pd.concat([base] * 500, ignore_index=True)  # 1000 rows, only 2 unique — duplicate rate ~0.998
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert result["duplicateRate"] > 0.9


def test_out_of_range_values_drag_score_below_pass():
    df = _good_df(n=300)
    df.loc[: int(len(df) * 0.95), "Coolant_Temperature"] = 9999.0  # far outside engine-physics.yaml's 60-108 range
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert result["outOfRangeRate"] > 0


def test_invalid_label_values_hard_rejected():
    # A plausible-but-wrong export format (e.g. "CLASS_0"/"CLASS_1" strings
    # instead of 0/1) must be caught here, at upload time — not left to
    # blow up training.fit_model()'s `int(v)` inside /fit after the CSV
    # already passed the quality gate.
    n = 300
    df = _good_df(n=n)
    labels = [0, 1] * (n // 2)
    labels[0] = "CLASS_0"
    labels[1] = "CLASS_1"
    df["Engine_Condition"] = labels
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert any("Engine_Condition" in r or "invalid" in r.lower() for r in result["reasons"])


def test_imbalanced_labels_hard_rejected():
    n = 300
    df = _good_df(n=n)
    df["Engine_Condition"] = [0] * (n - 2) + [1, 1]  # minority share well under MIN_MINORITY_SHARE
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert result["minorityShare"] < MIN_MINORITY_SHARE
    assert any("minority" in r.lower() or "imbalance" in r.lower() or "class" in r.lower() for r in result["reasons"])
