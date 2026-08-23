"""Tests for pdm/app/training_quality.py's CSV quality gate — the
tabular-CSV counterpart to preprocessing/quality.py's per-window gate."""

import pandas as pd
import pytest

from app.training_quality import MIN_MINORITY_SHARE, MIN_ROWS, assess


def _good_df(n=300):
    # Alternating labels keeps the minority share well above MIN_MINORITY_SHARE
    # and every row inside pump-physics.yaml's normal ranges.
    return pd.DataFrame({
        "Engine_rpm": [1800.0] * n,
        "suctionPressure": [4.5] * n,
        "dischargePressure": [5.2] * n,
        "flowRate": [90.0] * n,
        "motorTemp": [70.0] * n,
        "vibration": [2.0] * n,
        "Engine_Condition": [0, 1] * (n // 2),
    })


def test_good_csv_passes():
    result = assess(_good_df())
    assert result["verdict"] == "PASS"
    assert result["qualityScore"] >= 70
    assert result["reasons"] == []


def test_missing_required_column_is_hard_rejected():
    df = _good_df().drop(columns=["vibration"])
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert any("vibration" in r for r in result["reasons"])


def test_too_few_rows_is_hard_rejected():
    df = _good_df(n=MIN_ROWS - 10)
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert any("row" in r.lower() for r in result["reasons"])


def test_high_missing_rate_drags_score_below_pass():
    df = _good_df(n=400)
    df.loc[: int(len(df) * 0.6), "vibration"] = None
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert result["missingRate"] > 0


def test_high_duplicate_rate_drags_score_below_pass():
    base = _good_df(n=50)
    df = pd.concat([base] * 8, ignore_index=True)  # 400 rows, almost all duplicates
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert result["duplicateRate"] > 0.5


def test_out_of_range_values_drag_score_below_pass():
    df = _good_df(n=300)
    df.loc[: int(len(df) * 0.5), "motorTemp"] = 9999.0  # far outside pump-physics.yaml's range
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert result["outOfRangeRate"] > 0


def test_imbalanced_labels_hard_rejected():
    n = 300
    df = _good_df(n=n)
    df["Engine_Condition"] = [0] * (n - 2) + [1, 1]  # minority share well under MIN_MINORITY_SHARE
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert result["minorityShare"] < MIN_MINORITY_SHARE
    assert any("minority" in r.lower() or "imbalance" in r.lower() or "class" in r.lower() for r in result["reasons"])
