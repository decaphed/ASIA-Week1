-- Up Migration

-- 007_tier2_predictions.sql — §14.6.2/D36 + §15.3's correction: Tier 2
-- scores EVERY closed window, but fault_events only ever has rows for
-- flagged windows and periodic negative samples (§3.3.1) — even after
-- §15.4/D54 lets Tier 2 open its own rows, most quiet windows (Tier 1
-- silent, Tier 2 predicting NORMAL) still have no fault_events row to
-- attach anything to. tier2_predictions is the every-window log that
-- doesn't silently drop those windows; §14.6.1's monitoring reads from
-- here, not from fault_events.
--
-- Separately, §15.3 adds tier2FaultStatus/tier2Confidence directly on
-- fault_events — a HITL-reviewer-facing snapshot on a row that already
-- exists for another reason (Tier 1 flagged it, Tier 2 flagged it, or it's
-- a negative sample), derived from tier2Label/tier2Probability at the
-- moment that row is written/extended, per the project owner's explicit
-- request to store fault status as 0/1 there specifically. This is NOT a
-- substitute for the complete tier2_predictions log — the two serve
-- different purposes and must not be conflated (§15.3's own correction to
-- this section's original text, which wrongly said "every scored window").
CREATE TABLE tier2_predictions (
  id                    BIGSERIAL PRIMARY KEY,

  "processedTelemetryId" BIGINT NOT NULL,
  "predictedLabel"      TEXT NOT NULL,
  "probability"         REAL NOT NULL,
  "modelRunId"          BIGINT REFERENCES training_runs(id),
  "artifactSha256"      TEXT,

  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tier2_predictions_processed ON tier2_predictions ("processedTelemetryId");
CREATE INDEX idx_tier2_predictions_model_run ON tier2_predictions ("modelRunId");

-- §15.3 — HITL-facing snapshot on whichever fault_events row already
-- exists, derived (not the model's own output shape) at write/extend time:
-- tier2FaultStatus = (tier2Label === 'FAULT' ? 1 : 0), tier2Confidence =
-- tier2Probability. Both nullable — most existing rows predate Tier 2.
ALTER TABLE fault_events ADD COLUMN "tier2FaultStatus" INTEGER;
ALTER TABLE fault_events ADD COLUMN "tier2Confidence" REAL;

ALTER TABLE fault_events
  ADD CONSTRAINT fault_events_tier2_fault_status_check
    CHECK ("tier2FaultStatus" IS NULL OR "tier2FaultStatus" IN (0, 1));


-- Down Migration

-- 007_tier2_predictions.down.sql — reverse of 007_tier2_predictions.sql.
ALTER TABLE fault_events DROP CONSTRAINT IF EXISTS fault_events_tier2_fault_status_check;
ALTER TABLE fault_events DROP COLUMN IF EXISTS "tier2Confidence";
ALTER TABLE fault_events DROP COLUMN IF EXISTS "tier2FaultStatus";
DROP TABLE IF EXISTS tier2_predictions;
