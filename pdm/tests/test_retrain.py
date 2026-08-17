"""Unit tests for pdm/app/retrain.py::run_retrain — the §10.5 orchestration
tying corpus.py/episodes.py/promotion.py together. Uses a fake psycopg-
shaped connection (no real Postgres needed) and a fixture predict_fn, per
this task's own scoping (model.py stays a stub).
"""

import pytest
from app.evaluation.episodes import MIN_ONSET_EPISODES
from app.promotion import ClassMetrics, EvalMetrics
from app.retrain import RetrainAbortedError, run_retrain

COLUMNS = [
    "id", "bufferId", "faultEventId", "windowEnd", "featureSnapshot",
    "featureCodeVersion", "label", "eventType", "sourceType", "thresholdsVersion",
    "corpusRowVersion",
]


class FakeCursor:
    def __init__(self, rows):
        self._rows = rows
        self.description = [(c,) for c in COLUMNS]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, *_args, **_kwargs):
        pass

    def fetchall(self):
        return self._rows


class FakeConn:
    def __init__(self, rows):
        self._rows = rows

    def cursor(self):
        return FakeCursor(self._rows)


def _row(i, buffer_id, window_end, label):
    return (i, buffer_id, i, window_end, {}, "v3-py", label, "FLAGGED" if label != "NORMAL" else "NEGATIVE_SAMPLE", "MANUAL_BUFFER", None, 1)


def test_run_retrain_aborts_when_evaluation_gate_not_cleared():
    rows = [_row(1, "fault_events:1", "2026-01-01T00:00:00Z", "BEARING")]
    conn = FakeConn(rows)
    with pytest.raises(RetrainAbortedError):
        run_retrain(conn, predict_fn=lambda rows_in: ["BEARING"] * len(rows_in))


def test_run_retrain_first_candidate_promotes_and_result_has_expected_shape():
    rows = []
    for i in range(MIN_ONSET_EPISODES):
        rows.append(_row(i, f"fault_events:{i}", f"2026-01-{(i % 28) + 1:02d}T00:00:00Z", "BEARING"))
    conn = FakeConn(rows)

    result = run_retrain(conn, predict_fn=lambda rows_in: ["BEARING"] * len(rows_in))

    assert result["promoted"] is True
    assert "first candidate" in result["promotionReason"]
    assert result["corpusRowCount"] == MIN_ONSET_EPISODES
    assert isinstance(result["corpusContentHash"], str) and len(result["corpusContentHash"]) == 64
    assert len(result["corpusRowManifest"]) == MIN_ONSET_EPISODES
    assert "BEARING" in result["metrics"]["perClass"]
    assert result["championRunIdAtEval"] is None


def test_run_retrain_with_a_champion_uses_the_real_promotion_gate():
    rows = []
    for i in range(MIN_ONSET_EPISODES):
        rows.append(_row(i, f"fault_events:{i}", f"2026-01-{(i % 28) + 1:02d}T00:00:00Z", "BEARING"))
    conn = FakeConn(rows)

    champion_metrics = EvalMetrics(per_class={"BEARING": ClassMetrics("BEARING", 1.0, 1.0, 100)})
    result = run_retrain(
        conn,
        predict_fn=lambda rows_in: ["BEARING"] * len(rows_in),  # perfect candidate
        champion_metrics=champion_metrics,
        champion_run_id=42,
    )

    assert result["promoted"] is True
    assert result["championRunIdAtEval"] == 42
