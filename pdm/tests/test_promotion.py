"""Unit tests for pdm/app/promotion.py — the champion/challenger promotion
gate (§10.5's design-review decision D8: per-class floor with a
support-scaled tolerance, replacing the original flat tolerance=0.0 that
ML-methodology review found would likely block promotion indefinitely at
thin real-world class support). Mirrors test_rules.py's plain-assert,
hand-built-fixture style — no real model needed, per this task's own
scoping (model.py stays a stub).
"""

from app.promotion import (
    ClassMetrics,
    EvalMetrics,
    decide_promotion,
    evaluate_candidate,
    support_scaled_tolerance,
)


def _cm(label, precision, recall, support):
    return ClassMetrics(label=label, precision=precision, recall=recall, support=support)


def test_first_ever_candidate_promotes_unconditionally_with_no_champion():
    candidate = EvalMetrics(per_class={"BEARING": _cm("BEARING", 0.5, 0.5, 3)})
    decision = decide_promotion(candidate, None)
    assert decision.promote is True
    assert "first candidate" in decision.reason


def test_a_single_flipped_example_at_low_support_does_not_block_promotion():
    # n=5 champion recall 4/5=0.8; candidate 3/5=0.6 (one fewer correct) —
    # this is exactly the "one flipped example" scenario the design review
    # flagged as noise, not a real regression, at this support level.
    champion = EvalMetrics(per_class={"BEARING": _cm("BEARING", 0.8, 0.8, 5)})
    candidate = EvalMetrics(per_class={"BEARING": _cm("BEARING", 0.8, 0.6, 5)})
    decision = decide_promotion(candidate, champion)
    assert decision.promote is True, decision.per_class_comparison
    assert decision.per_class_comparison["BEARING"]["pass"] is True


def test_a_real_well_supported_regression_still_blocks_promotion():
    # n=500, a 10-point recall drop is far outside support_scaled_tolerance
    # at that support level (~0.02) — a genuine regression must still block.
    champion = EvalMetrics(per_class={"BEARING": _cm("BEARING", 0.9, 0.9, 500)})
    candidate = EvalMetrics(per_class={"BEARING": _cm("BEARING", 0.9, 0.8, 500)})
    decision = decide_promotion(candidate, champion)
    assert decision.promote is False
    assert decision.per_class_comparison["BEARING"]["pass"] is False


def test_insufficient_support_class_is_excluded_from_the_decision_but_reported():
    champion = EvalMetrics(per_class={
        "BEARING": _cm("BEARING", 0.9, 0.9, 50),
        "SEAL_LEAK": _cm("SEAL_LEAK", 0.5, 0.5, 2),  # below default min_support_per_class=5
    })
    candidate = EvalMetrics(per_class={
        "BEARING": _cm("BEARING", 0.9, 0.9, 50),
        "SEAL_LEAK": _cm("SEAL_LEAK", 0.1, 0.1, 2),  # would look like a huge regression if counted
    })
    decision = decide_promotion(candidate, champion)
    assert decision.promote is True
    assert decision.per_class_comparison["SEAL_LEAK"]["included"] is False
    assert decision.per_class_comparison["SEAL_LEAK"]["reason"] == "insufficient support"


def test_other_is_always_excluded_from_the_gate_even_with_ample_support():
    champion = EvalMetrics(per_class={"OTHER": _cm("OTHER", 0.9, 0.9, 100)})
    candidate = EvalMetrics(per_class={"OTHER": _cm("OTHER", 0.1, 0.1, 100)})
    decision = decide_promotion(candidate, champion)
    assert decision.promote is True
    assert decision.per_class_comparison["OTHER"] == {"included": False, "reason": "excluded from gate (OTHER)"}


def test_candidate_with_zero_support_on_a_class_champion_covered_is_a_blocking_regression():
    champion = EvalMetrics(per_class={
        "BEARING": _cm("BEARING", 0.9, 0.9, 50),
        "DRY_RUN": _cm("DRY_RUN", 0.9, 0.9, 20),
    })
    # candidate has no entry for DRY_RUN at all — silently "forgot" a class.
    candidate = EvalMetrics(per_class={"BEARING": _cm("BEARING", 0.9, 0.9, 50)})
    decision = decide_promotion(candidate, champion)
    assert decision.promote is False
    assert decision.per_class_comparison["DRY_RUN"]["pass"] is False


def test_support_scaled_tolerance_shrinks_as_support_grows():
    tol_low = support_scaled_tolerance(5)
    tol_high = support_scaled_tolerance(500)
    assert tol_low > tol_high
    assert tol_high < 0.05
    assert support_scaled_tolerance(0) == 0.0


def test_evaluate_candidate_computes_per_class_precision_recall_support():
    rows = [
        {"label": "BEARING"}, {"label": "BEARING"}, {"label": "NORMAL"}, {"label": "NORMAL"},
    ]

    def predict_fn(rows_in):
        # perfect on BEARING, one false positive on NORMAL (predicts BEARING)
        return ["BEARING", "BEARING", "BEARING", "NORMAL"]

    metrics = evaluate_candidate(predict_fn, rows)
    bearing = metrics.per_class["BEARING"]
    normal = metrics.per_class["NORMAL"]
    assert bearing.support == 2
    assert bearing.recall == 1.0
    assert bearing.precision == 2 / 3  # 2 true positives, 1 false positive
    assert normal.support == 2
    assert normal.recall == 0.5
    assert normal.precision == 1.0


def test_evaluate_candidate_with_no_rows_returns_empty_metrics():
    metrics = evaluate_candidate(lambda rows: [], [])
    assert metrics.per_class == {}
