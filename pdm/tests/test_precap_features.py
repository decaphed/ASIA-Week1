"""Unit tests for pdm/app/preprocessing/precap_features.py — pre-cap feature
capture (§11.6.2's last bullet)."""

from app.preprocessing.precap_features import compute_precap_features


def test_known_values_even_length_array():
    values = [1.0, 2.0, 3.0, 4.0]
    result = compute_precap_features(values)
    # mean=2.5, population variance=1.25, stdDev=sqrt(1.25)=1.118...
    assert result["rawStdDev"] == 1.12
    # abs diffs: |2-1|+|3-2|+|4-3| = 3, / (n-1)=3 -> 1.0
    assert result["rawRateOfChange"] == 1.0
    # median = upper-middle of sorted [1,2,3,4] = 3.0; max |v-3| = |1-3|=2.0
    assert result["rawMaxExcursion"] == 2.0


def test_single_element_array_no_division_by_zero():
    result = compute_precap_features([5.0])
    assert result["rawRateOfChange"] == 0
    assert result["rawStdDev"] == 0
    assert result["rawMaxExcursion"] == 0
