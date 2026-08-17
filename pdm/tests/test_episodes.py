"""Unit tests for pdm/app/evaluation/episodes.py — the bufferId-grouped
port of server/preprocessing/evaluation/episodes.js (§10.5's design-review
decision D7). Mirrors test_rules.py's plain-assert, hand-built-fixture
style. Focused especially on the two risks the ML-methodology review
flagged as real, not hypothetical:
  - D7a: buffer time ranges can overlap (unlike the JS original's
    guaranteed-non-overlapping detected runs) — a single row-level
    timestamp cutoff could silently split one buffer's rows across
    train/test if unhandled. This port assigns whole buffers, never rows.
  - D7b: NORMAL/NEGATIVE_SAMPLE rows must be split by the SAME
    chronological cutoff as fault episodes, not an independent/random
    split — otherwise the model could train on normal examples that are
    chronologically "in the future" relative to its test set.
"""

from app.evaluation.episodes import MIN_ONSET_EPISODES, check_evaluation_gate, identify_episodes, walk_forward_split


def _row(buffer_id, window_end, label):
    return {"bufferId": buffer_id, "windowEnd": window_end, "label": label}


def test_identify_episodes_groups_by_buffer_id_and_sorts_chronologically():
    rows = [
        _row("fault_events:2", "2026-01-01T02:01:00Z", "BEARING"),
        _row("fault_events:2", "2026-01-01T02:00:00Z", "BEARING"),
        _row("fault_events:1", "2026-01-01T01:00:00Z", "CAVITATION"),
    ]
    episodes = identify_episodes(rows)

    assert len(episodes) == 2
    assert episodes[0]["bufferId"] == "fault_events:1"
    assert episodes[0]["rowCount"] == 1
    assert episodes[1]["bufferId"] == "fault_events:2"
    assert episodes[1]["rowCount"] == 2
    # rows within an episode are sorted chronologically too
    assert episodes[1]["rows"][0]["windowEnd"] == "2026-01-01T02:00:00Z"
    assert episodes[1]["startTimestamp"] == "2026-01-01T02:00:00Z"
    assert episodes[1]["endTimestamp"] == "2026-01-01T02:01:00Z"


def test_check_evaluation_gate_counts_only_fault_labeled_buffers():
    rows = []
    for i in range(MIN_ONSET_EPISODES - 1):
        rows.append(_row(f"fault_events:{i}", f"2026-01-{i % 28 + 1:02d}T00:00:00Z", "BEARING"))
    rows.append(_row("fault_events:normal-1", "2026-01-01T00:00:00Z", "NORMAL"))

    gate = check_evaluation_gate(rows)
    assert gate["episodeCount"] == MIN_ONSET_EPISODES - 1
    assert gate["required"] == MIN_ONSET_EPISODES
    assert gate["ready"] is False

    rows.append(_row("fault_events:extra", "2026-01-01T00:00:00Z", "CAVITATION"))
    gate2 = check_evaluation_gate(rows)
    assert gate2["episodeCount"] == MIN_ONSET_EPISODES
    assert gate2["ready"] is True


def test_walk_forward_split_never_splits_a_single_buffer_across_train_and_test():
    # Two fault buffers, chronologically ordered, plus enough total episodes
    # to force a real split (test_episode_fraction default 0.2, 5 episodes
    # -> 1 held out).
    rows = []
    for i in range(4):
        rows.append(_row(f"fault_events:{i}", f"2026-01-0{i + 1}T00:00:00Z", "BEARING"))
    # The 5th (most recent) episode spans multiple windows — must stay whole.
    rows += [
        _row("fault_events:5", "2026-01-05T00:00:00Z", "CAVITATION"),
        _row("fault_events:5", "2026-01-05T00:01:00Z", "CAVITATION"),
        _row("fault_events:5", "2026-01-05T00:02:00Z", "CAVITATION"),
    ]

    result = walk_forward_split(rows, test_episode_fraction=0.2)

    train_buffer_ids = {r["bufferId"] for r in result["trainRows"]}
    test_buffer_ids = {r["bufferId"] for r in result["testRows"]}
    assert not (train_buffer_ids & test_buffer_ids), "no bufferId should appear on both sides"
    assert "fault_events:5" in test_buffer_ids
    # all 3 of buffer 5's rows landed on the same (test) side
    assert sum(1 for r in result["testRows"] if r["bufferId"] == "fault_events:5") == 3


