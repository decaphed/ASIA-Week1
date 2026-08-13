"""missing.py — missing-sample detection AND gap-filling, ported from
server/preprocessing/missing.js.

IMPORTANT DEVIATION FROM THE JS ORIGINAL (flagged during blueprinting, not
silently introduced): in server/preprocessing/pipeline.js, generateFillSamples
runs per incoming sample, at ingest time, before a sample is ever buffered —
by the time processClosedWindow runs, the window already contains any
IMPUTED fill rows, interleaved in sorted order. Since pdm/app/preprocessing/
pipeline.py is a stateless, one-call-per-window function (§11.2), gap-fill
generation is relocated here into a single batch pass over the window at
window-close time — walking the sorted sequence [prevSample, *windowSamples]
pairwise and calling generate_fill_samples() for each adjacent pair,
splicing results in between. This is a structural relocation, not a
behavioral reinterpretation: each pairwise call still uses the exact same
gap-fill logic as the JS original, including the asymmetry where the
newly-arrived sample's own physicsValid is not yet known at fill-decision
time (mirrored by pipeline.py calling this before validate_physics has run
on that sample) — see pipeline.py's stage-ordering comments.

impute_invalid_runs() replaces runs of physics-invalid samples with
interpolated values, but ONLY when fault_classifier.py determines the run is
a SENSOR_FAULT (safe to repair). A run classified NOT_SENSOR_FAULT (genuine
abnormal operation) is left raw and tagged abnormalOperation: True instead,
so outlier.py can exempt it from Hampel capping too.
"""

from __future__ import annotations

from typing import Any, Optional

from ._stats import js_round, ms_to_iso, parse_ts_ms
from .config import MAX_FILLABLE_GAP_SECONDS, MAX_FILLABLE_GAP_SECONDS_BY_METRIC
from .fault_classifier import classify_invalid_run
from .transition import detect_transition

GAP_THRESHOLD_SECONDS = 1.5


def _interpolate_metrics(
    from_sample: dict[str, Any], to_sample: dict[str, Any], t: float, metrics: list[str]
) -> tuple[dict[str, Optional[float]], list[str]]:
    """Linearly interpolate each of `metrics` between `from_sample` and
    `to_sample` at position `t` (0..1). A metric that's None on either
    endpoint can't be interpolated with any confidence — left None and
    reported in `unfilled` rather than treating the missing side as 0."""
    values: dict[str, Optional[float]] = {}
    unfilled: list[str] = []
    for metric in metrics:
        from_val = from_sample.get(metric)
        to_val = to_sample.get(metric)
        if from_val is None or to_val is None:
            values[metric] = None
            unfilled.append(metric)
            continue
        values[metric] = from_val + t * (to_val - from_val)
    return values, unfilled


def detect_missing(
    samples: list[dict[str, Any]],
    window_start: Optional[str] = None,
    window_end: Optional[str] = None,
) -> int:
    """@returns estimated number of ticks that never arrived (residual gaps
    too large to trust an interpolated guess for, plus leading/trailing
    boundary gaps against window_start/window_end)."""
    missing_count = 0.0

    for i in range(1, len(samples)):
        dt_sec = (parse_ts_ms(samples[i]["timestamp"]) - parse_ts_ms(samples[i - 1]["timestamp"])) / 1000
        if dt_sec > GAP_THRESHOLD_SECONDS:
            missing_count += js_round(dt_sec) - 1

    if samples and window_start is not None and window_end is not None:
        leading_gap_sec = (parse_ts_ms(samples[0]["timestamp"]) - parse_ts_ms(window_start)) / 1000
        if leading_gap_sec > GAP_THRESHOLD_SECONDS:
            missing_count += js_round(leading_gap_sec)

        trailing_gap_sec = (parse_ts_ms(window_end) - parse_ts_ms(samples[-1]["timestamp"])) / 1000
        if trailing_gap_sec > GAP_THRESHOLD_SECONDS:
            missing_count += js_round(trailing_gap_sec)

    return int(missing_count)


