// ─────────────────────────────────────────────────────────────────────────
// corpusModel.js — the ONLY place that contains SQL for training_corpus
// (§10.5). Same convention as faultEventModel.js: every camelCase column
// name is double-quoted, values always bound as $1, $2, …
// ─────────────────────────────────────────────────────────────────────────

import pool from '../database/db.js';

/**
 * Upsert one corpus row, keyed on (bufferId, windowEnd). A conflicting row
 * is only updated when the incoming sourceUpdatedAt is strictly newer than
 * the stored one — an out-of-order/stale re-materialization (e.g. replaying
 * an older HITL confirm after a newer one already landed) is a no-op, not
 * an error, but IS distinguishable from a real insert/update: Postgres
 * returns no row from RETURNING when the conditional DO UPDATE's WHERE
 * clause evaluates false, so `result.rows.length === 0` means "conflict
 * existed, skipped as stale" — the caller should log this rather than treat
 * every call as unconditionally successful (flagged in design review: a
 * silently-skipped stale write can mask real event-ordering bugs).
 * @returns { id } on insert/update, or null if skipped as stale.
 */
export async function upsertRow(record) {
  const result = await pool.query(
    `INSERT INTO training_corpus
      ("bufferId", "faultEventId", "windowEnd", "featureSnapshot", "featureCodeVersion",
       "label", "eventType", "sourceType", "thresholdsVersion",
       "uploadId", "uploadedAt", "uploadedBy", "sourceUpdatedAt", "corpusRowVersion")
     VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1)
     ON CONFLICT ("bufferId", "windowEnd") DO UPDATE SET
       "faultEventId" = EXCLUDED."faultEventId",
       "featureSnapshot" = EXCLUDED."featureSnapshot",
       "featureCodeVersion" = EXCLUDED."featureCodeVersion",
       "label" = EXCLUDED."label",
       "eventType" = EXCLUDED."eventType",
       "sourceType" = EXCLUDED."sourceType",
       "thresholdsVersion" = EXCLUDED."thresholdsVersion",
       "uploadId" = EXCLUDED."uploadId",
       "uploadedAt" = EXCLUDED."uploadedAt",
       "uploadedBy" = EXCLUDED."uploadedBy",
       "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt",
       "corpusRowVersion" = training_corpus."corpusRowVersion" + 1
     WHERE training_corpus."sourceUpdatedAt" < EXCLUDED."sourceUpdatedAt"
     RETURNING id`,
    [
      record.bufferId, record.faultEventId, record.windowEnd, record.featureSnapshot, record.featureCodeVersion,
      record.label, record.eventType, record.sourceType, record.thresholdsVersion ?? null,
      record.uploadId ?? null, record.uploadedAt ?? null, record.uploadedBy ?? null, record.sourceUpdatedAt,
    ],
  );
  return result.rows[0] ? { id: result.rows[0].id } : null;
}

/** @returns every corpus row for one bufferId, chronological. */
export async function getByBuffer(bufferId) {
  const result = await pool.query(
    'SELECT * FROM training_corpus WHERE "bufferId" = $1 ORDER BY "windowEnd" ASC',
    [bufferId],
  );
  return result.rows;
}

/** Remove every corpus row for one bufferId — used when a confirmed event is later corrected/rejected. */
export async function deleteByBuffer(bufferId) {
  await pool.query('DELETE FROM training_corpus WHERE "bufferId" = $1', [bufferId]);
}

/**
 * Removes every training_corpus row materialized from one external upload
 * — the EXTERNAL_UPLOAD equivalent of deleteByBuffer, needed because an
 * upload's rows span many bufferIds ("upload:<uploadId>:<windowIndex>",
 * one per window), not a single one like a fault_events-sourced buffer.
 */
export async function deleteByUploadId(uploadId) {
  await pool.query('DELETE FROM training_corpus WHERE "uploadId" = $1', [uploadId]);
}

/** @returns [{ label, count }] — the whole-corpus class balance (§10.5's post-merge check). */
export async function getClassBalance() {
  const result = await pool.query(
    'SELECT "label", COUNT(*) AS count FROM training_corpus GROUP BY "label"',
  );
  return result.rows.map((row) => ({ label: row.label, count: Number(row.count) }));
}

/** @returns total number of corpus rows. */
export async function getRowCount() {
  const result = await pool.query('SELECT COUNT(*) AS count FROM training_corpus');
  return Number(result.rows[0].count);
}
