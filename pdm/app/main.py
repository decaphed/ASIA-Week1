"""FastAPI app: POST /score, GET /health (§3.5).

thresholds.yaml is loaded once at container startup (module import time),
not per-request — mirroring how the rest of this codebase avoids repeated
file I/O on a hot path.
"""

from fastapi import FastAPI

from . import model, rules
from .schemas import ProcessedRecordIn, ScoreResponse

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
