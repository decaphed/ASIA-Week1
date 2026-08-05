// ─────────────────────────────────────────────────────────────────────────
// faultEventModel.js — the ONLY place that contains SQL for fault_events.
//
// Same convention as processedModel.js: one prepared statement per query,
// compiled once at module load, values bound (never string-concatenated).
// ─────────────────────────────────────────────────────────────────────────

import db from '../database/db.js';

// Insert covers both eventType variants (FLAGGED and NEGATIVE_SAMPLE).
// status is always bound explicitly by the caller rather than relying on
// the column's PENDING_REVIEW default — a NEGATIVE_SAMPLE row that let the
// default fire would silently land in the HITL review queue (see
// faultEventService.js's negative-sample path, which always passes 'N/A').
const insertStmt = db.prepare(`
  INSERT INTO fault_events
    (processedTelemetryId, eventType, detectedAt, triggerWindowEnd, lastSeenWindowEnd,
     triggeredRules, confidence, featureSnapshot, thresholdsVersion,
     faultStart, faultEnd, bufferStart, bufferEnd, status)
  VALUES
    (@processedTelemetryId, @eventType, @detectedAt, @triggerWindowEnd, @lastSeenWindowEnd,
     @triggeredRules, @confidence, @featureSnapshot, @thresholdsVersion,
     @faultStart, @faultEnd, @bufferStart, @bufferEnd, @status)
`);

// Atomic find-open-and-extend statement (§3.3.2). "Open" = a PENDING_REVIEW
// row whose lastSeenWindowEnd is still within the caller-computed lookback
// bound, AND whose triggeredRules set shares at least one rule with the new
// window's triggeredRules set (json_each intersection) — an any-metric
// overlap would wrongly merge two independent multi-metric faults into one
// row. This is a single UPDATE ... WHERE (correlated subquery) ... RETURNING
// statement, not a separate SELECT-then-branch — see §3.3.2 for why this
// stays true even though the current synchronous better-sqlite3/single-
// threaded-Node stack means the race it guards against isn't live today.
const extendOpenEventStmt = db.prepare(`
  UPDATE fault_events
  SET faultEnd = @triggerWindowEnd,
      triggerWindowEnd = @triggerWindowEnd,
      lastSeenWindowEnd = @triggerWindowEnd
  WHERE id = (
    SELECT fe.id FROM fault_events fe
    WHERE fe.status = 'PENDING_REVIEW'
      AND fe.lastSeenWindowEnd >= @lookbackBound
      AND EXISTS (
        SELECT 1 FROM json_each(fe.triggeredRules) existing
        JOIN json_each(@triggeredRules) incoming ON existing.value = incoming.value
      )
    ORDER BY fe.lastSeenWindowEnd DESC
    LIMIT 1
  )
  RETURNING id
`);

// Whether any FLAGGED event is currently open — gates negative sampling
// (§3.3.1). Deliberately does NOT filter by triggeredRules overlap: any
// open fault, on any metric, suppresses sampling, since a transiently-
// clearing fault window would otherwise get banked as a mislabeled negative.
const hasOpenEventStmt = db.prepare(`
  SELECT 1 FROM fault_events
  WHERE status = 'PENDING_REVIEW' AND lastSeenWindowEnd >= @lookbackBound
  LIMIT 1
`);

const listByStatusStmt = db.prepare(`
  SELECT * FROM fault_events WHERE status = @status ORDER BY id DESC
`);
const listAllStmt = db.prepare(`
  SELECT * FROM fault_events ORDER BY id DESC
`);
const getByIdStmt = db.prepare(`
  SELECT * FROM fault_events WHERE id = ?
`);

const updateReviewStmt = db.prepare(`
  UPDATE fault_events
  SET status = @status,
      faultType = @faultType,
      rootCause = @rootCause,
      resolution = @resolution,
      reviewedBy = @reviewedBy,
      reviewedAt = @reviewedAt,
      notes = @notes,
      faultEnd = @faultEnd,
      bufferEnd = @bufferEnd
  WHERE id = @id
`);

// §3.6's /stats endpoint: HITL-outcome agreement with Tier 1's own
// confidence, scoped to FLAGGED rows only (NEGATIVE_SAMPLE rows have no
// confidence and never go through review).
const statsStmt = db.prepare(`
  SELECT confidence, status, COUNT(*) AS count
  FROM fault_events
  WHERE eventType = 'FLAGGED'
  GROUP BY confidence, status
`);

const bufferRangeStmt = db.prepare(`
  SELECT * FROM raw_telemetry
  WHERE timestamp BETWEEN @bufferStart AND @bufferEnd
  ORDER BY timestamp ASC
`);

/** Insert a new fault_events row (FLAGGED or NEGATIVE_SAMPLE — caller sets eventType/status). */
export function insertFaultEvent(record) {
  return insertStmt.run(record);
}

/**
 * Try to extend an existing open row instead of inserting a new one.
 * @returns the extended row's id, or undefined if no open row matched.
 */
export function extendOpenEvent({ triggerWindowEnd, triggeredRules, lookbackBound }) {
  const row = extendOpenEventStmt.get({ triggerWindowEnd, triggeredRules, lookbackBound });
  return row ? row.id : undefined;
}

/** @returns true if any FLAGGED event is currently open (within lookbackBound). */
export function hasOpenEvent(lookbackBound) {
  return hasOpenEventStmt.get({ lookbackBound }) !== undefined;
}

/** @returns fault_events rows filtered by status, or all rows if status is falsy. */
export function listFaultEvents(status) {
  return status ? listByStatusStmt.all({ status }) : listAllStmt.all();
}

/** @returns a single fault_events row by id, or undefined. */
export function getFaultEventById(id) {
  return getByIdStmt.get(id);
}

/** Apply a HITL review patch (confirm/reject/annotate). */
export function updateFaultEventReview(record) {
  return updateReviewStmt.run(record);
}

/** @returns [{ confidence, status, count }] grouped counts for FLAGGED rows. */
export function getFaultEventStats() {
  return statsStmt.all();
}

/** @returns raw_telemetry rows within [bufferStart, bufferEnd], chronological. */
export function getBufferRange(bufferStart, bufferEnd) {
  return bufferRangeStmt.all({ bufferStart, bufferEnd });
}
