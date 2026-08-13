-- 003_fault_events_auto_label.up.sql — lets a newly-flagged event whose
-- "triggeredRules" set exactly matches a previously human-CONFIRMED event's
-- set skip PENDING_REVIEW and inherit that event's label automatically
-- (faultEventService.js's findAutoLabelSource/recordFlaggedEvent).
--
-- "autoLabeledFromEventId" points at the human-reviewed source row for
-- traceability/spot-checking. No FK, matching this table's existing
-- no-FK convention (see 002_fault_events.up.sql's header) — integrity
-- relies on the application, which only ever sets this to an id it just
-- read from a CONFIRMED fault_events row.
ALTER TABLE fault_events
  ADD COLUMN "autoLabeled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "autoLabeledFromEventId" BIGINT;
