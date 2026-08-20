"""pipeline.py — new stateless orchestration tying the ported preprocessing
stages together (docs/plan/2026-08-05-pdm-implementation.md §11.2/§11.6.2).

NOT a port of server/preprocessing/pipeline.js — that module is live-stream-
stateful (in-memory buffer.js windowing, a running "last accepted sample"
pointer, an ingest-time gap-fill loop spread across many POST /api/data
calls). This is fresh code: a single pure function that reconstructs the
equivalent of one closed WindowState from a self-contained request payload,
then runs the same logical stage sequence the JS pipeline runs per window:
gap-fill -> physics-validate -> impute invalid runs -> outlier-cap ->
aggregate -> precap features -> quality -> Tier 1 rule evaluation (rules.py,
unchanged) -> both the full processed_telemetry row shape and the Tier 1
verdict in one response.
"""

from __future__ import annotations

from typing import Any, Optional

from .. import model, rules
from ..physics import load_ranges
from ._stats import now_iso, parse_ts_ms
from .aggregation import aggregate_window
from .config import EXPECTED_SAMPLE_COUNT, METRICS
from .missing import detect_missing, generate_fill_samples, impute_invalid_runs
from .outlier import hampel_cap
from .precap_features import compute_precap_features
from .quality import compute_quality
from .validator import validate_physics

PREPROCESSING_VERSION = "v3-py"

RANGES = load_ranges()


class AllSamplesInvalidError(Exception):
    """Raised when every sample in the reconstructed audit window fails
    physics validation — mirrors pipeline.js::processClosedWindow's early-
    return/log-and-skip behavior for an all-invalid window (no
    processed_telemetry row is produced for that window). main.py maps this
    to a distinct response so Node's caller can distinguish "nothing to
    process" from a genuine Python error (§11.6.2's endpoint description;
    the exact HTTP status is an implementation-time call per the code-
    architect blueprint, resolved in main.py)."""


