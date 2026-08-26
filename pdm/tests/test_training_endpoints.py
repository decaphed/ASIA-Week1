"""End-to-end tests for the /training/* HTTP endpoints (Task 4) — the
FE-facing upload -> quality-check -> fit -> compare -> deploy loop.

Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
migration.md Phase 9.
"""

import io
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app import model
from app.main import app

FIXTURE_CSV = Path(__file__).parent / "fixtures" / "train_fixture.csv"


@pytest.fixture(autouse=True)
def isolated_artifact_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("PDM_ARTIFACT_DIR", str(tmp_path))
    model.reset()
    yield
    model.reset()


def _good_csv_bytes():
    # NOTE: values are jittered per-row (not constant) so every row is
    # distinct — training_quality.assess() scores duplicate-row rate as
    # part of its composite quality score, and 300 literally-identical
    # rows (as an earlier draft of this fixture had) drives duplicateRate
    # to ~0.99, which alone is enough to push qualityScore below
    # PASS_THRESHOLD (verified directly against training_quality.assess()
    # while writing this test) and REJECT what's meant to be the "good CSV"
    # happy-path fixture.
    n = 300
    df = pd.DataFrame({
        # Engine_RPM alone is strictly increasing across all n rows, which
        # guarantees every full row is unique (duplicateRate == 0)
        # regardless of how the other, smaller-range columns happen to
        # cycle.
        "Engine_RPM": [800.0 + i * 0.5 for i in range(n)],
        "Lub_Oil_Pressure": [4.0 + (i % 40) * 0.01 for i in range(n)],
        "Fuel_Pressure": [8.0 + (i % 40) * 0.01 for i in range(n)],
        "Coolant_Pressure": [3.0 + (i % 40) * 0.01 for i in range(n)],
        "Lub_Oil_Temperature": [78.0 + (i % 100) * 0.1 for i in range(n)],
        "Coolant_Temperature": [76.0 + (i % 100) * 0.1 for i in range(n)],
        "Engine_Condition": [0, 1] * (n // 2),
    })
    buf = io.BytesIO()
    df.to_csv(buf, index=False)
    return buf.getvalue()


def _score_payload():
    return {
        "windowEnd": "2026-08-23T00:00:00Z", "dominantStatus": "RUNNING", "precapFeaturesByMetric": {},
        "engineRpmMin": 700, "engineRpmMax": 900, "lubOilPressureMin": 3.5, "lubOilPressureMax": 4.5,
        "fuelPressureMin": 7.5, "fuelPressureMax": 8.5, "coolantPressureMin": 2.5, "coolantPressureMax": 3.5,
        "lubOilTemperatureMin": 75, "lubOilTemperatureMax": 85, "coolantTemperatureMin": 73, "coolantTemperatureMax": 83,
        "engineRpmMean": 800, "lubOilPressureMean": 4.0, "fuelPressureMean": 8.0, "coolantPressureMean": 3.0,
        "lubOilTemperatureMean": 80, "coolantTemperatureMean": 78,
    }


def test_upload_rejects_bad_quality_csv():
    client = TestClient(app)
    bad_csv = b"Engine_RPM,Lub_Oil_Pressure\n1,2\n"
    res = client.post("/training/upload", files={"file": ("bad.csv", bad_csv, "text/csv")})
    assert res.status_code == 422
    body = res.json()["detail"]
    assert body["verdict"] == "REJECTED"
    assert body["reasons"]


def test_upload_fit_deploy_happy_path():
    client = TestClient(app)

    upload_res = client.post("/training/upload", files={"file": ("good.csv", _good_csv_bytes(), "text/csv")})
    assert upload_res.status_code == 201
    upload_body = upload_res.json()
    assert upload_body["verdict"] == "PASS"
    upload_id = upload_body["uploadId"]

    fit_res = client.post(f"/training/{upload_id}/fit")
    assert fit_res.status_code == 200
    fit_body = fit_res.json()
    assert fit_body["candidateMetrics"]["overallAccuracy"] is not None
    assert fit_body["deployedMetrics"] is None  # nothing deployed yet (isolated_artifact_dir starts empty)

    deploy_res = client.post(f"/training/{upload_id}/deploy")
    assert deploy_res.status_code == 200
    deploy_body = deploy_res.json()
    assert deploy_body["artifactSha256"]

    # Design-review fix: fit_model() always writes runId: null, and
    # model._load_artifact() refuses to load a null-runId artifact — /deploy
    # alone leaves Tier 2 inactive. Node's real deployCandidate() (Task 5)
    # calls this immediately after inserting the training_runs row; here we
    # simulate that with a synthetic id.
    stamp_res = client.post("/training/stamp-run-id", json={"runId": 1})
    assert stamp_res.status_code == 200

    score_res = client.post("/score", json=_score_payload())
    assert score_res.status_code == 200
    assert score_res.json()["tier2Label"] is not None  # Tier 2 is live post-deploy


def test_discard_removes_candidate_without_touching_live_artifact():
    client = TestClient(app)
    upload_id = client.post("/training/upload", files={"file": ("good.csv", _good_csv_bytes(), "text/csv")}).json()["uploadId"]
    client.post(f"/training/{upload_id}/fit")

    delete_res = client.delete(f"/training/{upload_id}")
    assert delete_res.status_code == 200

    fit_again_res = client.post(f"/training/{upload_id}/fit")
    assert fit_again_res.status_code == 404


def test_reset_clears_live_artifact_and_score_has_no_tier2_fields():
    client = TestClient(app)
    upload_id = client.post("/training/upload", files={"file": ("good.csv", _good_csv_bytes(), "text/csv")}).json()["uploadId"]
    client.post(f"/training/{upload_id}/fit")
    client.post(f"/training/{upload_id}/deploy")

    reset_res = client.post("/training/reset")
    assert reset_res.status_code == 200

    score_res = client.post("/score", json=_score_payload())
    assert score_res.json()["tier2Label"] is None


def test_deploy_of_unknown_upload_id_returns_404():
    client = TestClient(app)
    res = client.post("/training/does-not-exist/deploy")
    assert res.status_code == 404
