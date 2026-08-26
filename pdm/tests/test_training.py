"""Unit test for pdm/app/training.py::fit_model (§15.1/D51) — fits against a
real stratified sample of data/train.csv (pdm/tests/fixtures/train_fixture.csv),
asserts the artifact + metadata land on disk, labels are neutral "CLASS_0"/
"CLASS_1" strings (never "NORMAL"/"FAULT" — polarity is unresolved, plan §5),
and stamp_run_id() rewrites metadata.json's runId.

Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
migration.md Phase 9. The fixture CSV used to be fabricated pump-shaped data;
it is now a real 200-row stratified sample of the actual committed
data/train.csv (100 rows per Engine_Condition class), generated deterministically
with random_state=20260826. test_fixture_columns_match_real_train_csv guards
against the two ever drifting apart again the way the pump-domain fixture did.
"""

import json
from pathlib import Path

import pandas as pd

from app.training import fit_model, load_training_config, stamp_run_id

FIXTURE_CSV = Path(__file__).parent / "fixtures" / "train_fixture.csv"
REAL_TRAIN_CSV = Path(__file__).parent.parent.parent / "data" / "train.csv"


def test_fixture_columns_match_real_train_csv():
    """The fixture must never drift from the real file's column names again --
    this is exactly the bug that made data/train.csv orphaned pre-migration
    (plan §1)."""
    fixture_cols = list(pd.read_csv(FIXTURE_CSV, nrows=0).columns)
    real_cols = list(pd.read_csv(REAL_TRAIN_CSV, nrows=0).columns)
    assert fixture_cols == real_cols


def test_fit_model_writes_artifact_and_metadata(tmp_path, monkeypatch):
    monkeypatch.setenv("PDM_ARTIFACT_DIR", str(tmp_path))

    config = load_training_config()
    fitted = fit_model(str(FIXTURE_CSV), config=config)

    assert (tmp_path / "model.joblib").exists()
    metadata_path = tmp_path / "metadata.json"
    assert metadata_path.exists()

    with open(metadata_path, "r", encoding="utf-8") as f:
        metadata = json.load(f)

    assert metadata["runId"] is None
    assert metadata["artifactSha256"] == fitted.artifact_sha256
    assert set(fitted.label_classes) <= {"CLASS_0", "CLASS_1"}
    # Neither a bare 0/1 nor the old NORMAL/FAULT framing may appear as a
    # label (plan §5 — polarity is unresolved, exposed neutrally).
    assert "0" not in fitted.label_classes
    assert "1" not in fitted.label_classes
    assert "NORMAL" not in fitted.label_classes
    assert "FAULT" not in fitted.label_classes


def test_stamp_run_id_rewrites_metadata(tmp_path, monkeypatch):
    monkeypatch.setenv("PDM_ARTIFACT_DIR", str(tmp_path))
    fit_model(str(FIXTURE_CSV))

    stamp_run_id(42, artifact_dir=tmp_path)

    with open(tmp_path / "metadata.json", "r", encoding="utf-8") as f:
        metadata = json.load(f)
    assert metadata["runId"] == 42


def test_fit_model_writes_to_explicit_artifact_dir_not_env(tmp_path, monkeypatch):
    env_dir = tmp_path / "env_dir"
    explicit_dir = tmp_path / "explicit_dir"
    monkeypatch.setenv("PDM_ARTIFACT_DIR", str(env_dir))

    fitted = fit_model(str(FIXTURE_CSV), artifact_dir=explicit_dir)

    assert (explicit_dir / "model.joblib").exists()
    assert (explicit_dir / "metadata.json").exists()
    assert not env_dir.exists()
    assert fitted.artifact_path == str(explicit_dir / "model.joblib")
