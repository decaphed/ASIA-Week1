-- Up Migration

-- 008_fault_events_prediction_source.sql — §15.4/D54: Tier 2 gets its own
-- Predicted Faults review path, independent of Tier 1. predictionSource
-- records WHICH tier(s) actually flagged a given fault_events row —
-- orthogonal to "sourceType" (HOW the row entered the corpus: a live flag,
-- a manual buffer, an external upload) and to "eventType" (WHAT kind of
-- row it is: FLAGGED vs NEGATIVE_SAMPLE).
--
-- Same three-step safe-migration pattern as 004_fault_events_source_type.sql
-- (add nullable, backfill, then constrain) for a NOT NULL column on a table
-- with existing rows. Every row that predates this migration was, by
-- definition, a Tier 1 flag (Tier 2 didn't exist yet) — backfilled as
-- 'TIER1_RULE' unconditionally, including NEGATIVE_SAMPLE rows (§15.4 gives
-- no other meaning to predictionSource for those; they're not a Tier 1 OR
-- Tier 2 "flag" in the first place, but the column is NOT NULL so they get
-- the same default as every pre-Tier-2 row).
ALTER TABLE fault_events ADD COLUMN "predictionSource" TEXT;

UPDATE fault_events SET "predictionSource" = 'TIER1_RULE';

ALTER TABLE fault_events
  ALTER COLUMN "predictionSource" SET NOT NULL,
  ALTER COLUMN "predictionSource" SET DEFAULT 'TIER1_RULE',
  ADD CONSTRAINT fault_events_prediction_source_check
    CHECK ("predictionSource" IN ('TIER1_RULE', 'TIER2_MODEL', 'BOTH'));


-- Down Migration

-- 008_fault_events_prediction_source.down.sql — reverse of 008_fault_events_prediction_source.sql.
ALTER TABLE fault_events DROP CONSTRAINT IF EXISTS fault_events_prediction_source_check;
ALTER TABLE fault_events DROP COLUMN IF EXISTS "predictionSource";
