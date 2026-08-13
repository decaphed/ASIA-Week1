// ─────────────────────────────────────────────────────────────────────────
// faultEventModel.js — the ONLY place that contains SQL for fault_events.
//
// Same convention as processedModel.js: every camelCase column name is
// double-quoted, values are always bound as $1, $2, … (never concatenated).
//
// fault_events is created by server/database/migrations/002_fault_events.up.sql
// (deferred out of 001_init, then genuinely forgotten until it started
// failing every query at runtime — see docs/plan/2026-08-11-hardening.md's
// bugfix note). This file is converted from better-sqlite3 to `pg`, matching
// every other model in this directory.
// ─────────────────────────────────────────────────────────────────────────

import pool, { toIso } from '../database/db.js';

/** Insert a new fault_events row (FLAGGED or NEGATIVE_SAMPLE — caller sets eventType/status). */
export async function insertFaultEvent(record) {
  const result = await pool.query(
    `INSERT INTO fault_events
      ("processedTelemetryId", "eventType", "detectedAt", "triggerWindowEnd", "lastSeenWindowEnd",
       "triggeredRules", "confidence", "featureSnapshot", "thresholdsVersion",
       "faultStart", "faultEnd", "bufferStart", "bufferEnd", "status")
     VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      record.processedTelemetryId, record.eventType, record.detectedAt, record.triggerWindowEnd, record.lastSeenWindowEnd,
      record.triggeredRules, record.confidence, record.featureSnapshot, record.thresholdsVersion,
      record.faultStart, record.faultEnd, record.bufferStart, record.bufferEnd, record.status,
    ],
  );
  return { lastInsertRowid: result.rows[0]?.id };
}

/**
 * Try to extend an existing open row instead of inserting a new one.
 *
 * The `jsonb_typeof(...) = 'array'` guard exists because a small number of
 * pre-existing rows in production have `triggeredRules` stored as a jsonb
 * SCALAR (a bare string) rather than an array — likely inserted by an
 * older version of faultEventService.js before it consistently
 * JSON.stringify()'d an actual array before every insert (every current
 * call site does; see faultEventService.js's recordFlaggedEvent). Without
 * this guard, jsonb_array_elements_text() throws "cannot extract elements
 * from a scalar" the moment this query's EXISTS subquery reaches one of
 * those rows, which fails recordFlaggedEvent() for that window entirely —
 * observed firing on nearly every flagged window in production. This
 * guard only prevents the crash (a malformed row is correctly treated as
 * "doesn't match, don't coalesce into it" rather than aborting the whole
 * query); it does not repair the malformed data itself — a one-time
 * backfill/cleanup of those specific rows is a separate follow-up that
 * needs direct DB access to identify and fix.
 * @returns the extended row's id, or undefined if no open row matched.
 */
export async function extendOpenEvent({ triggerWindowEnd, triggeredRules, lookbackBound }) {
  const result = await pool.query(
    `UPDATE fault_events
     SET "faultEnd" = $1,
         "triggerWindowEnd" = $1,
         "lastSeenWindowEnd" = $1
     WHERE id = (
       SELECT fe.id FROM fault_events fe
       WHERE fe.status = 'PENDING_REVIEW'
         AND fe."lastSeenWindowEnd" >= $2
         AND jsonb_typeof(fe."triggeredRules") = 'array'
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(fe."triggeredRules") existing
           JOIN jsonb_array_elements_text($3::jsonb) incoming ON existing = incoming
         )
       ORDER BY fe."lastSeenWindowEnd" DESC
       LIMIT 1
     )
     RETURNING id`,
    [triggerWindowEnd, lookbackBound, JSON.stringify(triggeredRules)],
  );
  return result.rows[0]?.id;
}

/** @returns true if any FLAGGED event is currently open (within lookbackBound). */
export async function hasOpenEvent(lookbackBound) {
  const result = await pool.query(
    `SELECT 1 FROM fault_events WHERE status = 'PENDING_REVIEW' AND "lastSeenWindowEnd" >= $1 LIMIT 1`,
    [lookbackBound],
  );
  return result.rows.length > 0;
}

/** @returns fault_events rows filtered by status, or all rows if status is falsy. */
export async function listFaultEvents(status) {
  const result = status
    ? await pool.query('SELECT * FROM fault_events WHERE status = $1 ORDER BY id DESC', [status])
    : await pool.query('SELECT * FROM fault_events ORDER BY id DESC');
  return result.rows;
}

/** @returns a single fault_events row by id, or undefined. */
export async function getFaultEventById(id) {
  const result = await pool.query('SELECT * FROM fault_events WHERE id = $1', [id]);
  return result.rows[0];
}

/** Apply a HITL review patch (confirm/reject/annotate). */
export async function updateFaultEventReview(record) {
  return pool.query(
    `UPDATE fault_events
     SET status = $1,
         "faultType" = $2,
         "rootCause" = $3,
         resolution = $4,
         "reviewedBy" = $5,
         "reviewedAt" = $6,
         notes = $7,
         "faultEnd" = $8,
         "bufferEnd" = $9
     WHERE id = $10`,
    [
      record.status, record.faultType, record.rootCause, record.resolution,
      record.reviewedBy, record.reviewedAt, record.notes, record.faultEnd, record.bufferEnd, record.id,
    ],
  );
}

/** @returns [{ confidence, status, count }] grouped counts for FLAGGED rows. */
export async function getFaultEventStats() {
  const result = await pool.query(
    `SELECT confidence, status, COUNT(*) AS count
     FROM fault_events
     WHERE "eventType" = 'FLAGGED'
     GROUP BY confidence, status`,
  );
  return result.rows;
}

/** @returns raw_telemetry rows within [bufferStart, bufferEnd], chronological. */
export async function getBufferRange(bufferStart, bufferEnd) {
  const result = await pool.query(
    `SELECT * FROM raw_telemetry WHERE "timestamp" BETWEEN $1 AND $2 ORDER BY "timestamp" ASC`,
    [bufferStart, bufferEnd],
  );
  return result.rows.map((row) => ({ ...row, timestamp: toIso(row.timestamp) }));
}
