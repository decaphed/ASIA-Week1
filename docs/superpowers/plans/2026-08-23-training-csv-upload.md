# Training CSV Upload & Model Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone upload a training CSV through the FE, gate it with a quality check + preprocessing, fit a candidate Tier 2 model from it, compare the candidate against whatever's currently deployed, and only deploy on explicit operator confirmation — plus wipe the current live model (start over) and stop the Needs Review tab from scrolling forever.

**Architecture:** Three layers, HTTP end to end (pdm is a separate, unexposed container — Node already talks to it only over `PDM_SERVICE_URL`). New FastAPI endpoints in `pdm/app/main.py` own the quality gate, candidate fit, and artifact swap; a thin Node proxy layer (`trainingController.js`/`trainingService.js`) forwards requests and persists the `training_runs` row on deploy (Python still never writes Postgres); a new FE page drives the upload → compare → deploy flow. The Needs Review collapse is a self-contained FE change with no backend dependency.

**Tech Stack:** FastAPI + Pydantic + pandas + scikit-learn (pdm), Express + multer + `fetch` (server), React (client). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-23-training-csv-upload-design.md`

## Global Constraints

- No auth/group gate on the new training routes (Node keeps `requireTrustedProxy`, deliberately skips `requireGroup`) — matches the spec's "anyone" requirement.
- Quality gate PASS threshold: score `>= 70` (same banding convention as `preprocessing/quality.py`).
- `MIN_ROWS = 200`, `MIN_MINORITY_SHARE = 0.05` (spec §2 defaults).
- A candidate artifact never touches the live `PDM_ARTIFACT_DIR` until `/deploy` is called; `/deploy` is only reachable after a successful `/fit`.
- Reuse existing patterns exactly: `server/middleware/uploadFile.js` for multer, the `httpError(status, message)` helper style from `externalUploadService.js`, the `fetch` + `AbortSignal.timeout` pattern from `pdmService.js`.

---

### Task 1: Needs Review tab — "Show more / Show less" collapse

**Files:**
- Modify: `client/src/pages/PredictionsPage.jsx:553-695` (`ReviewTab`)

**Interfaces:**
- Consumes: nothing new — `sorted` (already computed in `ReviewTab`) and its existing `.map`/render block.
- Produces: nothing consumed by other tasks — fully self-contained.

- [ ] **Step 1: Add `visibleCount` state and slice the rendered rows**

In `client/src/pages/PredictionsPage.jsx`, inside `ReviewTab` (starts at line 553), add a `visibleCount` state right after the existing `filters` state (line 555):

```jsx
  const [visibleCount, setVisibleCount] = useState(10);
```

Immediately after the `sorted` computation (after line 560, `});`), reset the count whenever the filtered set's identity changes so switching filters doesn't leave a stale expanded count:

```jsx
  const sortedKey = sorted.map((q) => q.id).join(',');
  const prevSortedKey = useRef(sortedKey);
  if (prevSortedKey.current !== sortedKey) {
    prevSortedKey.current = sortedKey;
    setVisibleCount(10);
  }
