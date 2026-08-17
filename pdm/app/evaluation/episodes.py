"""episodes.py — Python port of server/preprocessing/evaluation/episodes.js,
re-targeted at §10.5's training_corpus rows instead of processed_telemetry
rows (docs/plan/2026-08-05-pdm-implementation.md §10.5's design-review
addendum, decision D7).

WHY THIS ISN'T A LITERAL TRANSLITERATION (read before touching this file):

The JS original groups processed_telemetry rows into "episodes" by
detecting contiguous runs of dominantStatus == 'FAULT' — a property that
guarantees episodes are non-overlapping in chronological row order, which
is exactly why its walk-forward split can safely bucket each ROW by a
single global timestamp cutoff (see that file's own docstring: "this
timestamp cut can never fall inside a FAULT episode").

training_corpus rows carry no dominantStatus at all — they're already
pre-labeled fault/NORMAL rows sourced from fault_events, grouped by
bufferId instead. Critically, buffer time RANGES are NOT guaranteed
non-overlapping the way detected runs were (two different fault_events
rows — e.g. two different fault types close in time, or a MANUAL_BUFFER
overlapping an auto-flagged one — can have overlapping [faultStart,
faultEnd] windows). Bucketing individual ROWS by a single timestamp cutoff
would risk silently splitting one buffer's rows across train and test if
its window range straddles the cutoff — the exact leakage class this
mechanism exists to prevent (confirmed as a real risk, not hypothetical,
in this design's ML-methodology review).

Fix: this port assigns WHOLE BUFFERS to train or test based on each
buffer's own start timestamp vs. the cutoff, never per-row. Every row
sharing a bufferId is guaranteed to land on the same side by construction,
regardless of whether its time range overlaps another buffer's — overlap
between DIFFERENT buffers is simply irrelevant to this split's safety once
assignment happens at the buffer level. NORMAL/NEGATIVE_SAMPLE rows are
naturally single-row "episodes" already (one NEGATIVE_SAMPLE fault_events
row -> exactly one training_corpus row, per corpusMaterializationService.js)
and are split by the EXACT SAME chronological cutoff as fault episodes —
confirmed in ML-methodology review as the correct call: a random/
independent split for negatives would let the model train on
"future-relative-to-test-cutoff" normal examples, leaking information
across the split boundary the same way randomly splitting faults would.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

# Mirrors server/preprocessing/evaluation/episodes.js's MIN_ONSET_EPISODES —
# same reasoning (a precision/recall number computed over a handful of
# onset episodes is not a reliable estimate), re-targeted at fault-labeled
# BUFFER count rather than detected-run count.
MIN_ONSET_EPISODES = 100


def identify_episodes(corpus_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group corpus rows into "episodes" by bufferId — one episode per
    distinct buffer, chronologically ordered by the buffer's own earliest
    row. Every row in a buffer shares one label (materialization guarantees
    this — see corpusMaterializationService.js), carried on the episode.

    @param corpus_rows training_corpus rows (any order) — each expected to
        have 'bufferId', 'windowEnd', 'label'.
    @returns one entry per bufferId, sorted by startTimestamp:
        {bufferId, startTimestamp, endTimestamp, rowCount, label, rows}
    """
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in corpus_rows:
        groups[row["bufferId"]].append(row)

    episodes = []
    for buffer_id, rows in groups.items():
        rows_sorted = sorted(rows, key=lambda r: r["windowEnd"])
        episodes.append(
            {
                "bufferId": buffer_id,
                "startTimestamp": rows_sorted[0]["windowEnd"],
                "endTimestamp": rows_sorted[-1]["windowEnd"],
                "rowCount": len(rows_sorted),
                "label": rows_sorted[0]["label"],
                "rows": rows_sorted,
            }
        )

    episodes.sort(key=lambda e: e["startTimestamp"])
    return episodes


def check_evaluation_gate(corpus_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """@returns {ready, episodeCount, required} — episodeCount counts only
    fault-labeled buffers (label != 'NORMAL'), mirroring the JS original's
    onset-episode semantics; NORMAL buffers don't represent a fault onset
    and don't count toward the gate."""
    episodes = identify_episodes(corpus_rows)
    fault_episode_count = sum(1 for e in episodes if e["label"] != "NORMAL")
    return {
        "ready": fault_episode_count >= MIN_ONSET_EPISODES,
        "episodeCount": fault_episode_count,
        "required": MIN_ONSET_EPISODES,
    }


def walk_forward_split(
    corpus_rows: list[dict[str, Any]],
    test_episode_fraction: float = 0.2,
) -> dict[str, Any]:
    """Chronological, whole-buffer-granularity walk-forward split. See this
    module's docstring for why buffer-level (not row-level) assignment is
    required here, unlike the JS original it's ported from.

    @returns {trainRows, testRows, trainEpisodes, testEpisodes}
    """
    episodes = identify_episodes(corpus_rows)
    fault_episodes = [e for e in episodes if e["label"] != "NORMAL"]

    if not fault_episodes:
        return {"trainRows": list(corpus_rows), "testRows": [], "trainEpisodes": [], "testEpisodes": []}

    test_count = max(1, round(len(fault_episodes) * test_episode_fraction))
    split_index = max(0, len(fault_episodes) - test_count)
    test_fault_episodes = fault_episodes[split_index:]

    # The split point in time is the first held-out fault episode's onset.
    # Every episode (fault OR normal) whose own start precedes this
    # timestamp goes entirely to train; every episode from it onward
    # (inclusive) goes entirely to test. Whole-episode assignment, not
    # per-row — see module docstring for why this matters here.
    split_timestamp = test_fault_episodes[0]["startTimestamp"]

    train_rows: list[dict[str, Any]] = []
    test_rows: list[dict[str, Any]] = []
    train_episodes: list[dict[str, Any]] = []
    test_episodes: list[dict[str, Any]] = []

    for episode in episodes:
        is_train = episode["startTimestamp"] < split_timestamp
        (train_episodes if is_train else test_episodes).append(episode)
        (train_rows if is_train else test_rows).extend(episode["rows"])

    # Defensive safety net (design-review recommendation): confirm no
    # bufferId's rows ended up split across both sides — this should be
    # structurally impossible given whole-episode assignment above, but a
    # future edit to this function could reintroduce per-row bucketing by
    # accident, and this catches that immediately rather than silently.
    train_buffer_ids = {row["bufferId"] for row in train_rows}
    test_buffer_ids = {row["bufferId"] for row in test_rows}
    overlap = train_buffer_ids & test_buffer_ids
    if overlap:
        raise AssertionError(
            f"walk_forward_split: {len(overlap)} bufferId(s) split across train and test "
            f"— this should be structurally impossible with whole-episode assignment: {overlap}"
        )

    return {
        "trainRows": train_rows,
        "testRows": test_rows,
        "trainEpisodes": train_episodes,
        "testEpisodes": test_episodes,
    }
