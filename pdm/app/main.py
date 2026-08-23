"""FastAPI app: POST /score, POST /process-window, GET /health (§3.5, §11.6.2).

thresholds.yaml is loaded once at container startup (module import time),
not per-request — mirroring how the rest of this codebase avoids repeated
file I/O on a hot path.
"""

import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Optional

import pandas as pd
from fastapi import FastAPI, HTTPException, UploadFile

from . import model, rules, training, training_quality
from .preprocessing.pipeline import AllSamplesInvalidError, process_window
from .schemas import (
    ProcessedRecordIn, ProcessWindowRequest, ProcessWindowResponse, ScoreResponse,
    StampRunIdRequest, TrainingDeployResponse, TrainingFitResponse, TrainingUploadResponse,
)

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


def _candidates_dir() -> Path:
    return training._artifact_dir() / "candidates"


def _candidate_dir(upload_id: str) -> Path:
    # upload_id always comes from uuid.uuid4().hex (this module's own
    # /training/upload), never from unsanitized user input, so it's safe
    # to use directly as a path segment.
    return _candidates_dir() / upload_id


def _live_metrics() -> Optional[dict]:
    metadata_path = training._artifact_dir() / "metadata.json"
    if not metadata_path.exists():
        return None
    with open(metadata_path, "r", encoding="utf-8") as f:
        return json.load(f).get("metrics")


CANDIDATE_MAX_AGE_SECONDS = 24 * 60 * 60  # design-review finding: candidates/ lives on the
# persistent pdm_artifacts Docker volume (docker-compose.yml), not ephemeral container storage —
# an abandoned upload (never deployed, never explicitly discarded) would otherwise sit there
# forever. Every /training/upload call sweeps stale candidate dirs first, since this route is
# open to anyone with no auth gate and no other cleanup trigger exists.
def _sweep_stale_candidates() -> None:
    import time

    candidates_dir = _candidates_dir()
    if not candidates_dir.exists():
        return
    now = time.time()
    for entry in candidates_dir.iterdir():
        if entry.is_dir() and (now - entry.stat().st_mtime) > CANDIDATE_MAX_AGE_SECONDS:
            shutil.rmtree(entry, ignore_errors=True)


@app.post("/training/upload", response_model=TrainingUploadResponse, status_code=201)
async def upload_training_csv(file: UploadFile) -> dict:
    _sweep_stale_candidates()

    df = pd.read_csv(file.file)
    report = training_quality.assess(df)

    if report["verdict"] == "REJECTED":
        raise HTTPException(status_code=422, detail=report)

    upload_id = uuid.uuid4().hex
    candidate_dir = _candidate_dir(upload_id)
    candidate_dir.mkdir(parents=True, exist_ok=True)
    cleaned = training_quality.clean(df)
    cleaned.to_csv(candidate_dir / "train.csv", index=False)

    return {
        "uploadId": upload_id, "verdict": report["verdict"], "qualityScore": report["qualityScore"],
        "rowCount": report["rowCount"], "reasons": report["reasons"],
    }


@app.post("/training/{upload_id}/fit", response_model=TrainingFitResponse)
def fit_candidate(upload_id: str) -> dict:
    candidate_dir = _candidate_dir(upload_id)
    train_csv_path = candidate_dir / "train.csv"
    if not train_csv_path.exists():
        raise HTTPException(status_code=404, detail=f"no upload found for uploadId={upload_id}")

    fitted = training.fit_model(str(train_csv_path), artifact_dir=candidate_dir)

    return {
        "uploadId": upload_id,
        "candidateMetrics": fitted.metrics,
        "deployedMetrics": _live_metrics(),
    }


@app.post("/training/{upload_id}/deploy", response_model=TrainingDeployResponse)
def deploy_candidate(upload_id: str) -> dict:
    candidate_dir = _candidate_dir(upload_id)
    candidate_model = candidate_dir / "model.joblib"
    candidate_metadata = candidate_dir / "metadata.json"
    if not candidate_model.exists() or not candidate_metadata.exists():
        raise HTTPException(status_code=404, detail=f"no fitted candidate found for uploadId={upload_id} — call /fit first")

    # Design-review finding: copy to temp names first, then rename both into
    # place — os.replace() is atomic on the same filesystem, so a failure
    # partway through (disk full, permissions) never leaves the live
    # directory with a new model.joblib but a stale/missing metadata.json.
    live_dir = training._artifact_dir()
    live_dir.mkdir(parents=True, exist_ok=True)
    tmp_model = live_dir / ".model.joblib.tmp"
    tmp_metadata = live_dir / ".metadata.json.tmp"
    shutil.copy2(candidate_model, tmp_model)
    shutil.copy2(candidate_metadata, tmp_metadata)
    os.replace(tmp_model, live_dir / "model.joblib")
    os.replace(tmp_metadata, live_dir / "metadata.json")
    model.reload()

    with open(live_dir / "metadata.json", "r", encoding="utf-8") as f:
        metadata = json.load(f)

    return {"artifactSha256": metadata["artifactSha256"], "trainedAt": metadata["trainedAt"], "metrics": metadata["metrics"]}


@app.delete("/training/{upload_id}")
def discard_candidate(upload_id: str) -> dict:
    candidate_dir = _candidate_dir(upload_id)
    if candidate_dir.exists():
        shutil.rmtree(candidate_dir)
    return {"deleted": True}


@app.post("/training/reset")
def reset_live_model() -> dict:
    model.reset()
    return {"reset": True}


@app.post("/training/stamp-run-id")
def stamp_live_run_id(payload: StampRunIdRequest) -> dict:
    """Design-review finding, fixed here: fit_model() always writes
    runId: null (training.py's own module docstring — "the id can only
    ever be handed back this way, not looked up"), and model._load_artifact()
    deliberately refuses to load any artifact with runId: null (Tier 1-only
    fallback). Without this endpoint, /deploy's copy would carry that null
    runId into the live directory forever, and Tier 2 would never activate
    for an upload-deployed model. Node's deployCandidate() (Task 5, not yet
    built) calls this immediately after it inserts the training_runs row,
    passing back the real Postgres id — the exact same fit -> insert ->
    stamp handoff the CLI bootstrap flow already uses (recordBootstrapRun.js
    -> `python -m pdm.app.training stamp-run-id`), just over HTTP instead of
    a second CLI invocation."""
    training.stamp_run_id(payload.runId)
    model.reload()
    return {"stamped": True, "runId": payload.runId}