def test_walk_forward_split_handles_overlapping_buffer_windows_without_splitting_either_one():
    # D7a's specific regression: two buffers whose TIME RANGES overlap.
    # Buffer A spans 00:00-00:10; buffer B (a different fault) spans
    # 00:03-00:05, fully inside A's span. Neither is allowed to be split
    # across train/test regardless of how their windows interleave in time.
    rows = [
        _row("fault_events:A", "2026-01-01T00:00:00Z", "BEARING"),
        _row("fault_events:A", "2026-01-01T00:05:00Z", "BEARING"),
        _row("fault_events:A", "2026-01-01T00:10:00Z", "BEARING"),
        _row("fault_events:B", "2026-01-01T00:03:00Z", "CAVITATION"),
        _row("fault_events:B", "2026-01-01T00:04:00Z", "CAVITATION"),
        # A few more buffers so a real split happens.
        _row("fault_events:C", "2026-01-02T00:00:00Z", "SEAL_LEAK"),
        _row("fault_events:D", "2026-01-03T00:00:00Z", "DRY_RUN"),
        _row("fault_events:E", "2026-01-04T00:00:00Z", "MISALIGNMENT"),
    ]

    # Must not raise (the function's own internal overlap-safety assertion
    # would fire on a real bug) and must keep each buffer whole.
    result = walk_forward_split(rows, test_episode_fraction=0.2)

    for buffer_id in ("fault_events:A", "fault_events:B", "fault_events:C", "fault_events:D", "fault_events:E"):
        in_train = any(r["bufferId"] == buffer_id for r in result["trainRows"])
        in_test = any(r["bufferId"] == buffer_id for r in result["testRows"])
        assert not (in_train and in_test), f"{buffer_id} was split across train and test"


def test_normal_rows_are_split_by_the_same_chronological_cutoff_as_fault_episodes():
    # D7b: NORMAL rows must not get an independent/random split. A NORMAL
    # buffer chronologically BEFORE the fault-episode split cutoff must
    # land in train; one AFTER must land in test — same rule as faults.
    rows = [
        _row("fault_events:f1", "2026-01-01T00:00:00Z", "BEARING"),
        _row("fault_events:f2", "2026-01-02T00:00:00Z", "BEARING"),
        _row("fault_events:f3", "2026-01-03T00:00:00Z", "BEARING"),
        _row("fault_events:f4", "2026-01-04T00:00:00Z", "BEARING"),
        _row("fault_events:f5", "2026-01-05T00:00:00Z", "BEARING"),  # last 20% -> held out
        _row("fault_events:n-early", "2026-01-01T12:00:00Z", "NORMAL"),  # before cutoff
        _row("fault_events:n-late", "2026-01-05T12:00:00Z", "NORMAL"),  # after cutoff
    ]

    result = walk_forward_split(rows, test_episode_fraction=0.2)

    train_buffer_ids = {r["bufferId"] for r in result["trainRows"]}
    test_buffer_ids = {r["bufferId"] for r in result["testRows"]}
    assert "fault_events:n-early" in train_buffer_ids
    assert "fault_events:n-late" in test_buffer_ids
    assert "fault_events:f5" in test_buffer_ids


def test_walk_forward_split_with_no_fault_episodes_puts_everything_in_train():
    rows = [_row("fault_events:n1", "2026-01-01T00:00:00Z", "NORMAL")]
    result = walk_forward_split(rows)
    assert len(result["trainRows"]) == 1
    assert result["testRows"] == []
