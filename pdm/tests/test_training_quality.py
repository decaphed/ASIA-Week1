"""Tests for pdm/app/training_quality.py's CSV quality gate — the
tabular-CSV counterpart to preprocessing/quality.py's per-window gate."""

import pandas as pd
import pytest

from app.training_quality import MIN_MINORITY_SHARE, MIN_ROWS, assess


def _good_df(n=300):
    # Per-row jitter keeps every row unique (no accidental duplicates) while
    # staying comfortably inside pump-physics.yaml's ranges (rpm 0-5000,
    # suctionPressure 0-10, dischargePressure 0-25, flowRate 0-500,
    # motorTemp 0-150, vibration 0-25).
    return pd.DataFrame({
        "Engine_rpm": [1800.0 + (i % 50) for i in range(n)],
        "suctionPressure": [4.5 + (i % 10) * 0.01 for i in range(n)],
        "dischargePressure": [5.2 + (i % 10) * 0.01 for i in range(n)],
        "flowRate": [90.0 + (i % 20) for i in range(n)],
        "motorTemp": [70.0 + (i % 15) for i in range(n)],
        "vibration": [2.0 + (i % 5) * 0.1 for i in range(n)],
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
    df.loc[: int(len(df) * 0.95), "vibration"] = None
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
    df.loc[: int(len(df) * 0.95), "motorTemp"] = 9999.0  # far outside pump-physics.yaml's 0-150 range
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
