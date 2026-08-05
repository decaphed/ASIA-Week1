"""Unit tests for pdm/app/rules.py — threshold crossed/not crossed per rule
type, and single-metric vs multi-metric confidence escalation (§4.5).

Run with: pytest pdm/tests/test_rules.py  (from repo root, with pdm/ on
PYTHONPATH — see pdm/tests/conftest.py)
"""

import copy

from app import rules

THRESHOLDS = {
    "version": "test",
    "metrics": {
        "flowRate": {"min": 0, "max": 500, "stdDevMax": 10, "rateOfChangeMax": 5},
        "rpm": {"min": 0, "max": 5000, "stdDevMax": 100, "rateOfChangeMax": 50},
        "vibration": {"min": 0, "max": 25, "stdDevMax": 1, "rateOfChangeMax": 0.5},
        "suctionPressure": {"min": 0, "max": 10, "stdDevMax": 0.5, "rateOfChangeMax": 0.3},
        "dischargePressure": {"min": 0, "max": 25, "stdDevMax": 1, "rateOfChangeMax": 0.3},
        "motorTemp": {"min": 0, "max": 150, "stdDevMax": 5, "rateOfChangeMax": 0.15},
    },
}


def make_quiet_record(window_end="2026-08-05T10:00:00.000Z"):
    """A record with every metric well inside every threshold."""
    record = {"windowEnd": window_end}
    for metric, cfg in THRESHOLDS["metrics"].items():
        record[f"{metric}Min"] = cfg["min"] + 1
        record[f"{metric}Max"] = cfg["max"] - 1
    record["precapFeaturesByMetric"] = {
        metric: {"rawStdDev": 0.01, "rawRateOfChange": 0.001, "rawMaxExcursion": 0.01}
        for metric in THRESHOLDS["metrics"]
    }
    return record


def test_no_rules_triggered_on_quiet_window():
    record = make_quiet_record()
    verdict = rules.evaluate(record, THRESHOLDS)
    assert verdict["flagged"] is False
    assert verdict["triggeredRules"] == []
    assert verdict["confidence"] is None
    assert verdict["thresholdsVersion"] == "test"
    assert verdict["windowEnd"] == record["windowEnd"]


def test_std_dev_rule_fires_when_crossed():
    record = make_quiet_record()
    record["precapFeaturesByMetric"]["vibration"]["rawStdDev"] = 999
    verdict = rules.evaluate(record, THRESHOLDS)
    assert verdict["flagged"] is True
    assert "vibration.stdDev" in verdict["triggeredRules"]


def test_rate_of_change_rule_fires_when_crossed():
    record = make_quiet_record()
    record["precapFeaturesByMetric"]["motorTemp"]["rawRateOfChange"] = 999
    verdict = rules.evaluate(record, THRESHOLDS)
    assert verdict["flagged"] is True
    assert "motorTemp.rateOfChange" in verdict["triggeredRules"]


def test_rate_of_change_rule_uses_absolute_value():
    record = make_quiet_record()
    record["precapFeaturesByMetric"]["motorTemp"]["rawRateOfChange"] = -999
    verdict = rules.evaluate(record, THRESHOLDS)
    assert "motorTemp.rateOfChange" in verdict["triggeredRules"]


def test_min_rule_fires_when_window_dips_below_floor():
    record = make_quiet_record()
    record["suctionPressureMin"] = -5
    verdict = rules.evaluate(record, THRESHOLDS)
    assert "suctionPressure.min" in verdict["triggeredRules"]


def test_max_rule_fires_when_window_exceeds_ceiling():
    record = make_quiet_record()
    record["dischargePressureMax"] = 999
    verdict = rules.evaluate(record, THRESHOLDS)
    assert "dischargePressure.max" in verdict["triggeredRules"]


def test_confidence_low_for_single_rule_single_metric():
    assert rules.compute_confidence(["vibration.stdDev"]) == "LOW"


def test_confidence_medium_for_multiple_rules_same_metric():
    assert rules.compute_confidence(["vibration.stdDev", "vibration.rateOfChange"]) == "MEDIUM"


def test_confidence_high_for_rules_across_multiple_metrics():
    assert rules.compute_confidence(["vibration.stdDev", "motorTemp.stdDev"]) == "HIGH"


def test_multi_metric_violation_escalates_confidence_via_evaluate():
    record = make_quiet_record()
    record["precapFeaturesByMetric"]["vibration"]["rawStdDev"] = 999
    record["precapFeaturesByMetric"]["motorTemp"]["rawStdDev"] = 999
    verdict = rules.evaluate(record, THRESHOLDS)
    assert verdict["confidence"] == "HIGH"


def test_evaluate_does_not_mutate_thresholds():
    thresholds_copy = copy.deepcopy(THRESHOLDS)
    record = make_quiet_record()
    record["precapFeaturesByMetric"]["vibration"]["rawStdDev"] = 999
    rules.evaluate(record, THRESHOLDS)
    assert THRESHOLDS == thresholds_copy
