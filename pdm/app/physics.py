"""Loader for pump-physics.yaml — the RANGES shared with server/utils/
validation.js (docs/plan/2026-08-05-pdm-implementation.md §11.5 item 3 /
§11.6.1). Mirrors rules.py::load_thresholds()'s "load once at import time,
not per-request" convention.
"""

from pathlib import Path
from typing import Any

import yaml

# Repo root: pdm/app/physics.py -> pdm/app -> pdm -> repo root.
PUMP_PHYSICS_PATH = Path(__file__).parent.parent.parent / "pump-physics.yaml"


def load_ranges(path: Path = PUMP_PHYSICS_PATH) -> dict[str, dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    return doc["metrics"]