```

Add `useRef` to the existing React import at the top of the file (line 1 currently reads `import { memo, useCallback, useMemo, useState } from 'react';` — that's `PredictionsPage.jsx`'s own top-of-file import, shared by every component in the file including `ReviewTab`):

```jsx
import { memo, useCallback, useMemo, useRef, useState } from 'react';
```

Replace the row-rendering line (`{sorted.map((q) => {`, line 633) with a sliced version:

```jsx
      {sorted.slice(0, visibleCount).map((q) => {
```

**Step 1 note on the reset-during-render pattern:** setting state directly in the render body (the `if (prevSortedKey.current !== sortedKey)` block above) is a deliberate, documented React pattern for "adjust state when a prop/computed value changes" — it re-renders immediately without a `useEffect` round-trip, and is safe because it's guarded by the ref comparison so it only fires once per actual change, not on every render.

- [ ] **Step 2: Add the Show more / Show less controls**

After the closing of the `.map()` block (currently `})}` at line 682, right before the `{queue.length === 0 && (...)}` block at line 683), add:

```jsx
      {sorted.length > visibleCount && (
        <div style={{ textAlign: 'center', padding: '14px 0 4px' }}>
          <button
            type="button"
            className="hover-ghost"
            onClick={() => setVisibleCount((n) => Math.min(n + 10, sorted.length))}
            style={{ ...buttonReset, color: '#1F3A6E', borderRadius: 6, padding: '6px 14px', fontSize: 12.5, fontWeight: 600 }}
          >
            Show {Math.min(10, sorted.length - visibleCount)} more ({sorted.length - visibleCount} remaining)
          </button>
        </div>
      )}
      {visibleCount > 10 && sorted.length > 10 && (
        <div style={{ textAlign: 'center', padding: '4px 0 4px' }}>
          <button
            type="button"
            className="hover-ghost"
            onClick={() => setVisibleCount(10)}
            style={{ ...buttonReset, color: '#8a99a8', borderRadius: 6, padding: '6px 14px', fontSize: 12.5, fontWeight: 600 }}
          >
            Show less
          </button>
        </div>
      )}
```

`buttonReset` is already imported at the top of `PredictionsPage.jsx` (line 2: `import Card, { CardLabel, buttonReset } from '../components/Card.jsx';`).

- [ ] **Step 3: Manual verification**

Run the client dev server (`cd client && npm run dev`, or whatever the project's existing dev-run skill/script is), open the Predictions page's Needs Review tab. With fewer than 10 pending events, confirm no controls appear. If fewer than 10 exist in the current data, temporarily lower the `useState(10)` seed to `useState(2)` in your local checkout only to verify the button appears and expands/collapses correctly, then revert to `10` before committing.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/PredictionsPage.jsx
git commit -m "client: collapse the Needs Review queue behind Show more/less"
```

---

### Task 2: PDM training-CSV quality gate

**Files:**
- Create: `pdm/app/training_quality.py`
- Test: `pdm/tests/test_training_quality.py`
- Test fixtures: reuse `pdm/tests/fixtures/train_fixture.csv` (already exists, used by `test_training.py`) for the passing case; new fixtures added inline in the test file (small in-memory DataFrames, not new CSV files, per Step 1 below) for each rejection case.

**Interfaces:**
- Consumes: `pdm/app/training.py::TRAIN_CSV_COLUMN_MAP`, `TRAIN_CSV_LABEL_COLUMN` (already defined, lines 41-49); `pdm/app/physics.py::load_ranges()` (already defined, returns `dict[str, dict[str, Any]]` keyed by metric name with `min`/`max`, per `pump-physics.yaml`'s `metrics` section).
- Produces: `training_quality.assess(df: pandas.DataFrame) -> dict[str, Any]` — the shape `{"verdict": "PASS" | "REJECTED", "qualityScore": float, "rowCount": int, "reasons": list[str], "missingRate": float, "duplicateRate": float, "outOfRangeRate": float, "minorityShare": float}`. Task 4's FastAPI endpoint calls this directly. `training_quality.MIN_ROWS`, `training_quality.MIN_MINORITY_SHARE`, `training_quality.PASS_THRESHOLD` — module-level constants Task 4 may reference in its response/error messages.

- [ ] **Step 1: Write the failing tests**

Create `pdm/tests/test_training_quality.py`:

```python
"""Tests for pdm/app/training_quality.py's CSV quality gate — the
tabular-CSV counterpart to preprocessing/quality.py's per-window gate."""

import pandas as pd
import pytest

from app.training_quality import MIN_MINORITY_SHARE, MIN_ROWS, assess


def _good_df(n=300):
    # Alternating labels keeps the minority share well above MIN_MINORITY_SHARE
    # and every row inside pump-physics.yaml's normal ranges.
    return pd.DataFrame({
        "Engine_rpm": [1800.0] * n,
        "suctionPressure": [4.5] * n,
        "dischargePressure": [5.2] * n,
        "flowRate": [90.0] * n,
        "motorTemp": [70.0] * n,
        "vibration": [2.0] * n,
        "Engine_Condition": [0, 1] * (n // 2),
    })


def test_good_csv_passes():
    result = assess(_good_df())
    assert result["verdict"] == "PASS"
    assert result["qualityScore"] >= 70
    assert result["reasons"] == []


def test_missing_required_column_is_hard_rejected():
    df = _good_df().drop(columns=["vibration"])
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert any("vibration" in r for r in result["reasons"])


def test_too_few_rows_is_hard_rejected():
    df = _good_df(n=MIN_ROWS - 10)
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert any("row" in r.lower() for r in result["reasons"])


def test_high_missing_rate_drags_score_below_pass():
    df = _good_df(n=400)
    df.loc[: int(len(df) * 0.6), "vibration"] = None
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert result["missingRate"] > 0


def test_high_duplicate_rate_drags_score_below_pass():
    base = _good_df(n=50)
    df = pd.concat([base] * 8, ignore_index=True)  # 400 rows, almost all duplicates
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert result["duplicateRate"] > 0.5


def test_out_of_range_values_drag_score_below_pass():
    df = _good_df(n=300)
    df.loc[: int(len(df) * 0.5), "motorTemp"] = 9999.0  # far outside pump-physics.yaml's range
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert result["outOfRangeRate"] > 0


def test_imbalanced_labels_hard_rejected():
    n = 300
    df = _good_df(n=n)
    df["Engine_Condition"] = [0] * (n - 2) + [1, 1]  # minority share well under MIN_MINORITY_SHARE
    result = assess(df)
    assert result["verdict"] == "REJECTED"
    assert result["minorityShare"] < MIN_MINORITY_SHARE
    assert any("minority" in r.lower() or "imbalance" in r.lower() or "class" in r.lower() for r in result["reasons"])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd pdm && python -m pytest tests/test_training_quality.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.training_quality'`

- [ ] **Step 3: Write `pdm/app/training_quality.py`**

```python
"""training_quality.py — quality gate for an uploaded training CSV
(§15.7's start-over/upload flow), mirroring preprocessing/quality.py's
"weighted score, hardcoded reasons" shape but for a tabular training CSV
rather than a sensor window.

Two kinds of check:
  - structural (hard fail, no score computed): missing required columns,
    too few rows, or too few minority-class rows to stratify meaningfully.
  - scored (weighted into a 0-100 composite, PASS at >= PASS_THRESHOLD):
    missing-value rate, duplicate-row rate, out-of-range rate.

Deliberately independent of preprocessing/quality.py: that module scores a
completed AUDIT window of live sensor samples (imputation/physics-violation
provenance per sample); this module scores a flat, unprocessed training CSV
with none of that structure. Sharing the RANGES source (physics.py) is
sufficient reuse without forcing a shape neither one actually has.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from .physics import load_ranges
from .training import TRAIN_CSV_COLUMN_MAP, TRAIN_CSV_LABEL_COLUMN

MIN_ROWS = 200
MIN_MINORITY_SHARE = 0.05
PASS_THRESHOLD = 70

REQUIRED_COLUMNS = list(TRAIN_CSV_COLUMN_MAP) + [TRAIN_CSV_LABEL_COLUMN]


def _round2(value: float) -> float:
    return round(value, 2)


def assess(df: pd.DataFrame) -> dict[str, Any]:
    """@param df the raw uploaded CSV, parsed but not yet preprocessed —
    train.csv's own column names (Engine_rpm, Engine_Condition, ...), same
    as training.fit_model's input.
    @returns a report dict; see this module's docstring for the two-tier
    structural/scored check split. verdict is REJECTED if EITHER any
    structural check fails OR the composite qualityScore < PASS_THRESHOLD.
    """
    reasons: list[str] = []

    missing_columns = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing_columns:
        reasons.append(f"missing required column(s): {', '.join(missing_columns)}")
        return {
            "verdict": "REJECTED", "qualityScore": 0.0, "rowCount": len(df), "reasons": reasons,
            "missingRate": None, "duplicateRate": None, "outOfRangeRate": None, "minorityShare": None,
        }

    row_count = len(df)
    structural_reasons: list[str] = []
    if row_count < MIN_ROWS:
        structural_reasons.append(f"only {row_count} row(s) — at least {MIN_ROWS} are required for a meaningful stratified split")

    label_counts = df[TRAIN_CSV_LABEL_COLUMN].value_counts(dropna=True)
    minority_share = float(label_counts.min() / label_counts.sum()) if len(label_counts) >= 1 and label_counts.sum() > 0 else 0.0
    if len(label_counts) < 2 or minority_share < MIN_MINORITY_SHARE:
        structural_reasons.append(
            f"label class imbalance: minority class share {_round2(minority_share)} is below the "
            f"{MIN_MINORITY_SHARE} minimum needed for a stratified split"
        )

    if structural_reasons:
        # Too few rows, or too imbalanced to stratify — no meaningful score
        # to compute, reject outright.
        return {
            "verdict": "REJECTED", "qualityScore": 0.0, "rowCount": row_count, "reasons": structural_reasons,
            "missingRate": None, "duplicateRate": None, "outOfRangeRate": None, "minorityShare": _round2(minority_share),
        }

    feature_columns = list(TRAIN_CSV_COLUMN_MAP)
    missing_count = int(df[feature_columns + [TRAIN_CSV_LABEL_COLUMN]].isna().any(axis=1).sum())
    missing_rate = missing_count / row_count if row_count else 0.0

    duplicate_count = int(df.duplicated().sum())
    duplicate_rate = duplicate_count / row_count if row_count else 0.0

    ranges = load_ranges()
    out_of_range_count = 0
    total_checked = 0
    for csv_column, metric_name in TRAIN_CSV_COLUMN_MAP.items():
        bounds = ranges.get(metric_name)
        if bounds is None or csv_column not in df.columns:
            continue
        values = df[csv_column].dropna()
        total_checked += len(values)
        out_of_range_count += int(((values < bounds["min"]) | (values > bounds["max"])).sum())
    out_of_range_rate = out_of_range_count / total_checked if total_checked else 0.0

    quality_score = _round2(
        100
        * (
            0.4 * (1 - missing_rate)
            + 0.3 * (1 - duplicate_rate)
            + 0.3 * (1 - out_of_range_rate)
        )
    )

    reasons = []
    if missing_rate > 0:
        reasons.append(f"missing-value rate {_round2(missing_rate)} across required columns")
    if duplicate_rate > 0:
        reasons.append(f"duplicate-row rate {_round2(duplicate_rate)}")
    if out_of_range_rate > 0:
        reasons.append(f"out-of-range value rate {_round2(out_of_range_rate)} against pump-physics.yaml bounds")

    verdict = "PASS" if quality_score >= PASS_THRESHOLD else "REJECTED"
    if verdict == "REJECTED" and not reasons:
        reasons.append(f"composite quality score {quality_score} is below the {PASS_THRESHOLD} threshold")

    return {
        "verdict": verdict,
        "qualityScore": quality_score,
        "rowCount": row_count,
        "reasons": reasons if verdict == "REJECTED" else [],
        "missingRate": _round2(missing_rate),
        "duplicateRate": _round2(duplicate_rate),
        "outOfRangeRate": _round2(out_of_range_rate),
        "minorityShare": _round2(minority_share),
    }


def clean(df: pd.DataFrame) -> pd.DataFrame:
    """Preprocessing applied to a CSV that already PASSED assess(): drops
    the same rows the quality report already counted against it — rows
    missing a required value, and exact duplicate rows — so the cleaned
    CSV training.fit_model reads next reflects exactly what was scored."""
    feature_columns = list(TRAIN_CSV_COLUMN_MAP)
    cleaned = df.dropna(subset=feature_columns + [TRAIN_CSV_LABEL_COLUMN])
    cleaned = cleaned.drop_duplicates()
    return cleaned.reset_index(drop=True)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd pdm && python -m pytest tests/test_training_quality.py -v`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Commit**

```bash
git add pdm/app/training_quality.py pdm/tests/test_training_quality.py
git commit -m "pdm: add training-CSV quality gate (training_quality.py)"
```

---

### Task 3: `training.fit_model` candidate-dir support + `model.py` reset/reload

**Files:**
- Modify: `pdm/app/training.py:107-184` (`fit_model`)
- Modify: `pdm/app/model.py` (add `reset()` and `reload()`)
- Test: `pdm/tests/test_training.py` (extend)
- Test: `pdm/tests/test_model.py` (create — no existing test file for `model.py`; run `find pdm/tests -iname 'test_model*'` before creating, in case one now exists)

**Interfaces:**
- Consumes: `pdm/app/training.py::_artifact_dir()` (existing, line 52-53, unchanged), `pdm/app/training_quality.clean()` (Task 2, used by Task 4 not here).
- Produces: `training.fit_model(train_csv_path: str, *, config: Optional[dict] = None, artifact_dir: Optional[Path] = None) -> FittedModel` — new optional `artifact_dir` param, `None` preserves today's `_artifact_dir()`-from-env behavior exactly (every existing call site is unaffected). `model.reset() -> None` — deletes the live artifact files and clears the loaded model. `model.reload() -> None` — re-runs `_load_artifact()` and reassigns the module-level `_artifact`; used after a deploy swaps the files in place.

- [ ] **Step 1: Write the failing tests**

Add to `pdm/tests/test_training.py` (after the existing two tests):

```python
def test_fit_model_writes_to_explicit_artifact_dir_not_env(tmp_path, monkeypatch):
    env_dir = tmp_path / "env_dir"
    explicit_dir = tmp_path / "explicit_dir"
    monkeypatch.setenv("PDM_ARTIFACT_DIR", str(env_dir))

    fitted = fit_model(str(FIXTURE_CSV), artifact_dir=explicit_dir)

    assert (explicit_dir / "model.joblib").exists()
    assert (explicit_dir / "metadata.json").exists()
    assert not env_dir.exists()
    assert fitted.artifact_path == str(explicit_dir / "model.joblib")
```

Create `pdm/tests/test_model.py`:

```python
"""Tests for pdm/app/model.py's reset()/reload() — the hot-swap mechanism
the /training/deploy and /training/reset endpoints (Task 4) rely on to
change the live artifact without a container restart."""

from pathlib import Path

from app import model, training

FIXTURE_CSV = Path(__file__).parent / "fixtures" / "train_fixture.csv"


def test_reset_clears_artifact_files_and_module_state(tmp_path, monkeypatch):
    monkeypatch.setenv("PDM_ARTIFACT_DIR", str(tmp_path))
    training.fit_model(str(FIXTURE_CSV))
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
    model.reload()

    assert model._artifact is not None


def test_reset_is_idempotent_on_an_already_empty_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("PDM_ARTIFACT_DIR", str(tmp_path))
    model.reset()
    model.reset()  # must not raise
    assert model._artifact is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd pdm && python -m pytest tests/test_training.py::test_fit_model_writes_to_explicit_artifact_dir_not_env tests/test_model.py -v`
Expected: FAIL — `fit_model()` raises `TypeError: fit_model() got an unexpected keyword argument 'artifact_dir'`, and `test_model.py` fails with `AttributeError: module 'app.model' has no attribute 'reset'`.

- [ ] **Step 3: Modify `training.fit_model`**

In `pdm/app/training.py`, change the signature at line 107 from:

```python
def fit_model(train_csv_path: str, *, config: Optional[dict[str, Any]] = None) -> FittedModel:
```

to:

```python
def fit_model(
    train_csv_path: str, *, config: Optional[dict[str, Any]] = None, artifact_dir: Optional[Path] = None,
) -> FittedModel:
```

And change line 152 from:

```python
    artifact_dir = _artifact_dir()
```

to:

```python
    artifact_dir = artifact_dir or _artifact_dir()
```

(Everything else in `fit_model` — lines 108-184 — is unchanged; it already only ever uses the local `artifact_dir` name from that point on.)

- [ ] **Step 4: Add `reset()` and `reload()` to `model.py`**

In `pdm/app/model.py`, the file already defines `_load_artifact()` (lines 46-88) and `_artifact = _load_artifact()` (line 91). Add, immediately after line 91 (`_artifact = _load_artifact()`):

```python


def reload() -> None:
    """Re-runs _load_artifact() and swaps it into the module-level
    _artifact in place — how /training/deploy (Task 4) makes a newly
    written artifact live without a container restart."""
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd pdm && python -m pytest tests/test_training.py tests/test_model.py -v`
Expected: PASS (all tests in both files)

- [ ] **Step 6: Run the full existing pdm test suite to check for regressions**

Run: `cd pdm && python -m pytest -v`
Expected: PASS (no existing test relies on `fit_model`'s old positional-only signature, since `artifact_dir` is a new keyword-only param with a backward-compatible default)

- [ ] **Step 7: Commit**

```bash
git add pdm/app/training.py pdm/app/model.py pdm/tests/test_training.py pdm/tests/test_model.py
git commit -m "pdm: candidate-dir fit_model() + model.py reset()/reload() for the deploy hot-swap"
```

---

### Task 4: PDM training endpoints (upload / fit / deploy / discard / reset)

**Files:**
- Modify: `pdm/app/main.py`
- Modify: `pdm/app/schemas.py` (add response models)
- Test: `pdm/tests/test_training_endpoints.py`

**Interfaces:**
- Consumes: `training_quality.assess()`/`clean()` (Task 2), `training.fit_model(..., artifact_dir=...)` (Task 3), `model.reload()`/`model.reset()` (Task 3), `training.TRAIN_CSV_COLUMN_MAP` (existing).
- Produces: `POST /training/upload` → `{uploadId, verdict, qualityScore, reasons, rowCount}` (`201` on PASS, `422` on REJECTED). `POST /training/{uploadId}/fit` → `{uploadId, candidateMetrics, deployedMetrics}` (`deployedMetrics` is `null` if no live artifact). `POST /training/{uploadId}/deploy` → `{artifactSha256, trainedAt, metrics}`. `DELETE /training/{uploadId}` → `{deleted: true}`. `POST /training/reset` → `{reset: true}`. These four routes and their exact response shapes are what Task 5's Node proxy calls.

- [ ] **Step 1: Write the failing tests**

Create `pdm/tests/test_training_endpoints.py`:

```python
"""End-to-end tests for the /training/* HTTP endpoints (Task 4) — the
FE-facing upload -> quality-check -> fit -> compare -> deploy loop."""

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
    df = pd.DataFrame({
        "Engine_rpm": [1800.0] * 300,
        "suctionPressure": [4.5] * 300,
        "dischargePressure": [5.2] * 300,
        "flowRate": [90.0] * 300,
        "motorTemp": [70.0] * 300,
        "vibration": [2.0] * 300,
        "Engine_Condition": [0, 1] * 150,
    })
    buf = io.BytesIO()
    df.to_csv(buf, index=False)
    return buf.getvalue()


def test_upload_rejects_bad_quality_csv():
    client = TestClient(app)
    bad_csv = b"Engine_rpm,suctionPressure\n1,2\n"
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

    score_res = client.post("/score", json={
        "windowEnd": "2026-08-23T00:00:00Z", "dominantStatus": "RUNNING", "precapFeaturesByMetric": {},
        "flowRateMin": 80, "flowRateMax": 100, "rpmMin": 1700, "rpmMax": 1900,
        "vibrationMin": 1, "vibrationMax": 3, "suctionPressureMin": 4, "suctionPressureMax": 5,
        "dischargePressureMin": 5, "dischargePressureMax": 6, "motorTempMin": 65, "motorTempMax": 75,
        "flowRateMean": 90, "rpmMean": 1800, "vibrationMean": 2, "suctionPressureMean": 4.5,
        "dischargePressureMean": 5.2, "motorTempMean": 70,
    })
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

    score_res = client.post("/score", json={
        "windowEnd": "2026-08-23T00:00:00Z", "dominantStatus": "RUNNING", "precapFeaturesByMetric": {},
        "flowRateMin": 80, "flowRateMax": 100, "rpmMin": 1700, "rpmMax": 1900,
        "vibrationMin": 1, "vibrationMax": 3, "suctionPressureMin": 4, "suctionPressureMax": 5,
        "dischargePressureMin": 5, "dischargePressureMax": 6, "motorTempMin": 65, "motorTempMax": 75,
        "flowRateMean": 90, "rpmMean": 1800, "vibrationMean": 2, "suctionPressureMean": 4.5,
        "dischargePressureMean": 5.2, "motorTempMean": 70,
    })
    assert score_res.json()["tier2Label"] is None


def test_deploy_of_unknown_upload_id_returns_404():
    client = TestClient(app)
    res = client.post("/training/does-not-exist/deploy")
    assert res.status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd pdm && python -m pytest tests/test_training_endpoints.py -v`
Expected: FAIL with 404s from the FastAPI `TestClient` (routes don't exist yet)

- [ ] **Step 3: Add response schemas to `pdm/app/schemas.py`**

Append to the end of `pdm/app/schemas.py`:

```python


# ─────────────────────────────────────────────────────────────────────────
# POST /training/* (Task 4, §15.7) — response models for the upload ->
# quality-check -> fit -> compare -> deploy loop.
# ─────────────────────────────────────────────────────────────────────────


class TrainingUploadResponse(BaseModel):
    uploadId: str
    verdict: Literal["PASS", "REJECTED"]
    qualityScore: float
    rowCount: int
    reasons: list[str]


class PerClassMetric(BaseModel):
    precision: float
    recall: float
    support: int


class ModelMetrics(BaseModel):
    perClass: dict[str, PerClassMetric]
    overallAccuracy: float


class TrainingFitResponse(BaseModel):
    uploadId: str
    candidateMetrics: ModelMetrics
    deployedMetrics: Optional[ModelMetrics] = None


class TrainingDeployResponse(BaseModel):
    artifactSha256: str
    trainedAt: str
    metrics: ModelMetrics
```

- [ ] **Step 4: Add the endpoints to `pdm/app/main.py`**

Change the imports at the top of `pdm/app/main.py` from:

```python
from fastapi import FastAPI, HTTPException

from . import model, rules
from .preprocessing.pipeline import AllSamplesInvalidError, process_window
from .schemas import ProcessedRecordIn, ProcessWindowRequest, ProcessWindowResponse, ScoreResponse
```

to:

```python
import json
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
    TrainingDeployResponse, TrainingFitResponse, TrainingUploadResponse,
)
```

Append to the end of `pdm/app/main.py` (after the existing `process_window_endpoint` function):

```python


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


@app.post("/training/upload", response_model=TrainingUploadResponse)
async def upload_training_csv(file: UploadFile) -> dict:
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

    live_dir = training._artifact_dir()
    live_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(candidate_model, live_dir / "model.joblib")
    shutil.copy2(candidate_metadata, live_dir / "metadata.json")
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd pdm && python -m pytest tests/test_training_endpoints.py -v`
Expected: PASS (all 5 tests)

- [ ] **Step 6: Run the full pdm test suite to check for regressions**

Run: `cd pdm && python -m pytest -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add pdm/app/main.py pdm/app/schemas.py pdm/tests/test_training_endpoints.py
git commit -m "pdm: add /training/upload, /fit, /deploy, discard, and /reset endpoints"
```

---

### Task 5: Node proxy layer

**Files:**
- Create: `server/controllers/trainingController.js`
- Create: `server/services/trainingService.js`
- Modify: `server/routes/index.js`

**Interfaces:**
- Consumes: `server/middleware/uploadFile.js::uploadCsv` (existing, reused as-is), `server/models/trainingRunModel.js::insertRun()` (existing, called on deploy), pdm's `/training/*` endpoints (Task 4).
- Produces: `POST /api/pdm/training/upload`, `POST /api/pdm/training/:uploadId/fit`, `POST /api/pdm/training/:uploadId/deploy`, `DELETE /api/pdm/training/:uploadId`, `POST /api/pdm/training/reset`, `GET /api/pdm/training/runs` — Task 7's `api/client.js` calls these exact paths.

- [ ] **Step 1: Write `server/services/trainingService.js`**

```javascript
// ─────────────────────────────────────────────────────────────────────────
// trainingService.js — Node's HTTP proxy to pdm's /training/* endpoints
// (§15.7's upload -> quality-check -> fit -> compare -> deploy loop). Same
// "Node calls pdm over HTTP" pattern pdmService.js/externalUploadService.js
// already use for /score and /process-window.
//
// On a successful deploy, this module records the promoted run into
// training_runs — Python never writes Postgres (§3.4's invariant), so pdm
// only ever returns a JSON result and Node persists it, same handoff shape
// recordBootstrapRun.js uses for the CLI-piped bootstrap path.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, unlink } from 'node:fs/promises';

import * as trainingRunModel from '../models/trainingRunModel.js';
import { logger } from '../utils/logger.js';

const PDM_SERVICE_URL = process.env.PDM_SERVICE_URL || 'http://localhost:8000';
const UPLOAD_TIMEOUT_MS = 15000;
const FIT_TIMEOUT_MS = 60000;
const DEPLOY_TIMEOUT_MS = 15000;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function pdmJsonPost(path, timeoutMs) {
  let res;
  try {
    res = await fetch(`${PDM_SERVICE_URL}${path}`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw httpError(502, `pdm ${path} call failed: ${err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status, body?.detail ? JSON.stringify(body.detail) : `pdm ${path} responded ${res.status}`);
  return body;
}

/** @param tempFilePath a just-uploaded temp CSV (multer diskStorage, uploadFile.js). */
export async function uploadCsv(tempFilePath, originalFilename) {
  try {
    const fileBuffer = await readFile(tempFilePath);
    const form = new FormData();
    form.append('file', new Blob([fileBuffer]), originalFilename);

    let res;
    try {
      res = await fetch(`${PDM_SERVICE_URL}/training/upload`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (err) {
      throw httpError(502, `pdm /training/upload call failed: ${err.message}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(res.status, body?.detail ? JSON.stringify(body.detail) : `pdm /training/upload responded ${res.status}`);
    return body;
  } finally {
    try {
      await unlink(tempFilePath);
    } catch (err) {
      logger.error(`trainingService: failed to delete temp upload file ${tempFilePath}: ${err.message}`);
    }
  }
}

export function fitCandidate(uploadId) {
  return pdmJsonPost(`/training/${encodeURIComponent(uploadId)}/fit`, FIT_TIMEOUT_MS);
}

export async function deployCandidate(uploadId) {
  const result = await pdmJsonPost(`/training/${encodeURIComponent(uploadId)}/deploy`, DEPLOY_TIMEOUT_MS);

  await trainingRunModel.insertRun({
    corpusContentHash: `bootstrap:upload:${result.artifactSha256}`,
    corpusRowManifest: JSON.stringify({ source: 'upload', uploadId }),
    corpusRowCount: 0,
    trainedAt: result.trainedAt,
    metrics: JSON.stringify(result.metrics),
    artifactPath: null,
    promoted: true,
    promotionReason: 'operator-deployed candidate from an uploaded training CSV (§15.7)',
    championRunIdAtEval: null,
  });

  return result;
}

export async function discardCandidate(uploadId) {
  let res;
  try {
    res = await fetch(`${PDM_SERVICE_URL}/training/${encodeURIComponent(uploadId)}`, {
      method: 'DELETE', signal: AbortSignal.timeout(DEPLOY_TIMEOUT_MS),
    });
  } catch (err) {
    throw httpError(502, `pdm DELETE /training/${uploadId} call failed: ${err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status, `pdm DELETE /training/${uploadId} responded ${res.status}`);
  return body;
}

export function resetModel() {
  return pdmJsonPost('/training/reset', DEPLOY_TIMEOUT_MS);
}

export function listRuns() {
  return trainingRunModel.listRuns();
}
```

- [ ] **Step 2: Write `server/controllers/trainingController.js`**

```javascript
// ─────────────────────────────────────────────────────────────────────────
// trainingController.js — §15.7's /pdm/training/* HTTP endpoints. Calls
// trainingService only, never pdm/DB models directly (controller->service
// layering, matching pdmController.js/externalUploadController.js).
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/trainingService.js';

export async function uploadTrainingCsv(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'no file uploaded (expected multipart field "file")' });
    }
    const result = await service.uploadCsv(req.file.path, req.file.originalname);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    if (err.status === 422) {
      // The quality gate rejected the CSV — this is a well-formed "no" the
      // FE renders inline, not an unexpected failure to log-and-500.
      let detail;
      try {
        detail = JSON.parse(err.message);
      } catch {
        detail = { reasons: [err.message] };
      }
      return res.status(422).json({ success: false, error: 'quality gate rejected the upload', ...detail });
    }
    next(err);
  }
}

export async function fitTrainingCandidate(req, res, next) {
  try {
    const result = await service.fitCandidate(req.params.uploadId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function deployTrainingCandidate(req, res, next) {
  try {
    const result = await service.deployCandidate(req.params.uploadId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function discardTrainingCandidate(req, res, next) {
  try {
    const result = await service.discardCandidate(req.params.uploadId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function resetTrainingModel(req, res, next) {
  try {
    const result = await service.resetModel();
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function listTrainingRuns(req, res, next) {
  try {
    const runs = await service.listRuns();
    res.status(200).json({ success: true, data: runs });
  } catch (err) {
    next(err);
  }
}
```

- [ ] **Step 3: Wire the routes in `server/routes/index.js`**

Add to the imports section (after the existing `import { uploadExternalCsv, confirmExternalUpload } from '../controllers/externalUploadController.js';` line):

```javascript
import {
  uploadTrainingCsv, fitTrainingCandidate, deployTrainingCandidate,
  discardTrainingCandidate, resetTrainingModel, listTrainingRuns,
} from '../controllers/trainingController.js';
```

Add the routes near the existing `/pdm/fault-events/*` routes (after the `router.post('/pdm/fault-events/manual-buffer', ...)` line):

```javascript
// §15.7 — open to any authenticated app user (requireTrustedProxy only,
// deliberately no requireGroup): "make it possible for anyone to upload"
// per the design spec. requireTrustedProxy still blocks any request that
// bypassed Traefik/Authentik/nginx entirely, same as every other route here.
router.post('/pdm/training/upload', requireTrustedProxy, uploadCsv.single('file'), uploadTrainingCsv);
router.post('/pdm/training/:uploadId/fit', requireTrustedProxy, fitTrainingCandidate);
router.post('/pdm/training/:uploadId/deploy', requireTrustedProxy, deployTrainingCandidate);
router.delete('/pdm/training/:uploadId', requireTrustedProxy, discardTrainingCandidate);
router.post('/pdm/training/reset', requireTrustedProxy, resetTrainingModel);
router.get('/pdm/training/runs', requireTrustedProxy, listTrainingRuns);
```

`uploadCsv` (the multer middleware) is already imported at the top of `routes/index.js` (line 24: `import { uploadCsv } from '../middleware/uploadFile.js';`) — reused as-is, no new middleware file needed.

- [ ] **Step 4: Manual verification**

With the stack running (`docker compose up` or the project's existing local-dev equivalent), verify each route responds:

```bash
curl -s -X POST http://localhost:3000/api/pdm/training/reset -H "X-Internal-Proxy-Secret: $INTERNAL_PROXY_SECRET" | head -c 200
# or, in NODE_ENV=development/test (DEV_ENVS), no header is needed at all
curl -s -X POST http://localhost:3000/api/pdm/training/upload -F "file=@data/train.csv"
```

Confirm the upload call returns `{"success":true,"data":{"uploadId":"...","verdict":"PASS",...}}`, then chain `fit` and `deploy` with the returned `uploadId` and confirm each returns `success:true`.

- [ ] **Step 5: Commit**

```bash
git add server/controllers/trainingController.js server/services/trainingService.js server/routes/index.js
git commit -m "server: proxy /pdm/training/* to pdm, persist training_runs on deploy"
```

---

### Task 6: Client API additions

**Files:**
- Modify: `client/src/api/client.js`

**Interfaces:**
- Consumes: Task 5's six routes.
- Produces: `api.uploadTrainingCsv(file)`, `api.fitTrainingCandidate(uploadId)`, `api.deployTrainingCandidate(uploadId)`, `api.discardTrainingCandidate(uploadId)`, `api.resetTrainingModel()`, `api.trainingRuns()` — Task 7's `TrainModelPage.jsx` calls these.

- [ ] **Step 1: Add the upload helper and the new `api` entries**

In `client/src/api/client.js`, add a new function above `export const api = {` (after the existing `request()` function, before line 31):

```javascript
// Multipart upload needs its own fetch call — request()'s default
// Content-Type: application/json / JSON.stringify body would break a CSV
// upload; FormData needs the browser to set its own multipart boundary.
async function uploadRequest(path, file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(BASE + path, { method: 'POST', body: form });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON response — fall through to the check below
  }
  if (!res.ok || (body && body.success === false)) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.details = body;
    throw err;
  }
  return body;
}
```

Add to the `api` object (after the existing `faultEventBufferCsvUrl` entry, before the closing `};`):

```javascript
  uploadTrainingCsv: (file) => uploadRequest('/pdm/training/upload', file),
  fitTrainingCandidate: (uploadId) =>
    request(`/pdm/training/${encodeURIComponent(uploadId)}/fit`, { method: 'POST', headers: {}, body: undefined }),
  deployTrainingCandidate: (uploadId) =>
    request(`/pdm/training/${encodeURIComponent(uploadId)}/deploy`, { method: 'POST', headers: {}, body: undefined }),
  discardTrainingCandidate: (uploadId) =>
    request(`/pdm/training/${encodeURIComponent(uploadId)}`, { method: 'DELETE', headers: {}, body: undefined }),
  resetTrainingModel: () => request('/pdm/training/reset', { method: 'POST', headers: {}, body: undefined }),
  trainingRuns: () => request('/pdm/training/runs'),
```

`headers: {}` overrides `request()`'s default `Content-Type: application/json` for the no-body POST/DELETE calls (an empty JSON body would be harmless to Express here, but omitting it is cleaner and matches these endpoints not expecting one).

- [ ] **Step 2: Manual verification**

Not independently testable without Task 7's UI — verified together in Task 7's Step 3.

- [ ] **Step 3: Commit**

Commit together with Task 7 (Step 4 below) — this file has no independent behavior to verify before the page that calls it exists.

---

### Task 7: Client — Train Model page

**Files:**
- Create: `client/src/pages/TrainModelPage.jsx`
- Modify: `client/src/components/Sidebar.jsx`
- Modify: `client/src/components/TopBar.jsx`
- Modify: `client/src/App.jsx`

**Interfaces:**
- Consumes: Task 6's six `api.*` functions, `Card`/`CardLabel`/`buttonReset` (`client/src/components/Card.jsx`, existing).
- Produces: a `page === 'train'` route reachable from the sidebar; nothing else depends on this.

- [ ] **Step 1: Create `client/src/pages/TrainModelPage.jsx`**

```jsx
import { useState } from 'react';
import Card, { CardLabel, buttonReset } from '../components/Card.jsx';
import { api } from '../api/client.js';

function MetricsTable({ title, metrics }) {
  if (!metrics) {
    return (
      <div style={{ flex: 1, minWidth: 240 }}>
        <CardLabel>{title}</CardLabel>
        <div style={{ padding: '18px 0', color: '#8a99a8', fontSize: 13 }}>No model currently deployed.</div>
      </div>
    );
  }
  return (
    <div style={{ flex: 1, minWidth: 240 }}>
      <CardLabel>{title}</CardLabel>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10, fontSize: 12.5 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#8a99a8', fontSize: 11, textTransform: 'uppercase' }}>
            <th style={{ padding: '4px 6px' }}>Class</th>
            <th style={{ padding: '4px 6px' }}>Precision</th>
            <th style={{ padding: '4px 6px' }}>Recall</th>
            <th style={{ padding: '4px 6px' }}>Support</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(metrics.perClass).map(([label, m]) => (
            <tr key={label} style={{ borderTop: '1px solid #eef2f5' }}>
              <td style={{ padding: '6px' }}>{label}</td>
              <td style={{ padding: '6px' }}>{m.precision.toFixed(2)}</td>
              <td style={{ padding: '6px' }}>{m.recall.toFixed(2)}</td>
              <td style={{ padding: '6px' }}>{m.support}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 10, fontSize: 12.5, color: '#5f6f7e' }}>
        Overall accuracy: <strong>{(metrics.overallAccuracy * 100).toFixed(1)}%</strong>
      </div>
    </div>
  );
}

export default function TrainModelPage({ showToast }) {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [fitting, setFitting] = useState(false);
  const [fitResult, setFitResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setFile(null);
    setUploadResult(null);
    setFitResult(null);
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setUploadResult(null);
    setFitResult(null);
    try {
      const res = await api.uploadTrainingCsv(file);
      setUploadResult({ ok: true, ...res.data });
    } catch (err) {
      setUploadResult({ ok: false, reasons: err.details?.reasons || [err.message], qualityScore: err.details?.qualityScore });
    } finally {
      setUploading(false);
    }
  };

  const handleFit = async () => {
    setFitting(true);
    try {
      const res = await api.fitTrainingCandidate(uploadResult.uploadId);
      setFitResult(res.data);
    } catch (err) {
      showToast(`Fit failed: ${err.message}`, '#B3282D');
    } finally {
      setFitting(false);
    }
  };

  const handleDeploy = async () => {
    if (!window.confirm('Deploy this candidate model? It will replace whatever is currently live.')) return;
    setBusy(true);
    try {
      await api.deployTrainingCandidate(uploadResult.uploadId);
      showToast('Candidate model deployed.', '#177E4D');
      reset();
    } catch (err) {
      showToast(`Deploy failed: ${err.message}`, '#B3282D');
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async () => {
    setBusy(true);
    try {
      await api.discardTrainingCandidate(uploadResult.uploadId);
      reset();
    } catch (err) {
      showToast(`Discard failed: ${err.message}`, '#B3282D');
    } finally {
      setBusy(false);
    }
  };

  const handleModelReset = async () => {
    if (!window.confirm('Reset the live model? Tier 2 detections stop until a new model is deployed.')) return;
    setBusy(true);
    try {
      await api.resetTrainingModel();
      showToast('Live model reset — Tier 1 only until a new model is deployed.', '#8a99a8');
    } catch (err) {
      showToast(`Reset failed: ${err.message}`, '#B3282D');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: '20px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Train a new model</h2>
            <div style={{ fontSize: 12.5, color: '#8a99a8', marginTop: 3 }}>
              Upload a training CSV, review its quality report, fit a candidate, and compare it against the
              currently-deployed model before choosing to deploy it.
            </div>
          </div>
          <button
            type="button"
            className="hover-ghost"
            onClick={handleModelReset}
            disabled={busy}
            style={{ ...buttonReset, color: '#B3282D', borderRadius: 6, padding: '6px 12px', fontSize: 12.5, fontWeight: 600 }}
          >
            Reset live model
          </button>
        </div>
      </Card>

      <Card>
        <CardLabel>1. Upload training CSV</CardLabel>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
          <input type="file" accept=".csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button
            type="button"
            className="hover-outline-btn"
            onClick={handleUpload}
            disabled={!file || uploading}
            style={{ ...buttonReset, border: '1px solid #1F3A6E', color: '#1F3A6E', background: '#ffffff', borderRadius: 6, padding: '6px 14px', fontSize: 12.5, fontWeight: 600, opacity: !file || uploading ? 0.5 : 1 }}
          >
            {uploading ? 'Uploading…' : 'Upload & check quality'}
          </button>
        </div>
        {uploadResult && !uploadResult.ok && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 6, background: '#FBEAEA', color: '#8a2222', fontSize: 12.5 }}>
            Rejected{uploadResult.qualityScore != null ? ` (score ${uploadResult.qualityScore})` : ''}:
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {uploadResult.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
        )}
        {uploadResult?.ok && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 6, background: '#EAF6EF', color: '#177E4D', fontSize: 12.5 }}>
            Passed — quality score {uploadResult.qualityScore}, {uploadResult.rowCount} rows.
          </div>
        )}
      </Card>

      {uploadResult?.ok && (
        <Card>
          <CardLabel>2. Fit a candidate model</CardLabel>
          {!fitResult && (
            <button
              type="button"
              className="hover-outline-btn"
              onClick={handleFit}
              disabled={fitting}
              style={{ ...buttonReset, marginTop: 10, border: '1px solid #1F3A6E', color: '#1F3A6E', background: '#ffffff', borderRadius: 6, padding: '6px 14px', fontSize: 12.5, fontWeight: 600, opacity: fitting ? 0.5 : 1 }}
            >
              {fitting ? 'Fitting…' : 'Fit candidate'}
            </button>
          )}
          {fitResult && (
            <>
              <div style={{ display: 'flex', gap: 24, marginTop: 14, flexWrap: 'wrap' }}>
                <MetricsTable title="Currently deployed" metrics={fitResult.deployedMetrics} />
                <MetricsTable title="Candidate (this upload)" metrics={fitResult.candidateMetrics} />
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                <button
                  type="button"
                  className="hover-outline-btn"
                  onClick={handleDeploy}
                  disabled={busy}
                  style={{ ...buttonReset, border: '1px solid #177E4D', color: '#177E4D', background: '#ffffff', borderRadius: 6, padding: '6px 14px', fontSize: 12.5, fontWeight: 600, opacity: busy ? 0.5 : 1 }}
                >
                  Deploy this model
                </button>
                <button
                  type="button"
                  className="hover-ghost"
                  onClick={handleDiscard}
                  disabled={busy}
                  style={{ ...buttonReset, color: '#8a99a8', borderRadius: 6, padding: '6px 14px', fontSize: 12.5, fontWeight: 600 }}
                >
                  Discard
                </button>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the page into `Sidebar.jsx`, `TopBar.jsx`, and `App.jsx`**

In `client/src/components/Sidebar.jsx`, add a new icon to `NAV_ICONS` (after the `reports` entry, before the closing `};` at line 32):

```jsx
  train: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M8 1.8 L8 14.2 M2.5 5.5 L13.5 5.5 M2.5 10.5 L13.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
```

Add a new entry to the `PAGES` array (after `{ id: 'reports', label: 'Reports' },`):

```jsx
  { id: 'train', label: 'Train Model' },
```

In `client/src/components/TopBar.jsx`, add to `PAGE_TITLES` (after the `reports` entry):

```jsx
  train: 'Train Model',
```

In `client/src/App.jsx`, add the import (after the existing `import ReportsPage from './pages/ReportsPage.jsx';`):

```jsx
import TrainModelPage from './pages/TrainModelPage.jsx';
```

And add the route (after the existing `{page === 'reports' && (...)}` block, before the closing `</main>`):

```jsx
        {page === 'train' && <TrainModelPage showToast={showToast} />}
```

- [ ] **Step 3: Manual verification**

Run the client dev server, navigate to the new "Train Model" sidebar entry. Upload a deliberately bad CSV (e.g. a 2-row file with only two columns) and confirm the rejection reasons render. Upload `data/train.csv` (still present in the repo per Task 8's note below) and confirm: quality PASS → "Fit candidate" produces a comparison table (with "No model currently deployed" on the left if Task 8's reset has already run) → "Deploy this model" succeeds and shows the success toast.

- [ ] **Step 4: Commit**

```bash
git add client/src/api/client.js client/src/pages/TrainModelPage.jsx client/src/components/Sidebar.jsx client/src/components/TopBar.jsx client/src/App.jsx
git commit -m "client: add Train Model page (upload, quality report, fit/compare/deploy)"
```

---

### Task 8: Start over — reset the currently-deployed model

**Files:** none (operational step, no code change — Tasks 1-7 already made this possible; this task just performs it).

**Interfaces:** Consumes `POST /training/reset` (Task 4) via either the FE button (Task 7) or a direct call.

- [ ] **Step 1: Reset the live artifact**

With the stack running (after Tasks 1-7 are deployed), either click "Reset live model" in the new Train Model page, or call the endpoint directly:

```bash
curl -s -X POST http://localhost:3000/api/pdm/training/reset -H "X-Internal-Proxy-Secret: $INTERNAL_PROXY_SECRET"
```

- [ ] **Step 2: Verify Tier 2 is inactive**

Confirm `POST /api/pdm/training/reset`'s response is `{"success":true,"data":{"reset":true}}`, and that a subsequent live detection's fault event (or a direct `POST http://localhost:8000/score` inside the `pdm` container, if reachable for debugging) carries no `tier2Label`/`tier2Probability` fields — the existing FE badge code (`faultEvents.js`, `PredictionsPage.jsx`, `ReviewDrawer.jsx`) requires no change, since it already renders nothing when a fault event has no Tier 2 fields.

**Note:** `data/train.csv` itself (the git-tracked CSV, distinct from the trained artifact) is left in place — it's raw training data, not a model, and remains available both as a manual re-upload through the new Train Model page and as a reference dataset. Only the fitted `model.joblib`/`metadata.json` are wiped by this task.

---

## Self-Review Notes

- **Spec coverage:** §1 (start over) → Tasks 3/4/8. §2 (quality gate + preprocessing) → Task 2. §3 (endpoints) → Task 4. §4 (Node proxy) → Task 5. §5 (FE panel) → Tasks 6/7. §6 (Needs Review collapse) → Task 1. Error handling section → covered inline in Task 4's endpoint bodies (422 on reject, 404 on unknown uploadId, live artifact only touched by `/deploy`). Testing section → Tasks 2/3/4's pytest files; Node/manual testing called out explicitly in Task 5 (no existing Node test convention found in `server/tests` to follow, so this plan uses manual `curl` verification instead of inventing a new Node test pattern).
- **Type/name consistency checked:** `training_quality.assess()`'s return shape (Task 2) matches exactly what Task 4's `/training/upload` handler reads (`report["verdict"]`, `report["reasons"]`, `report["qualityScore"]`, `report["rowCount"]`). `training.fit_model`'s new `artifact_dir` param (Task 3) matches Task 4's call in `fit_candidate()`. `model.reload()`/`model.reset()` (Task 3) match Task 4's calls in `deploy_candidate()`/`reset_live_model()`. Node's `trainingService.js` function names (Task 5) match `trainingController.js`'s imports and `api/client.js`'s Task 6 calls one-for-one.
- **Fixed during self-review:** Task 5 Step 1's `uploadCsv()` originally imported an unused `createReadStream` and read the file via `readFile` for buffering — corrected in the code block above (the final version has no `createReadStream` import, only `readFile`/`unlink`, so there's nothing left to strip in the implementer's own pass).
