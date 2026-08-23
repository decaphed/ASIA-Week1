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

    # §15.1/D51 — model.score() reads these *Mean fields (via
    # model.py's _PROCESSED_RECORD_FEATURE_FIELDS) to build its feature
    # vector. Without them declared here, extra="ignore" would silently
    # drop them from record.model_dump() on this endpoint's /score fallback
    # path, leaving Tier 2 permanently unable to build a vector (every
    # value None -> to_vector() raises -> score() logs and returns None) —
    # never loudly wrong, just silently inert. Declared required (not
    # Optional) like the existing *Min/*Max fields above: main.py's /score
    # handler needs them whether or not a Tier 2 model happens to be loaded.
    flowRateMean: float
    rpmMean: float
    vibrationMean: float
    suctionPressureMean: float
    dischargePressureMean: float
    motorTempMean: float

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

    # Tier 2 fields (§14.3.4/D27, §15.1/D56) — all Optional[...] = None so
    # every existing consumer/test is unaffected when no model is loaded.
    # Field naming is deliberately generic, not bootstrap-specific: a later
    # multi-class candidate's tier2Label values slot into the same field.
    tier2Label: Optional[Literal["NORMAL", "FAULT"]] = None
    tier2Probability: Optional[float] = None
    tier2ModelRunId: Optional[int] = None
    tier2ArtifactSha256: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────
# POST /process-window (§11.6.2) — request/response models. WindowSampleIn
# mirrors the flat raw-sample shape server/preprocessing/buffer.js's
# WindowState.samples holds (6 metrics + status, plus the provenance/
# physicsValid/unfilledMetrics annotations pipeline.py's internal audit-
# window rows carry). extra="ignore": Node's payload may carry additional
# bookkeeping fields the Python pipeline doesn't need.
# ─────────────────────────────────────────────────────────────────────────


class WindowSampleIn(BaseModel):
    timestamp: str
    status: Literal["RUNNING", "STOPPED", "FAULT"]
    faultType: Optional[Literal["THERMAL", "CAVITATION", "BEARING", "IMPELLER_WEAR", "SEAL_LEAK", "MISALIGNMENT", "DRY_RUN"]] = None
    flowRate: Optional[float] = None
    rpm: Optional[float] = None
    vibration: Optional[float] = None
    suctionPressure: Optional[float] = None
    dischargePressure: Optional[float] = None
    motorTemp: Optional[float] = None
    provenance: Literal["MEASURED", "IMPUTED"] = "MEASURED"
    # Only meaningful (and required to be non-None) on prevSample — the
    # anchor sample's physicsValid must already be known from a prior
    # window-close call for missing.py/validator.py's transition logic to
    # be meaningful (§11's cross-window continuity requirement). A real
    # windowSamples entry naturally omits this (Python computes it fresh).
    physicsValid: Optional[bool] = None
    physicsViolations: Optional[list[str]] = None
    unfilledMetrics: Optional[list[str]] = None

    model_config = ConfigDict(extra="ignore")


class ProcessWindowRequest(BaseModel):
    windowSamples: list[WindowSampleIn]
    prevSample: Optional[WindowSampleIn] = None
    windowStart: str
    windowEnd: str
    mergedSampleCount: int = 0
    duplicateSampleCount: int = 0

    model_config = ConfigDict(extra="ignore")


class ProcessedRecordOut(BaseModel):
    """The full processed_telemetry row shape pipeline.py::process_window
    builds — enumerated explicitly (not dict[str, Any]) so a field
    added/renamed/dropped on the Python side fails loudly against this
    contract, same reasoning as ProcessedRecordIn above."""

    windowStart: str
    windowEnd: str
    timestamp: str
    dominantStatus: Literal["RUNNING", "STOPPED", "FAULT"]
    dominantFaultType: Optional[Literal["THERMAL", "CAVITATION", "BEARING", "IMPELLER_WEAR", "SEAL_LEAK", "MISALIGNMENT", "DRY_RUN"]] = None
    runningSeconds: int
    faultSeconds: int
    stoppedSeconds: int
    sampleCount: int
    expectedSampleCount: int
    missingSampleCount: int
    imputedSampleCount: int
    physicsImputedCount: int
    outlierCount: int
    outliersByMetric: dict[str, int]
    precapFeaturesByMetric: dict[str, PrecapMetricFeatures]
    physicsViolationCount: int
    violationsByMetric: dict[str, int]
    missingRate: float
    imputationRate: float
    physicsImputationRate: float
    outlierRate: float
    physicsPassRate: float
    qualityScore: float
    qualityLabel: Literal["GOOD", "FAIR", "POOR"]
    isImputed: bool
    lateSampleCount: int
    mergedSampleCount: int
    duplicateSampleCount: int
    partiallyImputedCount: int
    partiallyImputedRate: float
    abnormalOperationSampleCount: int
    preprocessingVersion: str
    preprocessingTimestamp: str

    flowRateMean: float
    flowRateMedian: float
    flowRateMin: float
    flowRateMax: float
    flowRateStdDev: float
    flowRateLast: Optional[float] = None

    rpmMean: float
    rpmMedian: float
    rpmMin: float
    rpmMax: float
    rpmStdDev: float
    rpmLast: Optional[float] = None

    vibrationMean: float
    vibrationMedian: float
    vibrationMin: float
    vibrationMax: float
    vibrationStdDev: float
    vibrationLast: Optional[float] = None

    suctionPressureMean: float
    suctionPressureMedian: float
    suctionPressureMin: float
    suctionPressureMax: float
    suctionPressureStdDev: float
    suctionPressureLast: Optional[float] = None

    dischargePressureMean: float
    dischargePressureMedian: float
    dischargePressureMin: float
    dischargePressureMax: float
    dischargePressureStdDev: float
    dischargePressureLast: Optional[float] = None

    motorTempMean: float
    motorTempMedian: float
    motorTempMin: float
    motorTempMax: float
    motorTempStdDev: float
    motorTempLast: Optional[float] = None

    model_config = ConfigDict(extra="ignore")


class ProcessWindowResponse(BaseModel):
    processedRecord: ProcessedRecordOut
    tier1Verdict: ScoreResponse


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


class StampRunIdRequest(BaseModel):
    runId: int
