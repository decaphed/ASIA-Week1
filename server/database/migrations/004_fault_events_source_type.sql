-- Up Migration

-- 004_fault_events_source_type.sql — adds provenance tracking to
-- fault_events, distinguishing HOW a row entered the corpus, orthogonal to
-- "eventType" (WHAT kind of row it is — FLAGGED vs NEGATIVE_SAMPLE).
-- docs/plan/2026-08-05-pdm-implementation.md §10.4 first raised this need
-- ("sourceType: TIER1_FLAGGED | MANUAL_BUFFER | EXTERNAL_UPLOAD") so a bad
-- contribution from one source can be traced/excluded without touching
-- rows from another. NEGATIVE_SAMPLE is added as a fourth value here (not
-- in §10.4's original three) since this schema already tracks that case
-- via "eventType" and provenance should stay a complete, non-overlapping
-- classification rather than leaving NEGATIVE_SAMPLE rows without one.
--
-- Standard three-step safe-migration pattern for adding a NOT NULL column
-- to a table with existing rows: add nullable, backfill, then constrain —
-- avoids the "NOT NULL blocks the backfill UPDATE" trap of doing it in one
-- statement.
ALTER TABLE fault_events ADD COLUMN "sourceType" TEXT;

UPDATE fault_events
SET "sourceType" = CASE
  WHEN "eventType" = 'NEGATIVE_SAMPLE' THEN 'NEGATIVE_SAMPLE'
  ELSE 'TIER1_FLAGGED'
END;

ALTER TABLE fault_events
  ALTER COLUMN "sourceType" SET NOT NULL,
  ADD CONSTRAINT fault_events_source_type_check
    CHECK ("sourceType" IN ('TIER1_FLAGGED', 'NEGATIVE_SAMPLE', 'MANUAL_BUFFER', 'EXTERNAL_UPLOAD'));


-- Down Migration

-- 004_fault_events_source_type.down.sql — reverse of 004_fault_events_source_type.sql.
ALTER TABLE fault_events DROP COLUMN "sourceType";
