"""Pydantic models mirroring the flat processedRecord shape Node sends to
POST /score (docs/plan/2026-08-05-pdm-implementation.md §3.4, §3.5).

This is the flat, pre-insert shape (`flowRateMean`, `dominantStatus`, ...) —
the same object `pipeline.js` builds and forecast/drift/trend already
receive — NOT the nested rowToProcessed() API-response shape. Declaring it
as a Pydantic model means a shape drift on the Node side fails loudly here
(422) instead of Python silently misreading a missing/renamed field.

extra="ignore": the real payload carries many more fields (windowStart,
sampleCount, quality counters, ...) that the rule engine doesn't need —
only the fields actually used by rules.py are required below.
"""

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict

METRICS = ["flowRate", "rpm", "vibration", "suctionPressure", "dischargePressure", "motorTemp"]


class PrecapMetricFeatures(BaseModel):
    rawStdDev: float
    rawRateOfChange: float
    rawMaxExcursion: float

    model_config = ConfigDict(extra="ignore")


class ProcessedRecordIn(BaseModel):
    windowEnd: str
    dominantStatus: str
    precapFeaturesByMetric: dict[str, PrecapMetricFeatures]

    flowRateMin: float
    flowRateMax: float
    rpmMin: float
    rpmMax: float
    vibrationMin: float
    vibrationMax: float
    suctionPressureMin: float
    suctionPressureMax: float
    dischargePressureMin: float
    dischargePressureMax: float
    motorTempMin: float
    motorTempMax: float

    model_config = ConfigDict(extra="ignore")


class ScoreResponse(BaseModel):
    flagged: bool
    confidence: Optional[Literal["LOW", "MEDIUM", "HIGH"]] = None
    triggeredRules: list[str] = []
    metric: Optional[str] = None
    windowEnd: str
    # Required on every response, flagged or not (§3.2) — Node has no other
    # way to learn which thresholds.yaml revision was active for this verdict.
    thresholdsVersion: str
