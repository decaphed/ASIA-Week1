"""retrain.py — §10.5 orchestration: load corpus -> gate -> split -> train
(stub) -> evaluate -> promote-decide -> emit result as JSON.

Deliberately thin: the meaningful logic already lives in, and is already
tested in, evaluation/episodes.py and promotion.py — this module is glue.
model.py stays a stub (pdm/app/model.py) — actual Tier 2 training is
explicitly out of scope for this task (deliberately sequenced last, per
the project owner's own priority order). run_retrain() is nonetheless
fully exercisable today with a fixture predict_fn, per this task's own
scoping requirement ("everything up to and including the promotion
decision must be exercisable/testable without a real model").

Python never writes Postgres (§3.4's invariant, unchanged by §10.5): this
module's CLI entry point prints its result as JSON to stdout;
server/scripts/recordTrainingRun.js reads that and does the actual INSERT
into training_runs.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from .corpus import corpus_content_hash, load_corpus
from .evaluation.episodes import check_evaluation_gate, walk_forward_split
from .promotion import EvalMetrics, decide_promotion, evaluate_candidate


class RetrainAbortedError(Exception):
    """Raised when the evaluation gate isn't cleared — not enough
    fault-labeled buffers in the corpus to trust a held-out evaluation yet
    (§10.5, MIN_ONSET_EPISODES)."""


def run_retrain(
    conn,
    predict_fn: Callable[[list[dict[str, Any]]], list[str]],
    *,
    champion_metrics: Optional[EvalMetrics] = None,
    champion_run_id: Optional[int] = None,
    test_episode_fraction: float = 0.2,
) -> dict[str, Any]:
    """@param conn read-only Postgres connection (corpus.py's
        PDM_CORPUS_DB_URL role).
    @param predict_fn the candidate model's prediction function. Always a
        fixture today, since model.py has nothing trained yet — once it
        does, its predict method is passed here unchanged; this function's
        contract doesn't change.
    @param champion_metrics/champion_run_id: the CURRENT champion's
        held-out metrics and training_runs.id, if any. Looked up via
        trainingRunModel.getChampion() on the Node side and passed through
        by the caller — this function never queries training_runs itself,
        keeping the read-only Postgres role scoped to training_corpus only.
    @returns a RetrainResult dict, JSON-serializable, for
        server/scripts/recordTrainingRun.js to persist.
    @raises RetrainAbortedError if the evaluation gate isn't cleared.
    """
    corpus_rows = load_corpus(conn)
    gate = check_evaluation_gate(corpus_rows)
    if not gate["ready"]:
        raise RetrainAbortedError(
            f"evaluation gate not cleared: {gate['episodeCount']}/{gate['required']} fault-labeled buffers"
        )

    split = walk_forward_split(corpus_rows, test_episode_fraction=test_episode_fraction)
    content_hash, manifest = corpus_content_hash(corpus_rows)

    candidate_metrics = evaluate_candidate(predict_fn, split["testRows"])
    decision = decide_promotion(candidate_metrics, champion_metrics)

    return {
        "corpusContentHash": content_hash,
        "corpusRowManifest": manifest,
        "corpusRowCount": len(corpus_rows),
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "metrics": {
            "perClass": {
                label: {"precision": cm.precision, "recall": cm.recall, "support": cm.support}
                for label, cm in candidate_metrics.per_class.items()
            },
            "overallAccuracy": candidate_metrics.overall_accuracy,
        },
        "promoted": decision.promote,
        "promotionReason": decision.reason,
        "championRunIdAtEval": champion_run_id,
        "perClassComparison": decision.per_class_comparison,
    }


def _main() -> None:
    # CLI entry point placeholder. Wiring a real Postgres connection and a
    # real predict_fn both depend on model.py actually having something
    # trained (out of scope here), and on how the CLI obtains the current
    # champion (a narrow read exposed by Node, or its own read-only query
    # against training_runs — an open call for whoever builds model.py).
    # Deliberately not fleshed out further — this task's scope ends at
    # run_retrain() being correct and testable, not at a finished CLI.
    print(
        json.dumps({"error": "retrain.py's CLI entry point requires a trained model.py — not yet implemented"}),
        file=sys.stderr,
    )
    sys.exit(1)


if __name__ == "__main__":
    _main()
