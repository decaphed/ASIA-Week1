-- 002_fault_events.up.sql — the PdM HITL review table, deferred out of
-- 001_init.up.sql ("a later, separate PdM phase") and never actually
-- written until now. Reconstructed from the original SQLite schema.sql
-- (deleted in commit 3648784's SQLite -> Postgres/TimescaleDB migration;
-- retrieved via `git show 3648784~1:server/database/schema.sql`), ported to
-- this repo's Postgres conventions the same way 001_init.up.sql ported
-- raw_telemetry/processed_telemetry: TEXT ISO-timestamp columns become
-- TIMESTAMPTZ, JSON-text columns become JSONB, INTEGER PRIMARY KEY
-- AUTOINCREMENT becomes BIGSERIAL. Every mixed-case column is double-quoted
-- for the same reason given in 001_init.up.sql's header — one rule, applied
-- uniformly.
--
-- NOT a hypertable — this is a low-volume HITL review table (one row per
-- fault episode, not one per sample), not a high-frequency time series, so
-- it gets a plain surrogate BIGSERIAL primary key rather than the composite
-- (id, "timestamp") shape raw_telemetry/processed_telemetry need.
--
-- No REFERENCES on "processedTelemetryId": the original SQLite schema had a
-- real FK here ("FK enforcement" per commit 95febd7's message), but
-- processed_telemetry is a TimescaleDB hypertable whose PRIMARY KEY/UNIQUE
-- constraints are required to include the "timestamp" partitioning column
-- (see 001_init.up.sql's own comment on this) — there is no unique
-- constraint on processed_telemetry(id) alone for a single-column FK to
-- reference. faultEventModel.js/faultEventService.js only ever pass the id,
-- not a companion timestamp, so enforcing this for real would mean adding a
-- second column and threading it through the model/service layer — a
-- larger change than "create the missing table," and plausibly the actual
-- reason this migration was deferred indefinitely rather than written
-- wrong. Left as a plain indexed BIGINT; integrity relies on the
-- application (every caller sources this id from a just-inserted or
-- just-read processed_telemetry row).
CREATE TABLE fault_events (
  id                    BIGSERIAL PRIMARY KEY,

  "processedTelemetryId" BIGINT NOT NULL,

  -- eventType distinguishes an actual Tier 1 flag from a periodically-
  -- sampled confirmed-normal window banked as a negative training example
  -- — without this, Tier 2 would train on flagged windows only.
  "eventType"           TEXT NOT NULL DEFAULT 'FLAGGED',        -- FLAGGED | NEGATIVE_SAMPLE
  "detectedAt"          TIMESTAMPTZ NOT NULL,                   -- when the flag/sample was raised
  "triggerWindowEnd"    TIMESTAMPTZ NOT NULL,                   -- processed_telemetry."timestamp" that triggered this
  "lastSeenWindowEnd"   TIMESTAMPTZ,                             -- bumped on every coalescing extension
  "triggeredRules"      JSONB,                                   -- JSON array, e.g. ["vibration.rateOfChange"]; null for NEGATIVE_SAMPLE
  "confidence"          TEXT,                                    -- LOW | MEDIUM | HIGH (Tier 1's own read); null for NEGATIVE_SAMPLE

  -- Snapshot of exactly what Tier 1 saw at flag time — captured now because
  -- it cannot be reconstructed later if feature windowing or thresholds
  -- change before Tier 2 is trained (train/serve skew). Fixed composition,
  -- identical for BOTH eventTypes: full precapFeaturesByMetric (all six
  -- metrics) plus a full per-metric metricStats block — never a per-metric
  -- subset, even when only one or two metrics triggered a rule.
  "featureSnapshot"     JSONB NOT NULL,
  "thresholdsVersion"   TEXT,                                    -- the `version:` string read from thresholds.yaml

  -- Buffer boundaries — an hour before the fault, the fault period itself,
  -- and an hour after it's resolved. bufferEnd is only known once the fault
  -- is resolved (HITL confirms with a faultEnd), so it's nullable until
  -- then. Null for NEGATIVE_SAMPLE rows, which have no fault period.
  "faultStart"          TIMESTAMPTZ,
  "faultEnd"            TIMESTAMPTZ,
  "bufferStart"         TIMESTAMPTZ,                             -- faultStart minus 1 hour
  "bufferEnd"           TIMESTAMPTZ,                             -- faultEnd plus 1 hour, once known

  -- HITL fields — null until a human reviews it. Not applicable to
  -- NEGATIVE_SAMPLE rows, which don't go through review — inserts for those
  -- must explicitly pass status = 'N/A' rather than relying on the default,
  -- or every negative sample would land in the PENDING_REVIEW queue.
  "status"              TEXT NOT NULL DEFAULT 'PENDING_REVIEW',  -- PENDING_REVIEW | CONFIRMED | REJECTED | N/A
  "faultType"           TEXT,                                    -- THERMAL | CAVITATION | BEARING | OTHER, HITL's call
  "rootCause"           TEXT,
  "resolution"          TEXT,
  "reviewedBy"          TEXT,
  "reviewedAt"          TIMESTAMPTZ,
  "notes"               TEXT,

  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fault_events_status ON fault_events ("status");
CREATE INDEX idx_fault_events_buffer ON fault_events ("bufferStart", "bufferEnd");
CREATE INDEX idx_fault_events_processed ON fault_events ("processedTelemetryId");