def generate_fill_samples(
    last_sample: Optional[dict[str, Any]],
    new_sample: dict[str, Any],
    metrics: list[str],
) -> list[dict[str, Any]]:
    """@param last_sample the last sample actually accepted/merged (any
    provenance), or None if this is the first ever.
    @param new_sample the just-arrived real sample — must NOT carry a
    physicsValid key yet (matches the JS original's call-site ordering,
    where this runs before that sample has been physics-validated).
    @returns zero or more synthesized samples to insert, in order, between
    last_sample and new_sample."""
    if not last_sample:
        return []

    last_ms = parse_ts_ms(last_sample["timestamp"])
    new_ms = parse_ts_ms(new_sample["timestamp"])
    dt_sec = (new_ms - last_ms) / 1000

    # Too large for even the most tolerant metric, arrived out of order, or
    # not actually a gap (normal cadence) — nothing to fill.
    if dt_sec > MAX_FILLABLE_GAP_SECONDS:
        return []
    missing_ticks = js_round(dt_sec) - 1
    if missing_ticks <= 0:
        return []

    # A suspected transition (status change, or either endpoint already
    # physics-invalid) invalidates the "nothing eventful happened" assumption
    # for the WHOLE gap — nothing is fabricated at all rather than guessing
    # which parts might still be trustworthy.
    transition = detect_transition(last_sample, new_sample, dt_sec)
    if transition["statusChanged"] or transition["eitherInvalid"]:
        return []

    fills: list[dict[str, Any]] = []
    for i in range(1, int(missing_ticks) + 1):
        t = i / (missing_ticks + 1)  # evenly spaced across the gap
        row: dict[str, Any] = {
            "timestamp": ms_to_iso(last_ms + t * (new_ms - last_ms)),
            "status": last_sample["status"],  # categorical — carry forward, can't interpolate
            "provenance": "IMPUTED",
        }

        unfilled_metrics: list[str] = []
        for metric in metrics:
            ceiling = MAX_FILLABLE_GAP_SECONDS_BY_METRIC.get(metric, MAX_FILLABLE_GAP_SECONDS)
            if dt_sec > ceiling or transition["rampExceeded"].get(metric):
                row[metric] = None
                unfilled_metrics.append(metric)
                continue
            row[metric] = last_sample[metric] + t * (new_sample[metric] - last_sample[metric])
        if unfilled_metrics:
            row["unfilledMetrics"] = unfilled_metrics

        fills.append(row)
    return fills


def impute_invalid_runs(
    window: list[dict[str, Any]],
    metrics: list[str],
    ranges: dict[str, dict[str, float]],
    before_context: Optional[dict[str, Any]] = None,
) -> list[dict[str, Any]]:
    """Replace runs of physics-invalid samples inside a completed window with
    linearly-interpolated values — but ONLY when fault_classifier.py
    verdicts the run SENSOR_FAULT. A NOT_SENSOR_FAULT run (genuine abnormal
    operation) is left raw and tagged abnormalOperation: True instead.

    @param window completed AUDIT window, in timestamp order.
    @param metrics numeric metric names to interpolate.
    @param ranges physics RANGES (pump-physics.yaml), passed through to
        fault_classifier.classify_invalid_run.
    @param before_context the single prior-window sample (prevSample) used
        as a `before` neighbor when a run starts at the very beginning of
        `window` — replaces buffer.js::getRecentTail()'s multi-sample tail,
        since fault_classifier's rules only ever read recentTail[-1].
    @returns same length as window; SENSOR_FAULT runs replaced with samples
        flagged imputedForPhysics: True; NOT_SENSOR_FAULT runs flagged
        abnormalOperation: True; everything else untouched.
    """
    result = list(window)
    n = len(result)
    i = 0

    while i < n:
        if result[i].get("physicsValid") is not False:
            i += 1
            continue

        j = i
        while j < n and result[j].get("physicsValid") is False:
            j += 1
        run = result[i:j]
        before = result[i - 1] if i > 0 else before_context
        after = result[j] if j < n else None

        verdict = classify_invalid_run(run, before, after, ranges)

        if verdict == "SENSOR_FAULT" and (before is not None or after is not None):
            from_sample = before if before is not None else after
            to_sample = after if after is not None else before
            before_ms = parse_ts_ms(before["timestamp"]) if before is not None else None
            after_ms = parse_ts_ms(after["timestamp"]) if after is not None else None

            for k in range(len(run)):
                if before is not None and after is not None and after_ms != before_ms:
                    # Elapsed-time-weighted, not index-weighted — adjacent
                    # array positions no longer imply uniform elapsed time
                    # now that fill rows can be interleaved into the window.
                    sample_ms = parse_ts_ms(result[i + k]["timestamp"])
                    t = (sample_ms - before_ms) / (after_ms - before_ms)
                else:
                    # Only one side available (or both endpoints coincide) —
                    # flat carry-forward/back.
                    t = 1
                values, unfilled = _interpolate_metrics(from_sample, to_sample, t, metrics)
                new_row = dict(result[i + k])
                new_row["imputedForPhysics"] = True
                new_row.update(values)
                if unfilled:
                    new_row["unfilledMetrics"] = unfilled
                result[i + k] = new_row
        else:
            # NOT_SENSOR_FAULT (or no neighbor at all to interpolate from) —
            # preserve as genuine abnormal-operation evidence, untouched.
            for k in range(len(run)):
                new_row = dict(result[i + k])
                new_row["abnormalOperation"] = True
                result[i + k] = new_row

        i = j

    return result
