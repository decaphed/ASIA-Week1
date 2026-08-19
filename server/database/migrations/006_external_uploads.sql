-- Up Migration

-- 006_external_uploads.sql — §10.4 Entry point 2's audit/metadata record
-- for an uploaded CSV of genuinely external fault data (never passed
-- through this system's own ingest — see docs/plan/2026-08-05-pdm-
-- implementation.md §10.4.1's Stage A/B/C gate).
--
-- Deliberately NOT a fault_events row (design-review decision D10):
-- fault_events' shape (one featureSnapshot, one processedTelemetryId) was
-- built around a single triggering window; an upload can span many
-- windows across the whole file. 005_training_corpus.sql's own header
-- comment already reserved bufferId = 'upload:<uploadId>:<windowIndex>'
-- with faultEventId NULL for exactly this case — accepted upload rows go
-- straight into training_corpus, this table is only the audit trail of
-- the upload itself (what was uploaded, how it was mapped, whether/why it
-- was accepted or rejected).
CREATE TABLE external_uploads (
  id                    BIGSERIAL PRIMARY KEY,

  "originalFilename"    TEXT NOT NULL,
  "uploadedBy"          TEXT NOT NULL,
  "uploadedAt"          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- AWAITING_MAPPING: Stage A passed, waiting on the operator's column
  --   mapping (POST .../confirm).
  -- STAGE_B_REJECTED: mapping/unit/range validation failed.
  -- STAGE_C_REJECTED: quality gate failed (composite score or a floor).
  -- BALANCE_REJECTED: would have skewed the whole corpus past threshold.
  -- ACCEPTED: materialized into training_corpus.
  "status"              TEXT NOT NULL DEFAULT 'AWAITING_MAPPING'
    CHECK ("status" IN ('AWAITING_MAPPING', 'STAGE_B_REJECTED', 'STAGE_C_REJECTED', 'BALANCE_REJECTED', 'ACCEPTED')),

  -- Parsed, Stage-A-filtered rows — the actual staged data between the
  -- upload and confirm requests. NULL once the upload reaches any
  -- terminal state (ACCEPTED or any *_REJECTED) — nothing needs the raw
  -- rows after that point, and there's no reason to keep an uploaded
  -- file's full content sitting in Postgres indefinitely (design review
  -- D18's security posture: staged in Postgres rather than left on the
  -- container filesystem across requests, but still cleared promptly).
  "stagedRows"          JSONB,
  "stageAResult"         JSONB NOT NULL,          -- {detectedTimestampColumn, excludedColumns, rowCount, medianIntervalSec, warnings}
  "columnMapping"        JSONB,                    -- set at confirm: {sourceCol: {metric, unit, confidence}}

  "faultType"            TEXT,
  "rootCause"            TEXT,
  "resolution"           TEXT,
  "notes"                TEXT,

  "qualityScore"          NUMERIC,
  "physicsPassRate"       NUMERIC,
  "imputationRate"        NUMERIC,
  "outlierRate"           NUMERIC,
  "windowCount"           INTEGER,
  "rejectedReason"        TEXT,

  "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_external_uploads_status ON external_uploads ("status");
CREATE INDEX idx_external_uploads_uploaded_at ON external_uploads ("uploadedAt");


-- Down Migration

-- 006_external_uploads.down.sql — reverse of 006_external_uploads.sql.
DROP TABLE IF EXISTS external_uploads;
