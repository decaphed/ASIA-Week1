"""Unit test for pdm/app/training.py::fit_model (§15.1/D51) — fits against a
small fixture CSV (pdm/tests/fixtures/train_fixture.csv), asserts the
artifact + metadata land on disk, labels are "NORMAL"/"FAULT" strings (never
bare 0/1, §15.1/D56), and stamp_run_id() rewrites metadata.json's runId.
"""

import json
from pathlib import Path

from app.training import fit_model, load_training_config, stamp_run_id

FIXTURE_CSV = Path(__file__).parent / "fixtures" / "train_fixture.csv"


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
    assert set(fitted.label_classes) <= {"NORMAL", "FAULT"}
    # Bare 0/1 must never appear as a label (§15.1/D56).
    assert "0" not in fitted.label_classes
    assert "1" not in fitted.label_classes


def test_stamp_run_id_rewrites_metadata(tmp_path, monkeypatch):
    monkeypatch.setenv("PDM_ARTIFACT_DIR", str(tmp_path))
    fit_model(str(FIXTURE_CSV))

    stamp_run_id(42, artifact_dir=tmp_path)

    with open(tmp_path / "metadata.json", "r", encoding="utf-8") as f:
        metadata = json.load(f)
    assert metadata["runId"] == 42
