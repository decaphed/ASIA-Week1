"""Tier 2 entry point (§15.1/D51, §15.1/D56, §14.3.4/D27).

Loads the bootstrap artifact once at module import time (mirroring how
thresholds.yaml is loaded once at startup, not per-request — rules.py's
same discipline). main.py's /score handler already calls rules.evaluate()
first; a non-None result from score() AUGMENTS the rule verdict, never
replaces it, per the tiered design (§3.5) — preprocessing/pipeline.py's
/process-window path calls this the same way (§15.1's fix to §14.0 item 5's
gap: the live path never called model.score() at all before this).

score()'s wire format is §14.3.4/D27's existing generic naming
(tier2Label/tier2Probability/tier2ModelRunId/tier2ArtifactSha256), not a
bootstrap-specific pair — §15.1/D56's correction, so a later multi-class
candidate's tier2Label values slot into the exact same field this bootstrap
model already populates, no schema change at the transition.

Artifact load failure (missing file, corrupt joblib, unset runId) logs the
specific reason and leaves the module-level model unloaded — score()
returns None, Tier 1 is unaffected, same fallback posture as always. No
exception ever escapes to a caller.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from . import training
from .features import to_vector

logger = logging.getLogger(__name__)

# processedRecord's flat *Mean fields, remapped to features.FEATURE_ORDER's
# plain names — the live equivalent of train.csv's already-plain columns.
_PROCESSED_RECORD_FEATURE_FIELDS = {
    "rpm": "rpmMean",
    "suctionPressure": "suctionPressureMean",
    "dischargePressure": "dischargePressureMean",
    "flowRate": "flowRateMean",
    "motorTemp": "motorTempMean",
    "vibration": "vibrationMean",
}


def _load_artifact() -> Optional[dict[str, Any]]:
    artifact_dir = training._artifact_dir()
    metadata_path = artifact_dir / "metadata.json"
    model_path = artifact_dir / "model.joblib"

    if not metadata_path.exists() or not model_path.exists():
        logger.info("model.py: no Tier 2 artifact found at %s — Tier 1 only", artifact_dir)
        return None

    try:
        with open(metadata_path, "r", encoding="utf-8") as f:
            metadata = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        logger.error("model.py: failed to read metadata.json at %s: %s", metadata_path, exc)
        return None

    run_id = metadata.get("runId")
    if run_id is None:
        logger.error(
            "model.py: %s has no runId — training_runs row not yet recorded "
            "(see training.py::stamp_run_id) — Tier 1 only until it is",
            metadata_path,
        )
        return None

    artifact_sha256 = metadata.get("artifactSha256")
    if artifact_sha256 is None:
        logger.error("model.py: %s has no artifactSha256 — Tier 1 only", metadata_path)
        return None

    try:
        import joblib

        estimator = joblib.load(model_path)
    except Exception as exc:  # noqa: BLE001 — any load failure must degrade, never crash
        logger.error("model.py: failed to load artifact at %s: %s", model_path, exc)
        return None

    return {
        "estimator": estimator,
        "runId": run_id,
        "artifactSha256": artifact_sha256,
    }


_artifact = _load_artifact()


def reload() -> None:
    """Re-runs _load_artifact() and swaps it into the module-level
    _artifact in place — how /training/deploy (Task 4) makes a newly
    written artifact live without a container restart.

    SINGLE-WORKER ASSUMPTION: safe only because pdm's Dockerfile CMD runs
    uvicorn with no --workers flag (1 worker, 1 process) — the module-level
    _artifact global is single-writer/single-reader, and CPython's GIL
    makes this one-line reassignment an atomic pointer swap (no torn read
    for a concurrent /score call). If pdm is ever scaled to multiple
    workers/processes, this reload() no longer reaches every process and
    needs a real cross-process signal (e.g. a shared version file each
    worker polls) instead — do not add --workers without also fixing this."""
    global _artifact
    _artifact = _load_artifact()


def reset() -> None:
    """Deletes the live artifact files (if present) and clears the loaded
    model — the "start over" operation (§15.7). Idempotent: safe to call
    when no artifact exists at all."""
    global _artifact
    artifact_dir = training._artifact_dir()
    for filename in ("model.joblib", "metadata.json"):
        path = artifact_dir / filename
        if path.exists():
            path.unlink()
    _artifact = None


def score(record: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Tier 2 entry point. Returns None if no artifact is loaded, or if the
    record is missing a required feature (logged, never raised)."""
    if _artifact is None:
        return None

    feature_record = {}
    for feature_name, record_field in _PROCESSED_RECORD_FEATURE_FIELDS.items():
        feature_record[feature_name] = record.get(record_field)

    try:
        vector = to_vector(feature_record)
    except (KeyError, ValueError) as exc:
        logger.error("model.py: score() could not build a feature vector: %s", exc)
        return None

    estimator = _artifact["estimator"]
    try:
        predicted_label = estimator.predict([vector])[0]
        class_index = list(estimator.classes_).index(predicted_label)
        probability = float(estimator.predict_proba([vector])[0][class_index])
    except Exception as exc:  # noqa: BLE001 — a scoring failure must degrade, never crash
        logger.error("model.py: score() prediction failed: %s", exc)
        return None

    return {
        "tier2Label": predicted_label,
        "tier2Probability": probability,
        "tier2ModelRunId": _artifact["runId"],
        "tier2ArtifactSha256": _artifact["artifactSha256"],
    }
