"""Pydantic models mirroring the flat processedRecord shape Node sends to
POST /score (docs/plan/2026-08-05-pdm-implementation.md §3.4, §3.5).

This is the flat, pre-insert shape (`engineRpmMean`, `dominantStatus`, ...) —
the same object `pipeline.js` builds and forecast/drift/trend already
receive — NOT the nested rowToProcessed() API-response shape. Declaring it
as a Pydantic model means a shape drift on the Node side fails loudly here
(422) instead of Python silently misreading a missing/renamed field.

extra="ignore": the real payload carries many more fields (windowStart,
sampleCount, quality counters, ...) that the rule engine doesn't need —
only the fields actually used by rules.py are required below.

Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
migration.md Phase 2 step 3. Fault-type Literals updated to the engine
failure modes proposed in plan §4.2 (engineering judgment, not derived from
data/train.csv — it carries no fault-type supervision at all, per plan §3).
tier2Label changed from "NORMAL"/"FAULT" to "CLASS_0"/"CLASS_1" per plan §5's
resolved decision: Engine_Condition's polarity is not determinable from the
data and is exposed neutrally rather than asserted.
"""

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict

METRICS = ["engineRpm", "lubOilPressure", "fuelPressure", "coolantPressure", "lubOilTemperature", "coolantTemperature"]

FaultType = Literal[
    "OIL_PRESSURE_LOSS",
    "COOLANT_OVERHEAT",
    "COOLANT_LOSS",
    "FUEL_STARVATION",
    "OVERSPEED",
    "OIL_DEGRADATION",
    "THERMOSTAT_STUCK",
    "OTHER",
]


class PrecapMetricFeatures(BaseModel):
    rawStdDev: float
    rawRateOfChange: float
    rawMaxExcursion: float

    model_config = ConfigDict(extra="ignore")


class ProcessedRecordIn(BaseModel):
    windowEnd: str
    dominantStatus: str
    precapFeaturesByMetric: dict[str, PrecapMetricFeatures]

    engineRpmMin: float
    engineRpmMax: float
    lubOilPressureMin: float
    lubOilPressureMax: float
    fuelPressureMin: float
    fuelPressureMax: float
    coolantPressureMin: float
    coolantPressureMax: float
    lubOilTemperatureMin: float
    lubOilTemperatureMax: float
    coolantTemperatureMin: float
    coolantTemperatureMax: float

    # §15.1/D51 — model.score() reads these *Mean fields (via
    # model.py's _PROCESSED_RECORD_FEATURE_FIELDS) to build its feature
    # vector. Without them declared here, extra="ignore" would silently
    # drop them from record.model_dump() on this endpoint's /score fallback
    # path, leaving Tier 2 permanently unable to build a vector (every
    # value None -> to_vector() raises -> score() logs and returns None) —
    # never loudly wrong, just silently inert. Declared required (not
    # Optional) like the existing *Min/*Max fields above: main.py's /score
    # handler needs them whether or not a Tier 2 model happens to be loaded.
    engineRpmMean: float
    lubOilPressureMean: float
    fuelPressureMean: float
    coolantPressureMean: float
    lubOilTemperatureMean: float
    coolantTemperatureMean: float

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
    tier2Label: Optional[Literal["CLASS_0", "CLASS_1"]] = None
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
    faultType: Optional[FaultType] = None
    engineRpm: Optional[float] = None
    lubOilPressure: Optional[float] = None
    fuelPressure: Optional[float] = None
    coolantPressure: Optional[float] = None
    lubOilTemperature: Optional[float] = None
    coolantTemperature: Optional[float] = None
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
    dominantFaultType: Optional[FaultType] = None
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

    engineRpmMean: float
    engineRpmMedian: float
    engineRpmMin: float
    engineRpmMax: float
    engineRpmStdDev: float
    engineRpmLast: Optional[float] = None

    lubOilPressureMean: float
    lubOilPressureMedian: float
    lubOilPressureMin: float
    lubOilPressureMax: float
    lubOilPressureStdDev: float
    lubOilPressureLast: Optional[float] = None

    fuelPressureMean: float
    fuelPressureMedian: float
    fuelPressureMin: float
    fuelPressureMax: float
    fuelPressureStdDev: float
    fuelPressureLast: Optional[float] = None

    coolantPressureMean: float
    coolantPressureMedian: float
    coolantPressureMin: float
    coolantPressureMax: float
    coolantPressureStdDev: float
    coolantPressureLast: Optional[float] = None

    lubOilTemperatureMean: float
    lubOilTemperatureMedian: float
    lubOilTemperatureMin: float
    lubOilTemperatureMax: float
    lubOilTemperatureStdDev: float
    lubOilTemperatureLast: Optional[float] = None

    coolantTemperatureMean: float
    coolantTemperatureMedian: float
    coolantTemperatureMin: float
    coolantTemperatureMax: float
    coolantTemperatureStdDev: float
    coolantTemperatureLast: Optional[float] = None

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


class DeleteResponse(BaseModel):
    deleted: bool


class ResetResponse(BaseModel):
    reset: bool


class StampRunIdResponse(BaseModel):
    stamped: bool
    runId: int
