"""Integration test for pdm/app/preprocessing/pipeline.py's Tier 2 wiring
(§15.1/D51, DoD: "/process-window actually calls model.score()"). Builds one
physically-steady 60-sample window and asserts:

  1. When model.score() returns None (no artifact loaded, today's default),
     process_window()'s tier1Verdict is unchanged from rules.evaluate()'s
     own output — byte-identical, guarding §11's parity work.
  2. When model.score() returns a Tier 2 verdict, process_window() merges it
     into tier1Verdict without disturbing the Tier 1 fields.
"""

from app import rules
from app.preprocessing import pipeline

THRESHOLDS = rules.load_thresholds()

# Steady-state values well inside every pump-physics.yaml range and every
# thresholds.yaml limit — a quiet window, Tier 1 silent either way.
STEADY_SAMPLE = {
    "status": "RUNNING",
    "faultType": None,
    "flowRate": 90.0,
    "rpm": 1500.0,
    "vibration": 2.0,
    "suctionPressure": 4.5,
    "dischargePressure": 5.2,
    "motorTemp": 75.0,
    "provenance": "MEASURED",
}


def _iso(ms):
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _make_window_samples(count=60, start_ms=1_700_000_000_000):
    samples = []
    for i in range(count):
        sample = dict(STEADY_SAMPLE)
        sample["timestamp"] = _iso(start_ms + i * 1000)
        samples.append(sample)
    return samples


def _run(window_samples):
    return pipeline.process_window(
        window_samples=window_samples,
        prev_sample=None,
        window_start=window_samples[0]["timestamp"],
        window_end=_iso(1_700_000_000_000 + len(window_samples) * 1000),
        thresholds=THRESHOLDS,
    )


def test_process_window_unaffected_when_no_model_loaded(monkeypatch):
    monkeypatch.setattr(pipeline.model, "score", lambda record: None)
    window_samples = _make_window_samples()

    result = _run(window_samples)

    processed_record = result["processedRecord"]
    expected_tier1_only = rules.evaluate(processed_record, THRESHOLDS)
    assert result["tier1Verdict"] == expected_tier1_only
    assert result["tier1Verdict"].get("tier2Label") is None


def test_process_window_merges_tier2_fields_when_model_loaded(monkeypatch):
    tier2_verdict = {
        "tier2Label": "FAULT",
        "tier2Probability": 0.87,
        "tier2ModelRunId": 1,
        "tier2ArtifactSha256": "deadbeef",
    }
    monkeypatch.setattr(pipeline.model, "score", lambda record: tier2_verdict)
    window_samples = _make_window_samples()

    result = _run(window_samples)

    verdict = result["tier1Verdict"]
    processed_record = result["processedRecord"]
    tier1_only = rules.evaluate(processed_record, THRESHOLDS)

    for key, value in tier1_only.items():
        assert verdict[key] == value
    for key, value in tier2_verdict.items():
        assert verdict[key] == value
