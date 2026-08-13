"""FastAPI app: POST /score, POST /process-window, GET /health (§3.5, §11.6.2).

thresholds.yaml is loaded once at container startup (module import time),
not per-request — mirroring how the rest of this codebase avoids repeated
file I/O on a hot path.
"""

from fastapi import FastAPI, HTTPException

from . import model, rules
from .preprocessing.pipeline import AllSamplesInvalidError, process_window
from .schemas import ProcessedRecordIn, ProcessWindowRequest, ProcessWindowResponse, ScoreResponse

app = FastAPI(title="PdM Tier 1 Rule Engine")

_thresholds = rules.load_thresholds()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/score", response_model=ScoreResponse)
def score(record: ProcessedRecordIn) -> dict:
    verdict = rules.evaluate(record.model_dump(), _thresholds)

    # Tier 2 (no model loaded yet — see model.py) augments, never replaces,
    # the rule verdict once it exists.
    tier2_verdict = model.score(record.model_dump())
    if tier2_verdict is not None:
        verdict = {**verdict, **tier2_verdict}

    return verdict


@app.post("/process-window", response_model=ProcessWindowResponse)
def process_window_endpoint(payload: ProcessWindowRequest) -> dict:
    """Runs the full ported preprocessing pipeline over one closed window
    and returns both the processed_telemetry row and the Tier 1 verdict in
    one call (§11.2, §11.6.2) — Pydantic validates the request shape at the
    boundary (422 on mismatch), same as /score; no try/except here beyond
    the one explicit case below, so Node's short-timeout caller sees a
    clean failure to log-and-skip rather than a silently-wrong 200.

    NOTE for the §11.6.3 Node integration (skip-logic on non-200): both a
    malformed request (Pydantic validation failure) AND an all-invalid
    window (AllSamplesInvalidError) currently return status 422 — either
    way, Node's "log and skip, no processed_telemetry row" behavior is
    identical, so this doesn't need to be disambiguated to implement §11.5
    item 2. If a future caller ever DOES need to tell them apart: Pydantic's
    422 body shape is `{"detail": [{"type", "loc", "msg", "input"}, ...]}`
    (a list), while this endpoint's own 422 is `{"detail": "<string>"}` —
    check whether `detail` is a list vs. a string, not the status code alone.
    """
    try:
        result = process_window(
            window_samples=[s.model_dump() for s in payload.windowSamples],
            prev_sample=payload.prevSample.model_dump() if payload.prevSample else None,
            window_start=payload.windowStart,
            window_end=payload.windowEnd,
            merged_sample_count=payload.mergedSampleCount,
            duplicate_sample_count=payload.duplicateSampleCount,
            thresholds=_thresholds,
        )
    except AllSamplesInvalidError as exc:
        # Distinct from a genuine pipeline error: "nothing to process" for
        # this window (every sample failed physics validation), mirroring
        # pipeline.js::processClosedWindow's log-and-skip behavior. 422
        # (not 200-with-null) so Node's skip-logic can tell this apart from
        # a successful response without inspecting a nullable field.
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return result