def _build_audit_window(
    window_samples: list[dict[str, Any]],
    prev_sample: Optional[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Reconstruct the equivalent of buffer.js's WindowState.samples: real
    samples plus any IMPUTED gap-fill rows generated between them, each
    physics-validated in strict chronological (sequential) order — the
    batch analog of pipeline.js's per-sample ingestSample() loop.

    This is a genuine structural relocation from the JS original, not
    guessed: in server/preprocessing/pipeline.js, generateFillSamples runs
    per incoming sample at ingest time, before a sample is ever buffered, so
    a closed window's samples already contain any fill rows by the time
    processClosedWindow runs. Since this function is called once per
    already-closed window (§11.2's stateless design), gap-fill generation
    happens here instead, in one batch pass — see missing.py's module
    docstring for the full reasoning, including the deliberately-preserved
    asymmetry where a not-yet-validated sample's physicsValid is treated as
    unknown (not False) when generate_fill_samples() decides whether to
    suspect a transition.

    Fill rows generated against `prev_sample` (bridging the gap between the
    previous window's last sample and this window's first real sample) are
    attributed to THIS window — a simplification versus the JS original,
    where a fill row's own timestamp determines which window it's
    classified into (occasionally the previous one, for a gap straddling
    the boundary). Exact cross-window fill attribution needs Node to pass
    each sample's own classification (ACCEPTED/MERGED) to resolve precisely
    per the code-architect blueprint's recommendation — out of this
    session's scope; flagged here rather than silently assumed correct, for
    the golden-value parity suite to catch if it matters in practice.
    """
    audit_window: list[dict[str, Any]] = []
    last: Optional[dict[str, Any]] = prev_sample

    for sample in window_samples:
        # Must not carry physicsValid yet at fill-decision time, matching
        # the JS original's call-site ordering (validator.py's note).
        candidate = {k: v for k, v in sample.items() if k not in ("physicsValid", "physicsViolations")}

        fills = generate_fill_samples(last, candidate, METRICS)
        for fill in fills:
            dt_sec = (parse_ts_ms(fill["timestamp"]) - parse_ts_ms(last["timestamp"])) / 1000 if last else None
            physics = validate_physics(fill, last, dt_sec)
            fill_row = {**fill, **physics}
            audit_window.append(fill_row)
            last = fill_row

        dt_sec = (parse_ts_ms(candidate["timestamp"]) - parse_ts_ms(last["timestamp"])) / 1000 if last else None
        physics = validate_physics(candidate, last, dt_sec)
        real_row = {**candidate, "provenance": candidate.get("provenance") or "MEASURED", **physics}
        audit_window.append(real_row)
        last = real_row

    return audit_window


def process_window(
    window_samples: list[dict[str, Any]],
    prev_sample: Optional[dict[str, Any]],
    window_start: str,
    window_end: str,
    merged_sample_count: int = 0,
    duplicate_sample_count: int = 0,
    thresholds: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Fully process one closed window and return both the full
    processed_telemetry row shape and the Tier 1 verdict in one call.

    @raises AllSamplesInvalidError if every sample in the reconstructed
        audit window fails physics validation.
    """
    if thresholds is None:
        thresholds = rules.load_thresholds()

    window = _build_audit_window(window_samples, prev_sample)
    if not window:
        raise AllSamplesInvalidError("process_window: window_samples is empty")

    missing_count = detect_missing(window, window_start, window_end)
    imputed_sample_count = sum(1 for s in window if s.get("provenance") == "IMPUTED")
    partially_imputed_count = sum(1 for s in window if s.get("unfilledMetrics"))

    # Physics-invalid samples are still stored/counted (quality.py);
    # valid_window is only used here to detect the all-invalid-window case —
    # for stats/aggregation, invalid runs get classified and either repaired
    # (SENSOR_FAULT) or preserved (NOT_SENSOR_FAULT) instead of dropped.
    valid_window = [s for s in window if s.get("physicsValid") is not False]
    if not valid_window:
        raise AllSamplesInvalidError(
            f"process_window: entire window failed physics validation (window {window_start} - {window_end})"
        )

    stats_window = impute_invalid_runs(window, METRICS, RANGES, prev_sample)
    physics_imputed_count = sum(1 for s in stats_window if s.get("imputedForPhysics") is True)
    abnormal_operation_sample_count = sum(1 for s in stats_window if s.get("abnormalOperation") is True)

    # Hampel-filter outliers, per metric — evaluated over stats_window only,
    # with abnormal-operation samples exempted from both being capped AND
    # from polluting a neighbor's median/MAD baseline.
    exclude_mask = [s.get("abnormalOperation") is True for s in stats_window]

    capped_by_metric: dict[str, list[Any]] = {}
    outliers_by_metric: dict[str, int] = {}
    precap_features_by_metric: dict[str, Any] = {}
    outlier_count = 0
    for metric in METRICS:
        raw = [s.get(metric) for s in stats_window]
        hampel = hampel_cap(raw, 3, exclude_mask)
        capped_by_metric[metric] = hampel["capped"]
        outliers_by_metric[metric] = hampel["outlierCount"]
        outlier_count += hampel["outlierCount"]
        precap_features_by_metric[metric] = compute_precap_features(raw)

    agg = aggregate_window(window, stats_window, capped_by_metric)

    quality = compute_quality(
        window=window,
        missing_count=missing_count,
        outlier_count=outlier_count,
        metric_count=len(METRICS),
        evaluated_sample_count=len(stats_window),
        imputed_sample_count=imputed_sample_count,
        physics_imputed_count=physics_imputed_count,
        late_sample_count=merged_sample_count,
        merged_sample_count=merged_sample_count,
        duplicate_sample_count=duplicate_sample_count,
        partially_imputed_count=partially_imputed_count,
    )

    processed_record: dict[str, Any] = {
        "windowStart": agg["windowStart"],
        "windowEnd": agg["windowEnd"],
        "timestamp": agg["windowEnd"],  # canonical timestamp = end of window
        "dominantStatus": agg["dominantStatus"],
        "dominantFaultType": agg["dominantFaultType"],
        "runningSeconds": agg["runningSeconds"],
        "faultSeconds": agg["faultSeconds"],
        "stoppedSeconds": agg["stoppedSeconds"],
        "sampleCount": agg["sampleCount"],
        "expectedSampleCount": EXPECTED_SAMPLE_COUNT,
        "missingSampleCount": missing_count,
        "imputedSampleCount": quality["imputedSampleCount"],
        "physicsImputedCount": quality["physicsImputedCount"],
        "outlierCount": outlier_count,
        "outliersByMetric": outliers_by_metric,
        "precapFeaturesByMetric": precap_features_by_metric,
        "physicsViolationCount": quality["physicsViolationCount"],
        "violationsByMetric": quality["violationsByMetric"],
        "missingRate": quality["missingRate"],
        "imputationRate": quality["imputationRate"],
        "physicsImputationRate": quality["physicsImputationRate"],
        "outlierRate": quality["outlierRate"],
        "physicsPassRate": quality["physicsPassRate"],
        "qualityScore": quality["qualityScore"],
        "qualityLabel": quality["qualityLabel"],
        "isImputed": quality["isImputed"],
        "lateSampleCount": quality["lateSampleCount"],
        "mergedSampleCount": quality["mergedSampleCount"],
        "duplicateSampleCount": quality["duplicateSampleCount"],
        "partiallyImputedCount": quality["partiallyImputedCount"],
        "partiallyImputedRate": quality["partiallyImputedRate"],
        "abnormalOperationSampleCount": abnormal_operation_sample_count,
        "preprocessingVersion": PREPROCESSING_VERSION,
        "preprocessingTimestamp": now_iso(),
    }

    for metric in METRICS:
        processed_record[f"{metric}Mean"] = agg["stats"][metric]["mean"]
        processed_record[f"{metric}Median"] = agg["stats"][metric]["median"]
        processed_record[f"{metric}Min"] = agg["stats"][metric]["min"]
        processed_record[f"{metric}Max"] = agg["stats"][metric]["max"]
        processed_record[f"{metric}StdDev"] = agg["stats"][metric]["stdDev"]
        processed_record[f"{metric}Last"] = agg["stats"][metric]["last"]

    tier1_verdict = rules.evaluate(processed_record, thresholds)

    # Tier 2 (§15.1/D51) augments, never replaces, the rule verdict — same
    # merge main.py's /score handler already does; this is the live
    # /process-window path's fix for §14.0 item 5's gap (it never called
    # model.score() at all before this).
    tier2_verdict = model.score(processed_record)
    if tier2_verdict is not None:
        tier1_verdict = {**tier1_verdict, **tier2_verdict}

    return {"processedRecord": processed_record, "tier1Verdict": tier1_verdict}
