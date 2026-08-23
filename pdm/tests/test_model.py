"""Tests for pdm/app/model.py's reset()/reload() — the hot-swap mechanism
the /training/deploy and /training/reset endpoints (Task 4) rely on to
change the live artifact without a container restart."""

from pathlib import Path

from app import model, training

FIXTURE_CSV = Path(__file__).parent / "fixtures" / "train_fixture.csv"


def test_reset_clears_artifact_files_and_module_state(tmp_path, monkeypatch):
    monkeypatch.setenv("PDM_ARTIFACT_DIR", str(tmp_path))
    training.fit_model(str(FIXTURE_CSV))
    # _load_artifact() (existing, unchanged) refuses to load a metadata.json
    # with runId still null, per its own by-design guard — stamp it first,
    # mirroring the real bootstrap handoff (fit_model -> Node records the
    # training_runs row -> stamp_run_id -> only then is the artifact loadable).
    training.stamp_run_id(1, artifact_dir=tmp_path)
    model.reload()
    assert model._artifact is not None

    model.reset()

    assert not (tmp_path / "model.joblib").exists()
    assert not (tmp_path / "metadata.json").exists()
    assert model._artifact is None
    assert model.score({"rpmMean": 1800, "suctionPressureMean": 4.5, "dischargePressureMean": 5.2,
                         "flowRateMean": 90, "motorTempMean": 70, "vibrationMean": 2.0}) is None


def test_reload_picks_up_a_newly_written_artifact(tmp_path, monkeypatch):
    monkeypatch.setenv("PDM_ARTIFACT_DIR", str(tmp_path))
    model.reset()  # start from "no artifact", regardless of any prior test's leftover env
    assert model._artifact is None

    training.fit_model(str(FIXTURE_CSV))
    # See comment in test_reset_clears_artifact_files_and_module_state above:
    # _load_artifact() requires a non-null runId, so stamp one before reload().
    training.stamp_run_id(1, artifact_dir=tmp_path)
    model.reload()

    assert model._artifact is not None


def test_reset_is_idempotent_on_an_already_empty_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("PDM_ARTIFACT_DIR", str(tmp_path))
    model.reset()
    model.reset()  # must not raise
    assert model._artifact is None
