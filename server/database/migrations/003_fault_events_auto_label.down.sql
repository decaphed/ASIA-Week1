-- 003_fault_events_auto_label.down.sql — reverse of 003_fault_events_auto_label.up.sql.
ALTER TABLE fault_events
  DROP COLUMN "autoLabeled",
  DROP COLUMN "autoLabeledFromEventId";
