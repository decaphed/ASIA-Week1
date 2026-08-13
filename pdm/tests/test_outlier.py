"""Unit tests for pdm/app/preprocessing/outlier.py — Hampel-filter outlier
capping, with particular focus on the abnormal-operation exclude-mask
(§10.5's reminder: real fault signal must not be capped away)."""

from app.preprocessing._stats import js_median
from app.preprocessing.outlier import hampel_cap


def test_no_outliers_on_clean_series():
    values = [2.0, 2.05, 2.1, 2.0, 2.05, 2.1, 2.0]
    result = hampel_cap(values)
    assert result["outlierCount"] == 0
    assert result["capped"] == values


def test_single_spike_gets_capped_to_local_median():
    # varied baseline so MAD isn't degenerate-zero, spike clearly stands out
    values = [2.0, 2.05, 2.1, 20.0, 2.0, 2.05, 2.1]
    result = hampel_cap(values)
    assert result["outlierCount"] == 1
    assert result["capped"][3] != 20.0


def test_value_within_mad_threshold_untouched():
    values = [2.0, 2.05, 2.1, 2.15, 2.0, 2.05, 2.1]
    result = hampel_cap(values, k=3)
    assert result["outlierCount"] == 0
    assert result["capped"] == values


def test_excluded_index_never_capped_even_if_a_spike():
    values = [2.0, 2.05, 2.1, 20.0, 2.0, 2.05, 2.1]
    exclude_mask = [False, False, False, True, False, False, False]
    result = hampel_cap(values, exclude_mask=exclude_mask)
    assert result["capped"][3] == 20.0  # never capped
    assert result["outlierCount"] == 0


def test_excluded_neighbor_does_not_pollute_nearby_points_baseline():
    # A large excluded neighbor inflates the local MAD baseline for point 0
    # (widening its threshold), which without exclusion masks point 0's own
    # deviation entirely. Excluding the neighbor from the baseline restores
    # a tight-enough threshold to flag point 0 correctly.
    values = [3.38, 281.37, 2.3, 2.2, 0.71, 6.31, 2.29, 9.05, 8.6]
    exclude_mask = [False, True, False, False, False, False, False, False, False]

    with_exclusion = hampel_cap(values, exclude_mask=exclude_mask)
    without_exclusion = hampel_cap(values)

    assert with_exclusion["capped"][1] == 281.37  # excluded index never capped
    # Without the excluded neighbor's inflated baseline, point 0 is
    # correctly flagged; with it polluting the neighborhood, it is not.
    assert with_exclusion["capped"][0] != values[0]
    assert without_exclusion["capped"][0] == values[0]


def test_all_neighbors_excluded_falls_back_to_unfiltered_neighborhood():
    # A long abnormal-operation run consumes the whole local window for the
    # one non-excluded point at the edge — must not crash on an empty
    # filtered neighborhood.
    values = [2.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 2.0]
    exclude_mask = [False, True, True, True, True, True, True, False]
    result = hampel_cap(values, exclude_mask=exclude_mask)
    assert len(result["capped"]) == len(values)


def test_js_median_upper_middle_on_even_length_array():
    # JS medianOf() takes sorted[floor(n/2)] — the UPPER-middle element on
    # an even-length array, not the average of the two middle values.
    assert js_median([1.0, 2.0, 3.0, 4.0]) == 3.0
