// ─────────────────────────────────────────────────────────────────────────
// faultEventModel.js — the ONLY place that contains SQL for fault_events.
//
// Same convention as processedModel.js: every camelCase column name is
// double-quoted, values are always bound as $1, $2, … (never concatenated).
//
// fault_events is created by server/database/migrations/002_fault_events.sql
// (deferred out of 001_init, then genuinely forgotten until it started
// failing every query at runtime — see docs/plan/2026-08-11-hardening.md's
// bugfix note). This file is converted from better-sqlite3 to `pg`, matching
// every other model in this directory.
// ─────────────────────────────────────────────────────────────────────────

import pool, { toIso } from '../database/db.js';

/**
 * Insert a new fault_events row (FLAGGED or NEGATIVE_SAMPLE — caller sets
 * eventType/status). The HITL review fields (faultType/rootCause/resolution/
 * reviewedBy/reviewedAt) and the two auto-label fields default to null/false
 * when the caller omits them — normal FLAGGED/NEGATIVE_SAMPLE inserts don't
 * pass these; only recordFlaggedEvent's auto-label path
 * (faultEventService.js's findAutoLabelSource) does, so a single atomic
 * INSERT can land a row already CONFIRMED and labeled with no separate
 * update and no transient PENDING_REVIEW state.
 */
export async function insertFaultEvent(record) {
  const result = await pool.query(
    `INSERT INTO fault_events
      ("processedTelemetryId", "eventType", "sourceType", "detectedAt", "triggerWindowEnd", "lastSeenWindowEnd",
       "triggeredRules", "confidence", "featureSnapshot", "thresholdsVersion",
       "faultStart", "faultEnd", "bufferStart", "bufferEnd", "status",
       "faultType", "rootCause", resolution, "reviewedBy", "reviewedAt", notes,
       "autoLabeled", "autoLabeledFromEventId", "predictionSource", "tier2FaultStatus", "tier2Confidence")
     VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
     RETURNING id`,
    [
      record.processedTelemetryId, record.eventType, record.sourceType ?? 'TIER1_FLAGGED', record.detectedAt, record.triggerWindowEnd, record.lastSeenWindowEnd,
      record.triggeredRules, record.confidence, record.featureSnapshot, record.thresholdsVersion,
      record.faultStart, record.faultEnd, record.bufferStart, record.bufferEnd, record.status,
      record.faultType ?? null, record.rootCause ?? null, record.resolution ?? null,
      record.reviewedBy ?? null, record.reviewedAt ?? null, record.notes ?? null,
      record.autoLabeled ?? false, record.autoLabeledFromEventId ?? null,
      record.predictionSource ?? 'TIER1_RULE', record.tier2FaultStatus ?? null, record.tier2Confidence ?? null,
    ],
  );
  return { lastInsertRowid: result.rows[0]?.id };
}

/**
 * Candidate fault_events rows whose [faultStart, faultEnd] intersects the
 * given range — used to reject an overlapping manual-buffer creation
 * before insert (server/services/faultEventService.js::createManualBufferEvent).
 * NEGATIVE_SAMPLE rows are excluded from this check BY CONSTRUCTION, not by
 * an explicit eventType filter: they always have faultStart/faultEnd = NULL
 * (see 002_fault_events.sql's column comments), so the range comparison
 * below can never match one — do not "fix" this by adding an eventType
 * filter, it isn't needed and the NULL behavior is already correct.
 * REJECTED/DISMISSED rows are excluded — a dismissed candidate shouldn't
 * block a human from asserting the real fault over the same period.
 * @returns [{ id, status, faultType }]
 */
