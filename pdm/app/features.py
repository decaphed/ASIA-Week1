"""features.py — the fixed feature vector for Tier 2 (§15.1/D51).

train.csv has no timestamp, no window structure, and none of the 48
precap/metricStats fields training_corpus rows carry — just six raw metric
readings per row. FEATURE_ORDER is therefore a small, hand-written mapping
(not derived from schemas.py's METRICS list) so a bootstrap model trained on
train.csv and a live processedRecord agree on exactly these six fields,
nothing more.

to_vector() never zero-fills a missing/non-numeric value (same "no silent
fabrication" principle as §14.2.1/D19) — a live processedRecord or a corpus
row missing one of these fields is a real data problem that must fail
loudly, not silently train/score on a fabricated zero.
"""

from __future__ import annotations

from typing import Any

# rpm <- Engine_rpm (train.csv's column name); the rest match this
# codebase's existing metric names 1:1. Order here is what the trained
# model expects, fixed at fit time and never reordered independently of
# this constant.
FEATURE_ORDER = [
    "rpm",
    "suctionPressure",
    "dischargePressure",
    "flowRate",
    "motorTemp",
    "vibration",
]


def to_vector(record: dict[str, Any]) -> list[float]:
    """@param record a flat dict keyed by FEATURE_ORDER's names (e.g. the
        processedRecord's *Mean fields, remapped by the caller, or a
        train.csv row already renamed rpm/suctionPressure/...).
    @raises KeyError if a required key is missing.
    @raises ValueError if a required value is missing (None) or not numeric.
    """
    vector: list[float] = []
    for key in FEATURE_ORDER:
        if key not in record:
            raise KeyError(f"features.to_vector: missing required key {key!r}")
        value = record[key]
        if value is None:
            raise ValueError(f"features.to_vector: {key!r} is None")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"features.to_vector: {key!r} is not numeric: {value!r}")
        vector.append(float(value))
    return vector
