"""training_quality.py — quality gate for an uploaded training CSV
(§15.7's start-over/upload flow), mirroring preprocessing/quality.py's
"weighted score, hardcoded reasons" shape but for a tabular training CSV
rather than a sensor window.

Two kinds of check:
  - structural (hard fail, no score computed): missing required columns,
    too few rows, or too few minority-class rows to stratify meaningfully.
  - scored (weighted into a 0-100 composite, PASS at >= PASS_THRESHOLD):
    missing-value rate, duplicate-row rate, out-of-range rate.

Deliberately independent of preprocessing/quality.py: that module scores a
completed AUDIT window of live sensor samples (imputation/physics-violation
provenance per sample); this module scores a flat, unprocessed training CSV
with none of that structure. Sharing the RANGES source (physics.py) is
sufficient reuse without forcing a shape neither one actually has.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from .physics import load_ranges
from .training import TRAIN_CSV_COLUMN_MAP, TRAIN_CSV_LABEL_COLUMN

MIN_ROWS = 200
MIN_MINORITY_SHARE = 0.05
PASS_THRESHOLD = 70

REQUIRED_COLUMNS = list(TRAIN_CSV_COLUMN_MAP) + [TRAIN_CSV_LABEL_COLUMN]


def _round2(value: float) -> float:
    return round(value, 2)


def assess(df: pd.DataFrame) -> dict[str, Any]:
    """@param df the raw uploaded CSV, parsed but not yet preprocessed —
    train.csv's own column names (Engine_rpm, Engine_Condition, ...), same
    as training.fit_model's input.
    @returns a report dict; see this module's docstring for the two-tier
    structural/scored check split. verdict is REJECTED if EITHER any
    structural check fails OR the composite qualityScore < PASS_THRESHOLD.
    """
    reasons: list[str] = []

    missing_columns = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing_columns:
        reasons.append(f"missing required column(s): {', '.join(missing_columns)}")
        return {
            "verdict": "REJECTED", "qualityScore": 0.0, "rowCount": len(df), "reasons": reasons,
            "missingRate": None, "duplicateRate": None, "outOfRangeRate": None, "minorityShare": None,
        }

    row_count = len(df)
    structural_reasons: list[str] = []
    if row_count < MIN_ROWS:
        structural_reasons.append(f"only {row_count} row(s) — at least {MIN_ROWS} are required for a meaningful stratified split")

    label_counts = df[TRAIN_CSV_LABEL_COLUMN].value_counts(dropna=True)
    minority_share = float(label_counts.min() / label_counts.sum()) if len(label_counts) >= 1 and label_counts.sum() > 0 else 0.0
    if len(label_counts) < 2 or minority_share < MIN_MINORITY_SHARE:
        structural_reasons.append(
            f"label class imbalance: minority class share {_round2(minority_share)} is below the "
            f"{MIN_MINORITY_SHARE} minimum needed for a stratified split"
        )

    # training.fit_model() does `"FAULT" if int(v) == 1 else "NORMAL"` on
    # every present label value — a plausible-but-wrong export (e.g. the
    # strings "NORMAL"/"FAULT", or any non-0/1 value) would sail through
    # this quality gate and then raise ValueError inside /fit, after the
    # CSV was already accepted. Catch it here instead: every non-null label
    # value must be numeric AND exactly 0 or 1 (values like 0.0 or "0" are
    # fine post-coercion; anything that fails to coerce, or coerces to
    # something other than 0/1, is invalid).
    present_labels = df[TRAIN_CSV_LABEL_COLUMN].dropna()
    numeric_labels = pd.to_numeric(present_labels, errors="coerce")
    invalid_label_mask = numeric_labels.isna() | ~numeric_labels.isin([0, 1])
    if invalid_label_mask.any():
        bad_values = present_labels[invalid_label_mask].unique().tolist()
        if len(bad_values) <= 5:
            bad_values_desc = ", ".join(repr(v) for v in bad_values)
            structural_reasons.append(
                f"label column '{TRAIN_CSV_LABEL_COLUMN}' has invalid value(s) (must be 0 or 1): {bad_values_desc}"
            )
        else:
            structural_reasons.append(
                f"label column '{TRAIN_CSV_LABEL_COLUMN}' has {int(invalid_label_mask.sum())} invalid value(s) (must be 0 or 1)"
            )

    if structural_reasons:
        # Too few rows, or too imbalanced to stratify — no meaningful score
        # to compute, reject outright.
        return {
            "verdict": "REJECTED", "qualityScore": 0.0, "rowCount": row_count, "reasons": structural_reasons,
            "missingRate": None, "duplicateRate": None, "outOfRangeRate": None, "minorityShare": _round2(minority_share),
        }

    feature_columns = list(TRAIN_CSV_COLUMN_MAP)

    # A numeric feature column containing any non-numeric token (e.g.
    # "N/A") comes through as object dtype, and comparing that against a
    # numeric bound below raises TypeError. Coerce a working copy of just
    # the feature columns to numeric first — unparseable values become
    # NaN, which correctly counts as "missing" (see missing_count below)
    # rather than crashing the range comparison. The caller's df is left
    # untouched.
    numeric_features = df[feature_columns].apply(pd.to_numeric, errors="coerce")

    missing_count = int((numeric_features.isna().any(axis=1) | df[TRAIN_CSV_LABEL_COLUMN].isna()).sum())
    missing_rate = missing_count / row_count if row_count else 0.0

    duplicate_count = int(df.duplicated().sum())
    duplicate_rate = duplicate_count / row_count if row_count else 0.0

    ranges = load_ranges()
    out_of_range_row_mask = pd.Series(False, index=df.index)
    for csv_column, metric_name in TRAIN_CSV_COLUMN_MAP.items():
        bounds = ranges.get(metric_name)
        if bounds is None or csv_column not in numeric_features.columns:
            continue
        column_out_of_range = (numeric_features[csv_column] < bounds["min"]) | (numeric_features[csv_column] > bounds["max"])
        out_of_range_row_mask = out_of_range_row_mask | column_out_of_range.fillna(False)
    out_of_range_rate = float(out_of_range_row_mask.sum()) / row_count if row_count else 0.0

    # Weights are 0.34/0.33/0.33 (not an even 1/3 split): a 0.3-weighted
    # dimension can only ever cost 30 points, landing a fully-bad dimension
    # AT exactly PASS_THRESHOLD (70) — still a PASS. Each dimension here can
    # cost slightly more than 30 points, so a fully-bad dimension alone is
    # enough to cross below PASS_THRESHOLD on its own.
    quality_score = _round2(
        100
        * (
            0.34 * (1 - missing_rate)
            + 0.33 * (1 - duplicate_rate)
            + 0.33 * (1 - out_of_range_rate)
        )
    )

    reasons = []
    if missing_rate > 0:
        reasons.append(f"missing-value rate {_round2(missing_rate)} across required columns")
    if duplicate_rate > 0:
        reasons.append(f"duplicate-row rate {_round2(duplicate_rate)}")
    if out_of_range_rate > 0:
        reasons.append(f"out-of-range value rate {_round2(out_of_range_rate)} against pump-physics.yaml bounds")

    verdict = "PASS" if quality_score >= PASS_THRESHOLD else "REJECTED"
    if verdict == "REJECTED" and not reasons:
        reasons.append(f"composite quality score {quality_score} is below the {PASS_THRESHOLD} threshold")

    return {
        "verdict": verdict,
        "qualityScore": quality_score,
        "rowCount": row_count,
        "reasons": reasons if verdict == "REJECTED" else [],
        "missingRate": _round2(missing_rate),
        "duplicateRate": _round2(duplicate_rate),
        "outOfRangeRate": _round2(out_of_range_rate),
        "minorityShare": _round2(minority_share),
    }


def clean(df: pd.DataFrame) -> pd.DataFrame:
    """Preprocessing applied to a CSV that already PASSED assess(): drops
    the same rows the quality report already counted against it — rows
    missing a required value, and exact duplicate rows — so the cleaned
    CSV training.fit_model reads next reflects exactly what was scored."""
    feature_columns = list(TRAIN_CSV_COLUMN_MAP)
    cleaned = df.dropna(subset=feature_columns + [TRAIN_CSV_LABEL_COLUMN])
    cleaned = cleaned.drop_duplicates()
    return cleaned.reset_index(drop=True)
