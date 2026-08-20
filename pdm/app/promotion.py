"""promotion.py — §10.5's champion/challenger promotion gate.

Design-review history (docs/plan/2026-08-05-pdm-implementation.md §10.5's
addendum, decision D8): the original sketch was a strict per-class floor
with tolerance=0.0 — candidate must beat champion on EVERY fault label with
sufficient held-out support, no slack. ML-methodology review found this
would likely block promotion indefinitely: at min_support_per_class=5,
recall can only take values like 0/5..5/5, so a single flipped held-out
example swings a class's recall by 20 points — a zero-tolerance floor
treats that sampling noise as a real regression, forever, as long as real
per-class support stays thin (which it will, for a long time, since real
confirmed faults arrive far slower than the synthetic corpus's).

Fix (project owner's choice among the reviewed options): a SUPPORT-SCALED
tolerance — wide at low support, tightening toward 0 as more held-out
examples accumulate — replacing the flat constant. The per-class floor
itself (no averaging across classes) is KEPT: that's what stops an
aggregate metric from hiding a minority-class regression, and nothing in
this fix weakens it.

'OTHER' is structurally excluded from the gate (not just optionally
flaggable) per the same review's independent D1 assessment: it's a
catch-all, by-definition-heterogeneous bucket, likely to be both the
lowest-support and least internally-coherent class — the worst possible
combination to gate promotion on, even with tolerance. It's still trained
on and still reported, just never blocks a promotion decision.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

DEFAULT_MIN_SUPPORT_PER_CLASS = 5
DEFAULT_MARGIN_FACTOR = 0.5

# See module docstring — a catch-all bucket, excluded from the pass/fail
# decision on principle, not because of thin data alone.
EXCLUDED_FROM_GATE = {"OTHER"}


@dataclass
class ClassMetrics:
    label: str
    precision: float
    recall: float
    support: int  # held-out example count for this label


@dataclass
class EvalMetrics:
    per_class: dict[str, ClassMetrics] = field(default_factory=dict)
    # Informational only — NEVER used by decide_promotion (that's the whole
    # point of the per-class floor: an aggregate can't hide a regression).
    overall_accuracy: Optional[float] = None


@dataclass
class PromotionDecision:
    promote: bool
    reason: str
    per_class_comparison: dict[str, dict[str, Any]]


def support_scaled_tolerance(support: int, margin_factor: float = DEFAULT_MARGIN_FACTOR) -> float:
    """A support-aware tolerance band for a per-class precision/recall
    comparison. Approximates one standard error of a proportion estimate
    (SE <= 0.5/sqrt(n) at the worst case p=0.5), scaled down by
    margin_factor so it's generous but not maximally so. Wide at low
    support (n=5, margin_factor=0.5 -> ~0.22), tight at high support
    (n=500 -> ~0.02) — deliberately shaped so a single flipped example at
    thin support isn't treated as a real regression, while a genuine,
    well-supported regression still blocks promotion.
    """
    if support <= 0:
        return 0.0
    return margin_factor / math.sqrt(support)


def evaluate_candidate(
    predict_fn: Callable[[list[dict[str, Any]]], list[str]],
    test_rows: list[dict[str, Any]],
) -> EvalMetrics:
    """Compute per-class precision/recall/support from a model's
    predictions against held-out corpus rows (each row must carry 'label').

    predict_fn is a plain callable, not a model.py-shaped object — model.py
    stays a stub (Tier 2 training itself is out of scope for this task), so
    this function must be exercisable with a fixture predict_fn in tests,
    per this task's own scoping (§10.5's addendum: "everything up to and
    including the promotion decision must be exercisable/testable without
    a real model"). Once model.py trains something real, its prediction
    method is passed here unchanged.
    """
    if not test_rows:
        return EvalMetrics(per_class={})

    y_true = [row["label"] for row in test_rows]
    y_pred = predict_fn(test_rows)
    if len(y_pred) != len(y_true):
        raise ValueError("evaluate_candidate: predict_fn must return exactly one prediction per row")

    labels = sorted(set(y_true) | set(y_pred))
    per_class: dict[str, ClassMetrics] = {}
    for label in labels:
        tp = sum(1 for t, p in zip(y_true, y_pred) if t == label and p == label)
        fp = sum(1 for t, p in zip(y_true, y_pred) if t != label and p == label)
        fn = sum(1 for t, p in zip(y_true, y_pred) if t == label and p != label)
        support = sum(1 for t in y_true if t == label)
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        per_class[label] = ClassMetrics(label=label, precision=precision, recall=recall, support=support)

    overall_accuracy = sum(1 for t, p in zip(y_true, y_pred) if t == p) / len(y_true)
    return EvalMetrics(per_class=per_class, overall_accuracy=overall_accuracy)


def decide_promotion(
    candidate: EvalMetrics,
    champion: Optional[EvalMetrics],
    *,
    min_support_per_class: int = DEFAULT_MIN_SUPPORT_PER_CLASS,
    margin_factor: float = DEFAULT_MARGIN_FACTOR,
) -> PromotionDecision:
    # TODO(§15.5/D55): once the first training_corpus-trained (multi-class)
    # candidate is fit via the admin upload path, this function needs a new
    # branch, inserted right after the `champion is None` check below:
    # compare set(champion.per_class) - EXCLUDED_FROM_GATE against
    # set(candidate.per_class) - EXCLUDED_FROM_GATE; on any difference,
    # return PromotionDecision(promote=True, reason=<taxonomy-mismatch
    # string>, per_class_comparison={}) — bypassing the per-class floor with
    # its own honest reason string, not silently reusing "no champion yet".
    # Not implemented yet: the bootstrap model (§15.1) is binary-only, so
    # this branch can't fire until an actual taxonomy change is fit. See
    # §15.5's full mechanics/reasoning before implementing.
    """Per-class-floor promotion decision with support-scaled tolerance
    (see module docstring). First-ever candidate (no champion) promotes
    unconditionally. A class is only INCLUDED in the pass/fail decision
    when it's outside EXCLUDED_FROM_GATE and both sides have
    >= min_support_per_class held-out examples — insufficient-support
    classes are reported (never silently dropped), just not decisive.
    A champion class the candidate has zero support/predictions for is
    always a blocking regression, regardless of tolerance — a candidate
    that silently forgot a whole class the champion could detect must not
    promote.
    """
    if champion is None:
        return PromotionDecision(
            promote=True,
            reason="no champion yet — first candidate promotes unconditionally",
            per_class_comparison={},
        )

    comparison: dict[str, dict[str, Any]] = {}
    any_blocking_regression = False

    for label, cand_cm in candidate.per_class.items():
        if label in EXCLUDED_FROM_GATE:
            comparison[label] = {"included": False, "reason": "excluded from gate (OTHER)"}
            continue

        champ_cm = champion.per_class.get(label)
        if champ_cm is None or cand_cm.support < min_support_per_class or champ_cm.support < min_support_per_class:
            comparison[label] = {
                "included": False,
                "reason": "insufficient support",
                "candidateSupport": cand_cm.support,
                "championSupport": champ_cm.support if champ_cm else 0,
            }
            continue

        tolerance = support_scaled_tolerance(min(cand_cm.support, champ_cm.support), margin_factor)
        recall_ok = cand_cm.recall >= champ_cm.recall - tolerance
        precision_ok = cand_cm.precision >= champ_cm.precision - tolerance
        verdict_ok = recall_ok and precision_ok
        comparison[label] = {
            "included": True,
            "candidateRecall": cand_cm.recall,
            "championRecall": champ_cm.recall,
            "candidatePrecision": cand_cm.precision,
            "championPrecision": champ_cm.precision,
            "tolerance": tolerance,
            "pass": verdict_ok,
        }
        if not verdict_ok:
            any_blocking_regression = True

    # A champion class with sufficient support that the candidate has NO
    # support/predictions for at all is a blocking regression even though
    # the loop above only iterates candidate.per_class.
    for label, champ_cm in champion.per_class.items():
        if label in EXCLUDED_FROM_GATE or label in comparison:
            continue
        if champ_cm.support >= min_support_per_class:
            cand_cm = candidate.per_class.get(label)
            if cand_cm is None or cand_cm.support == 0:
                comparison[label] = {
                    "included": True,
                    "pass": False,
                    "reason": "candidate has zero support/predictions for a class the champion was evaluated on",
                }
                any_blocking_regression = True

    promote = not any_blocking_regression
    reason = (
        "candidate at least matches champion (within support-scaled tolerance) on every eligible class"
        if promote
        else "candidate regresses on at least one eligible class beyond its support-scaled tolerance"
    )
    return PromotionDecision(promote=promote, reason=reason, per_class_comparison=comparison)
