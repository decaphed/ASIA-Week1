"""Unit tests for pdm/app/preprocessing/quality.py — data-quality assessment
(§11.6.2's last bullet)."""

from app.preprocessing.quality import compute_quality


def make_window(n=60, **overrides) -> list[dict]:
    row = {"status": "RUNNING", "physicsValid": True}
    row.update(overrides)
    return [dict(row) for _ in range(n)]


def test_quality_score_pinned_to_known_value():
    window = make_window(60)
    result = compute_quality(
        window=window,
        missing_count=0,
        outlier_count=0,
        metric_count=6,
        evaluated_sample_count=60,
        imputed_sample_count=0,
    )
    assert result["qualityScore"] == 100.0
    assert result["qualityLabel"] == "GOOD"


def test_quality_label_boundaries():
    window = make_window(100)

    good = compute_quality(
        window=window, missing_count=0, outlier_count=0, metric_count=6,
        evaluated_sample_count=100, imputed_sample_count=0, physics_imputed_count=0,
    )
    assert good["qualityLabel"] == "GOOD"

    poor = compute_quality(
        window=window, missing_count=100, outlier_count=0, metric_count=6,
        evaluated_sample_count=100, imputed_sample_count=0, physics_imputed_count=0,
    )
    assert poor["qualityLabel"] == "POOR"


def test_violations_by_metric_tallying_and_unmatched_bucket():
    window = make_window(3)
    window[0]["physicsViolations"] = ["vibration out of range"]
    window[1]["physicsViolations"] = ["dischargePressure must exceed suctionPressure"]
    window[2]["physicsViolations"] = ["some future violation string not in the map"]

    result = compute_quality(
        window=window, missing_count=0, outlier_count=0, metric_count=6,
        evaluated_sample_count=3, imputed_sample_count=0,
    )
    assert result["violationsByMetric"]["vibration"] == 1
    assert result["violationsByMetric"]["dischargePressureVsSuction"] == 1
    # An unrecognized violation string must NOT be silently dropped.
    assert result["violationsByMetric"]["unmatched"] == 1


def test_physics_pass_rate_only_penalized_by_sensor_fault_imputation():
    # §10.5: abnormalOperation (genuine fault, NOT_SENSOR_FAULT) must not
    # penalize physicsPassRate/qualityScore — only physics_imputed_count
    # (SENSOR_FAULT repairs) may.
    window = make_window(10)
    for s in window[:4]:
        s["abnormalOperation"] = True
        s["physicsValid"] = False

    result = compute_quality(
        window=window, missing_count=0, outlier_count=0, metric_count=6,
        evaluated_sample_count=10, imputed_sample_count=0,
        physics_imputed_count=0,  # none of the 4 abnormal samples were SENSOR_FAULT-repaired
    )
    assert result["physicsPassRate"] == 1.0
    assert result["abnormalOperationSampleCount"] == 4
    assert result["qualityScore"] == 100.0
