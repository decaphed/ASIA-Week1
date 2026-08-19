// ─────────────────────────────────────────────────────────────────────────
// externalUploadModel.js — the ONLY place that contains SQL for
// external_uploads (§10.4 Entry point 2, 006_external_uploads.sql).
// ─────────────────────────────────────────────────────────────────────────

import pool from '../database/db.js';

/**
 * @param record { originalFilename, uploadedBy, stagedRows, stageAResult }
 * @returns { id }
 */
export async function insertUpload(record) {
  const result = await pool.query(
    `INSERT INTO external_uploads
      ("originalFilename", "uploadedBy", "stagedRows", "stageAResult")
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [record.originalFilename, record.uploadedBy, JSON.stringify(record.stagedRows), JSON.stringify(record.stageAResult)],
  );
  return { id: result.rows[0].id };
}

/** @returns a single external_uploads row by id, or undefined. */
export async function getUploadById(id) {
  const result = await pool.query('SELECT * FROM external_uploads WHERE id = $1', [id]);
  return result.rows[0];
}

/**
 * Move an upload to a terminal state (ACCEPTED or any *_REJECTED) and
 * clear stagedRows — nothing needs the raw uploaded content after a
 * terminal decision (design review D18).
 */
export async function finalizeUpload(id, fields) {
  await pool.query(
    `UPDATE external_uploads SET
       "status" = $1, "columnMapping" = $2, "faultType" = $3, "rootCause" = $4,
       "resolution" = $5, "notes" = $6, "qualityScore" = $7, "physicsPassRate" = $8,
       "imputationRate" = $9, "outlierRate" = $10, "windowCount" = $11,
       "rejectedReason" = $12, "stagedRows" = NULL, "updatedAt" = now()
     WHERE id = $13`,
    [
      fields.status, JSON.stringify(fields.columnMapping ?? null), fields.faultType ?? null,
      fields.rootCause ?? null, fields.resolution ?? null, fields.notes ?? null,
      fields.qualityScore ?? null, fields.physicsPassRate ?? null, fields.imputationRate ?? null,
      fields.outlierRate ?? null, fields.windowCount ?? null, fields.rejectedReason ?? null, id,
    ],
  );
}

/** @returns ids + uploadedAt of AWAITING_MAPPING uploads older than the given ISO cutoff — used by cleanupStaleUploads.js. */
export async function getStaleAwaitingMapping(beforeIso) {
  const result = await pool.query(
    `SELECT id, "uploadedAt" FROM external_uploads WHERE "status" = 'AWAITING_MAPPING' AND "uploadedAt" < $1`,
    [beforeIso],
  );
  return result.rows;
}

/** Clears stagedRows for an abandoned AWAITING_MAPPING upload without marking it terminal (still visible in history as an audit trail, just no longer holding the raw content). */
export async function purgeStagedRows(id) {
  await pool.query('UPDATE external_uploads SET "stagedRows" = NULL, "updatedAt" = now() WHERE id = $1', [id]);
}
