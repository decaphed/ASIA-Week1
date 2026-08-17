"""Tier 2 extension point (§1, §3.5) — NOT in scope for this plan. No model
is trained or loaded yet; there isn't enough labeled fault data (that's the
entire reason Tier 1 + HITL review exists first).

Once a Random Forest / XGBoost model is trained on HITL-confirmed
fault_events, load it at module import time (mirroring how thresholds.yaml
is loaded once at startup, not per-request) and have score() return its
verdict. main.py's /score handler already calls rules.evaluate() first; a
non-None result from score() should AUGMENT the rule verdict, not replace
it, per the tiered design (§3.5).

§10.5's corpus/evaluation/promotion infrastructure is now built and ready
for this module: corpus.py loads the training corpus, evaluation/episodes.py
provides the held-out-by-buffer split, promotion.py's evaluate_candidate()
takes any predict_fn (this module's eventual predict method fits that
contract unchanged) and decide_promotion() runs the champion/challenger
gate. retrain.py's run_retrain() is the orchestration entry point that will
call whatever training function this module eventually adds — none of that
had a model to call it with until now.
"""

from typing import Any, Optional


def score(record: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Tier 2 entry point. Returns None until a model is trained and loaded."""
    return None
