"""Golden-value parity suite (docs/plan/2026-08-05-pdm-implementation.md
§11.6.5) — the load-bearing gate before Phase 3's cutover (pipeline.js
calling POST /process-window in place of local computation). For each
fixture in tests/parity/fixtures.py, runs the same raw sample sequence
through:
  - the JS reference harness (server/scripts/parity/run_js_pipeline.mjs),
    which reproduces pipeline.js's pure computation orchestration without a
    database (pipeline.js's own exported entry points require Postgres);
  - the Python pipeline (pdm/app/preprocessing/pipeline.py::process_window)
    directly, in-process.
and asserts the resulting processed_telemetry row shapes match within
float tolerance across every comparable field.

Run with: pytest tests/parity/test_golden_values.py
  (needs `node` on PATH and pdm/ importable — see conftest.py in this dir)
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from fixtures import FIXTURES, WINDOW_END, WINDOW_START  # noqa: E402

REPO_ROOT = Path(__file__).parent.parent.parent
JS_HARNESS = REPO_ROOT / "server" / "scripts" / "parity" / "run_js_pipeline.mjs"

# Fields present on the JS side that are EXPECTED to differ and are not
# meaningful to compare:
#   - preprocessingVersion: 'v2' (JS) vs 'v3-py' (Python) BY DESIGN, so a
#     downstream consumer can tell which implementation computed a row.
#   - preprocessingTimestamp: wall-clock "now", always differs.
SKIP_FIELDS = {"preprocessingVersion", "preprocessingTimestamp"}

# Tight, not a rounding-precision allowance: every rounded field (mean/
# median/stdDev/qualityScore/rates/precap features) goes through an
# equivalent deterministic round2()/js_round() on both sides, so genuinely
# matching algorithms should produce bit-identical output — this tolerance
# exists only to absorb IEEE-754 float-noise at the last decimal, NOT to
# hide a real off-by-a-cent divergence (a systematic +0.01 bug was
# confirmed, via mutation testing, to slip through a 0.011 tolerance
# undetected; 0.005 catches it while still tolerating float noise).
FLOAT_TOLERANCE = 0.005


def _run_js_pipeline(samples: list[dict]) -> dict:
    """Run the fixture through the JS reference harness and return its
    single processedRecord (fixtures are single-window by construction)."""
    proc = subprocess.run(
        ["node", str(JS_HARNESS)],
        input=json.dumps(samples),
        capture_output=True,
        text=True,
        cwd=str(JS_HARNESS.parent.parent.parent),  # server/ — for relative imports/module resolution
        env={
            **__import__("os").environ,
            # db.js throws at import time if unset; the pool is constructed
            # but never queried by anything this harness calls, so a
            # syntactically valid, unreachable URL is sufficient and never
            # actually connects.
            "DATABASE_URL": "postgres://parity:parity@localhost:5432/parity_unused",
        },
    )
    if proc.returncode != 0:
        raise RuntimeError(f"run_js_pipeline.mjs failed (exit {proc.returncode}):\n{proc.stderr}")

    # The pg Pool's import-time INFO log line lands on stdout before our
    # JSON payload (server/utils/logger.js writes via console.log, not
    # console.error) — locate the JSON payload directly rather than
    # touching production logging code for a test-only concern.
    marker = '{"processedRecords"'
    idx = proc.stdout.find(marker)
    if idx == -1:
        raise RuntimeError(f"run_js_pipeline.mjs produced no JSON payload:\n{proc.stdout}\n{proc.stderr}")

    payload = json.loads(proc.stdout[idx:])
    records = payload["processedRecords"]
    assert len(records) == 1, (
        f"expected exactly one closed window per fixture (got {len(records)}) — "
        "fixtures.py's module docstring assumes single-window fixtures"
    )
    return records[0]


def _run_python_pipeline(samples: list[dict]) -> dict:
    # Imported lazily so pytest collection doesn't require pdm/ on
    # sys.path unless this test file actually runs.
    sys.path.insert(0, str(REPO_ROOT / "pdm"))
    from app.preprocessing.pipeline import process_window

    result = process_window(
        window_samples=samples,
        prev_sample=None,
        window_start=WINDOW_START.isoformat().replace("+00:00", "Z"),
        window_end=WINDOW_END.isoformat().replace("+00:00", "Z"),
    )
    return result["processedRecord"]


def _assert_close(path: str, js_value, py_value):
    if isinstance(js_value, dict):
        assert isinstance(py_value, dict), f"{path}: JS gave dict, Python gave {type(py_value)}"
        assert js_value.keys() == py_value.keys(), f"{path}: key mismatch {js_value.keys()} vs {py_value.keys()}"
        for key in js_value:
            _assert_close(f"{path}.{key}", js_value[key], py_value[key])
    elif isinstance(js_value, (int, float)) and isinstance(py_value, (int, float)):
        assert abs(js_value - py_value) <= FLOAT_TOLERANCE, f"{path}: JS={js_value!r} Python={py_value!r}"
    else:
        assert js_value == py_value, f"{path}: JS={js_value!r} Python={py_value!r}"


@pytest.mark.parametrize("fixture_name", sorted(FIXTURES.keys()))
def test_golden_value_parity(fixture_name):
    samples = FIXTURES[fixture_name]

    js_record = _run_js_pipeline(samples)
    py_record = _run_python_pipeline(samples)

    js_keys = set(js_record.keys()) - SKIP_FIELDS
    py_keys = set(py_record.keys()) - SKIP_FIELDS
    assert js_keys == py_keys, (
        f"[{fixture_name}] processedRecord field-set mismatch.\n"
        f"JS only: {js_keys - py_keys}\nPython only: {py_keys - js_keys}"
    )

    for key in sorted(js_keys):
        _assert_close(f"[{fixture_name}].{key}", js_record[key], py_record[key])
