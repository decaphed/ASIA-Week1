"""quality.py — data-quality assessment, ported unchanged (in formula) from
server/preprocessing/quality.js: a weighted quality score where missing data
hurts most (a gap can't be recovered), outliers are already contained by
capping (lower weight), and physics violations are advisory.
"""

from __future__ import annotations

from typing import Any

from .aggregation import round2
from .config import EXPECTED_SAMPLE_COUNT

# Maps each exact violation string produced by validator.py::validate_physics
# to a tally category. Hardcoded (not parsed/split) on purpose: if
# validator.py's wording ever changes, an unmatched string should fail
# loudly (see the "unmatched" bucket below) rather than silently
# miscounting.
VIOLATION_CATEGORY = {
    "engineRpm out of range": "engineRpm",
    "lubOilPressure out of range": "lubOilPressure",
    "fuelPressure out of range": "fuelPressure",
    "coolantPressure out of range": "coolantPressure",
    "lubOilTemperature out of range": "lubOilTemperature",
    "coolantTemperature out of range": "coolantTemperature",
    "STOPPED status but engineRpm indicates the engine is running": "statusMismatch",
}

VIOLATION_CATEGORIES = list(dict.fromkeys(VIOLATION_CATEGORY.values()))


def _tally_violations_by_metric(window: list[dict[str, Any]]) -> dict[str, int]:
    """Tally how many times each violation category occurred across a
    window. A single sample can contribute to more than one category, so
    these counts generally sum to MORE than physicsViolationCount, which
    counts samples, not violations — expected, not a bug.
    @returns one count per category (0 if never violated), plus an
        "unmatched" bucket for any violation string that doesn't match
        VIOLATION_CATEGORY.
    """
    tally = {category: 0 for category in VIOLATION_CATEGORIES}
    tally["unmatched"] = 0

    for sample in window:
        violations = sample.get("physicsViolations")
        if not violations:
            continue
        for violation in violations:
            category = VIOLATION_CATEGORY.get(violation, "unmatched")
            tally[category] += 1

    return tally


def compute_quality(
    window: list[dict[str, Any]],
    missing_count: int,
    outlier_count: int,
    metric_count: int,
    evaluated_sample_count: int,
    imputed_sample_count: int,
    physics_imputed_count: int = 0,
    late_sample_count: int = 0,
    merged_sample_count: int = 0,
    duplicate_sample_count: int = 0,
    partially_imputed_count: int = 0,
) -> dict[str, Any]:
    """@param window completed AUDIT window (all samples, MEASURED + IMPUTED).
    @param missing_count from missing.py::detect_missing — RESIDUAL gaps only.
    @param outlier_count total across all metrics, from outlier.py.
    @param evaluated_sample_count size of stats_window Hampel filtering ran
        over (outlierRate's denominator).
    @param imputed_sample_count count of provenance == 'IMPUTED' rows.
    """
    n = len(window)
    physics_violation_count = sum(1 for sample in window if sample.get("physicsValid") is False)
    abnormal_operation_sample_count = sum(1 for sample in window if sample.get("abnormalOperation") is True)
    violations_by_metric = _tally_violations_by_metric(window)

    # Denominator is the config-derived expected count, not n + missing_count
    # — n can be inflated by MERGED late/reordered arrivals.
    missing_rate = missing_count / EXPECTED_SAMPLE_COUNT
    outlier_rate = outlier_count / (evaluated_sample_count * metric_count)
    # Only SENSOR_FAULT-classified (physics_imputed_count) samples penalize
    # quality — a genuine abnormal-operation episode is not a data-quality
    # defect, it's exactly the signal PdM/fault-diagnosis needs preserved
    # (§10.5, fault_classifier.py).
    physics_pass_rate = 1 - physics_imputed_count / n
    imputation_rate = imputed_sample_count / n
    physics_imputation_rate = physics_imputed_count / n
    partially_imputed_rate = partially_imputed_count / n

    quality_score = round2(
        100
        * (
            0.4 * (1 - missing_rate)
            + 0.3 * (1 - outlier_rate)
            + 0.3 * physics_pass_rate
        )
    )
    quality_label = "GOOD" if quality_score >= 90 else "FAIR" if quality_score >= 70 else "POOR"

    return {
        "physicsViolationCount": physics_violation_count,
        "violationsByMetric": violations_by_metric,
        "missingRate": round2(missing_rate),
        "outlierRate": round2(outlier_rate),
        "physicsPassRate": round2(physics_pass_rate),
        "qualityScore": quality_score,
        "qualityLabel": quality_label,
        "imputedSampleCount": imputed_sample_count,
        "imputationRate": round2(imputation_rate),
        "physicsImputedCount": physics_imputed_count,
        "physicsImputationRate": round2(physics_imputation_rate),
        # Observational only — never fed into qualityScore.
        "abnormalOperationSampleCount": abnormal_operation_sample_count,
        "lateSampleCount": late_sample_count,
        "mergedSampleCount": merged_sample_count,
        "duplicateSampleCount": duplicate_sample_count,
        "partiallyImputedCount": partially_imputed_count,
        "partiallyImputedRate": round2(partially_imputed_rate),
        "isImputed": imputed_sample_count > 0,
    }
