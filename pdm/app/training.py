"""training.py — §15.1/D51: fits the Tier 2 bootstrap model directly from
data/train.csv, outside training_corpus entirely (train.csv's shape — six
raw values, no timestamp, no window structure — doesn't fit the
54-feature training_corpus pipeline; forcing it through would mean
fabricating features that were never collected).

Deliberately separate from retrain.py: retrain.py orchestrates the ongoing
corpus-based champion/challenger loop (§10.5/§14, admin-CSV-upload-driven
per §15.2/D52); this module is the one-off bootstrap path. Both write a
result shape server/scripts (recordTrainingRun.js / recordBootstrapRun.js)
can persist into the SAME training_runs table (§15.1/D56's reasoning: one
table of trained artifacts, not two fragmented bookkeeping mechanisms).

Artifact handoff, one-time bootstrap only (not the general §14.3 artifact
store lifecycle, out of scope here): fit_model() writes model.joblib +
metadata.json under PDM_ARTIFACT_DIR (a volume mounted into the pdm
container/host so model.py can read it back at import time). metadata.json
initially has "runId": null; once server/scripts/recordBootstrapRun.js
inserts the training_runs row and returns its id, stamp_run_id() rewrites
metadata.json with the real id — this repo's Python-never-writes-Postgres
invariant (§3.4) means the id can only ever be handed back this way, not
looked up by Python from a live query for this bootstrap path.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .features import FEATURE_ORDER, to_vector

DEFAULT_ARTIFACT_DIR = Path(__file__).parent / "artifacts"
TRAINING_CONFIG_PATH = Path(__file__).parent / "training_config.yaml"

# train.csv's own column names -> this codebase's metric names (§15.1).
TRAIN_CSV_COLUMN_MAP = {
    "Engine_rpm": "rpm",
    "suctionPressure": "suctionPressure",
    "dischargePressure": "dischargePressure",
    "flowRate": "flowRate",
    "motorTemp": "motorTemp",
    "vibration": "vibration",
}
TRAIN_CSV_LABEL_COLUMN = "Engine_Condition"


def _artifact_dir() -> Path:
    return Path(os.environ.get("PDM_ARTIFACT_DIR", str(DEFAULT_ARTIFACT_DIR)))


def load_training_config(path: Path = TRAINING_CONFIG_PATH) -> dict[str, Any]:
    import yaml

    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


@dataclass
class FittedModel:
    estimator: Any
    artifact_path: str
    artifact_sha256: str
    trained_at: str
    model_family: str
    config_version: str
    metrics: dict[str, Any] = field(default_factory=dict)
    label_classes: list[str] = field(default_factory=list)


def _build_estimator(model_family: str, config: dict[str, Any], random_state: int):
    if model_family == "xgboost":
        from xgboost import XGBClassifier

        cfg = config["xgboost"]
        return XGBClassifier(
            n_estimators=cfg["nEstimators"],
            max_depth=cfg["maxDepth"],
            learning_rate=cfg["learningRate"],
            random_state=random_state,
        )

    from sklearn.ensemble import RandomForestClassifier

    cfg = config["randomForest"]
    return RandomForestClassifier(
        n_estimators=cfg["nEstimators"],
        max_depth=cfg["maxDepth"],
        min_samples_leaf=cfg["minSamplesLeaf"],
        class_weight=cfg["classWeight"],
        random_state=random_state,
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fit_model(train_csv_path: str, *, config: Optional[dict[str, Any]] = None) -> FittedModel:
    """Loads train_csv_path directly (not through training_corpus), fits a
    binary classifier, and writes the artifact to PDM_ARTIFACT_DIR.

    Stratified train/test split — NOT walk-forward: train.csv has no
    timestamp, so there's no time axis to leak across (§15.1's explicit
    correction to §10.5's walk-forward-by-default approach, which only
    applies to timestamped corpus rows).

    Labels are emitted as "NORMAL"/"FAULT" strings (§15.1/D56, §15.5's
    settled naming) — never bare 0/1 — so training_runs history stays
    self-describing without cross-referencing which model generation
    produced a given run.
    """
    import pandas as pd
    from sklearn.model_selection import train_test_split

    if config is None:
        config = load_training_config()

    model_family = os.environ.get("PDM_MODEL_FAMILY", config["modelFamily"])
    random_state = config["randomState"]

    df = pd.read_csv(train_csv_path)
    missing_columns = set(TRAIN_CSV_COLUMN_MAP) | {TRAIN_CSV_LABEL_COLUMN}
    missing_columns -= set(df.columns)
    if missing_columns:
        raise ValueError(f"training.fit_model: train.csv is missing column(s): {sorted(missing_columns)}")

    renamed = df.rename(columns=TRAIN_CSV_COLUMN_MAP)
    rows = renamed[FEATURE_ORDER].to_dict("records")
    X = [to_vector(row) for row in rows]
    y = ["FAULT" if int(v) == 1 else "NORMAL" for v in df[TRAIN_CSV_LABEL_COLUMN]]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=config["testSize"], random_state=random_state, stratify=y,
    )

    estimator = _build_estimator(model_family, config, random_state)
    estimator.fit(X_train, y_train)

    y_pred = estimator.predict(X_test)
    label_classes = sorted(set(y_train) | set(y_test))
    metrics = _per_class_metrics(y_test, list(y_pred), label_classes)

    artifact_dir = _artifact_dir()
    artifact_dir.mkdir(parents=True, exist_ok=True)
    artifact_path = artifact_dir / "model.joblib"

    import joblib

    joblib.dump(estimator, artifact_path)
    artifact_sha256 = _sha256_file(artifact_path)
    trained_at = datetime.now(timezone.utc).isoformat()

    metadata = {
        "runId": None,
        "artifactPath": str(artifact_path),
        "artifactSha256": artifact_sha256,
        "trainedAt": trained_at,
        "modelFamily": model_family,
        "configVersion": str(config["version"]),
        "metrics": metrics,
        "labelClasses": label_classes,
    }
    with open(artifact_dir / "metadata.json", "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    return FittedModel(
        estimator=estimator,
        artifact_path=str(artifact_path),
        artifact_sha256=artifact_sha256,
        trained_at=trained_at,
        model_family=model_family,
        config_version=str(config["version"]),
        metrics=metrics,
        label_classes=label_classes,
    )


def _per_class_metrics(y_true: list[str], y_pred: list[str], labels: list[str]) -> dict[str, Any]:
    per_class: dict[str, Any] = {}
    for label in labels:
        tp = sum(1 for t, p in zip(y_true, y_pred) if t == label and p == label)
        fp = sum(1 for t, p in zip(y_true, y_pred) if t != label and p == label)
        fn = sum(1 for t, p in zip(y_true, y_pred) if t == label and p != label)
        support = sum(1 for t in y_true if t == label)
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        per_class[label] = {"precision": precision, "recall": recall, "support": support}
    overall_accuracy = sum(1 for t, p in zip(y_true, y_pred) if t == p) / len(y_true) if y_true else 0.0
    return {"perClass": per_class, "overallAccuracy": overall_accuracy}


def stamp_run_id(run_id: int, *, artifact_dir: Optional[Path] = None) -> None:
    """Rewrites metadata.json's "runId" once server/scripts/recordBootstrapRun.js
    has inserted the training_runs row and returned its id (§15.1/D56) —
    see module docstring for why this two-step handoff exists."""
    directory = artifact_dir or _artifact_dir()
    metadata_path = directory / "metadata.json"
    with open(metadata_path, "r", encoding="utf-8") as f:
        metadata = json.load(f)
    metadata["runId"] = run_id
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)


def _main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    fit_parser = subparsers.add_parser("fit", help="fit the bootstrap model from a CSV")
    fit_parser.add_argument("train_csv_path")

    stamp_parser = subparsers.add_parser("stamp-run-id", help="record the training_runs.id assigned by Node")
    stamp_parser.add_argument("run_id", type=int)

    args = parser.parse_args()

    if args.command == "fit":
        fitted = fit_model(args.train_csv_path)
        print(json.dumps({
            "artifactPath": fitted.artifact_path,
            "artifactSha256": fitted.artifact_sha256,
            "trainedAt": fitted.trained_at,
            "modelFamily": fitted.model_family,
            "configVersion": fitted.config_version,
            "metrics": fitted.metrics,
            "labelClasses": fitted.label_classes,
        }))
    elif args.command == "stamp-run-id":
        stamp_run_id(args.run_id)


if __name__ == "__main__":
    _main()
