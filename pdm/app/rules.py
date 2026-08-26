"""Tier 1 rule engine — pure threshold-evaluation functions, kept
framework-free and directly unit-testable, mirroring the "pure functions,
no framework" pattern server/utils/validation.js already follows (§3.5).

evaluate() takes a processedRecord dict (already validated by schemas.py's
ProcessedRecordIn) plus the loaded thresholds config, and returns the
flag/confidence/triggeredRules shape from §3.2.
"""

from pathlib import Path
from typing import Any

import yaml

METRICS = ["engineRpm", "lubOilPressure", "fuelPressure", "coolantPressure", "lubOilTemperature", "coolantTemperature"]

THRESHOLDS_PATH = Path(__file__).parent / "thresholds.yaml"


def load_thresholds(path: Path = THRESHOLDS_PATH) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def compute_confidence(triggered_rules: list[str]) -> str:
    """Same reasoning server/preprocessing/faultClassifier.js already uses for
    its SENSOR_FAULT vs NOT_SENSOR_FAULT split: two or more metrics moving
    together is stronger signal than one metric alone (§3.2)."""
    triggered_metrics = {rule.split(".", 1)[0] for rule in triggered_rules}
    if len(triggered_metrics) >= 2:
        return "HIGH"
    if len(triggered_rules) >= 2:
        return "MEDIUM"
    return "LOW"


def evaluate(record: dict[str, Any], thresholds: dict[str, Any]) -> dict[str, Any]:
    """Evaluate every metric's min/max/stdDev/rateOfChange rules against one
    closed window. Pure function: no I/O, no global state."""
    triggered_rules: list[str] = []
    metric_thresholds = thresholds["metrics"]

    for metric in METRICS:
        cfg = metric_thresholds[metric]
        features = record.get("precapFeaturesByMetric", {}).get(metric)
        window_min = record.get(f"{metric}Min")
        window_max = record.get(f"{metric}Max")

        if features is not None:
            raw_std_dev = features.get("rawStdDev")
            raw_rate_of_change = features.get("rawRateOfChange")
            if raw_std_dev is not None and raw_std_dev > cfg["stdDevMax"]:
                triggered_rules.append(f"{metric}.stdDev")
            if raw_rate_of_change is not None and abs(raw_rate_of_change) > cfg["rateOfChangeMax"]:
                triggered_rules.append(f"{metric}.rateOfChange")

        if window_min is not None and window_min < cfg["min"]:
            triggered_rules.append(f"{metric}.min")
        if window_max is not None and window_max > cfg["max"]:
            triggered_rules.append(f"{metric}.max")

    flagged = len(triggered_rules) > 0

    return {
        "flagged": flagged,
        "confidence": compute_confidence(triggered_rules) if flagged else None,
        "triggeredRules": triggered_rules,
        "metric": triggered_rules[0].split(".", 1)[0] if triggered_rules else None,
        "windowEnd": record["windowEnd"],
        "thresholdsVersion": str(thresholds["version"]),
    }