export async function findOverlappingFaultEvents(faultStart, faultEnd) {
  const result = await pool.query(
    `SELECT id, status, "faultType" FROM fault_events
     WHERE status NOT IN ('REJECTED', 'DISMISSED')
       AND "faultStart" IS NOT NULL AND "faultEnd" IS NOT NULL
       AND "faultStart" <= $2 AND "faultEnd" >= $1`,
    [faultStart, faultEnd],
  );
  return result.rows;
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
 *
 * §15.4/D54's Tier-2-only path needs a SECOND matching branch: a
 * Tier-2-only flag has triggeredRules = [] (Tier 1 never fired), so the
 * rule-intersection EXISTS above is always empty for it — every window a
 * Tier-2-only fault persists would otherwise open a brand-new row instead
 * of coalescing (exactly the duplicate-spam §3.3.2 exists to prevent).
 * When the INCOMING event has no triggered rules, match instead against an
 * open row that ALSO has no triggered rules AND was itself a Tier-2-only
 * (or already-BOTH) detection — never coalesces a bare Tier-2 flag into an
 * unrelated Tier-1 row that merely has an empty rules array by accident
 * (there isn't one today, but the predictionSource check keeps it that way
 * even if one existed). On a match, predictionSource is promoted to
 * 'BOTH' only if it actually changes (a same-source extend leaves it
 * alone), and tier2FaultStatus/tier2Confidence are refreshed to the
 * incoming window's read rather than left stale at flag-open time.
 * @returns the extended row's id, or undefined if no open row matched.
 */
export async function extendOpenEvent({
  triggerWindowEnd, triggeredRules, lookbackBound, predictionSource, tier2FaultStatus, tier2Confidence,
}) {
  const result = await pool.query(
    `UPDATE fault_events
     SET "faultEnd" = $1,
         "triggerWindowEnd" = $1,
         "lastSeenWindowEnd" = $1,
         "predictionSource" = CASE WHEN "predictionSource" = $4 THEN "predictionSource" ELSE 'BOTH' END,
         "tier2FaultStatus" = COALESCE($5, "tier2FaultStatus"),
         "tier2Confidence" = COALESCE($6, "tier2Confidence")
     WHERE id = (
       SELECT fe.id FROM fault_events fe
       WHERE fe.status = 'PENDING_REVIEW'
         AND fe."lastSeenWindowEnd" >= $2
         AND (
           (
             jsonb_typeof(fe."triggeredRules") = 'array'
             AND jsonb_array_length($3::jsonb) > 0
             AND EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(fe."triggeredRules") existing
               JOIN jsonb_array_elements_text($3::jsonb) incoming ON existing = incoming
             )
           )
           OR (
             jsonb_array_length($3::jsonb) = 0
             AND (fe."triggeredRules" IS NULL OR jsonb_typeof(fe."triggeredRules") != 'array' OR jsonb_array_length(fe."triggeredRules") = 0)
             AND fe."predictionSource" IN ('TIER2_MODEL', 'BOTH')
             AND $4 IN ('TIER2_MODEL', 'BOTH')
           )
         )
       ORDER BY fe."lastSeenWindowEnd" DESC
       LIMIT 1
     )
     RETURNING id`,
    [
      triggerWindowEnd, lookbackBound, JSON.stringify(triggeredRules),
      predictionSource ?? 'TIER1_RULE', tier2FaultStatus ?? null, tier2Confidence ?? null,
    ],
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

/**
 * Candidate pool for auto-labeling (faultEventService.js's
 * findAutoLabelSource): human-reviewed ("autoLabeled" = false) CONFIRMED
 * rows whose "triggeredRules" array is the same length as the incoming
 * event's — the exact order-independent set comparison happens in JS once
 * this narrower candidate list comes back. Excluding already-auto-labeled
 * rows keeps provenance to a single hop back to a real human review, so a
 * wrong label can never silently propagate through a chain of auto-labels.
 * @returns [{ id, triggeredRules, faultType, rootCause, resolution, reviewedAt }]
 */
export async function findRecentConfirmedByRuleCount(ruleCount, limit = 50) {
  const result = await pool.query(
    `SELECT id, "triggeredRules", "faultType", "rootCause", resolution, "reviewedAt"
     FROM fault_events
     WHERE status = 'CONFIRMED'
       AND "autoLabeled" = false
       AND jsonb_typeof("triggeredRules") = 'array'
       AND jsonb_array_length("triggeredRules") = $1
     ORDER BY "reviewedAt" DESC
     LIMIT $2`,
    [ruleCount, limit],
  );
  return result.rows;
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
