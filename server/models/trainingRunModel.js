// ─────────────────────────────────────────────────────────────────────────
// trainingRunModel.js — the ONLY place that contains SQL for training_runs
// (§10.5's champion/challenger bookkeeping, 005_training_corpus.sql).
//
// Node owns every write here, same as fault_events/training_corpus —
// pdm/app/retrain.py computes a RetrainResult and hands it to
// server/scripts/recordTrainingRun.js, which calls insertRun() below. This
// keeps Python strictly read-only against Postgres (§3.4's invariant):
// retrain.py never opens a write connection, it only ever reads the corpus
// and the current champion via its own read-only role.
// ─────────────────────────────────────────────────────────────────────────

import pool from '../database/db.js';

/**
 * @param record { corpusContentHash, corpusRowManifest, corpusRowCount,
 *   trainedAt, metrics, artifactPath, promoted, promotionReason,
 *   championRunIdAtEval }
 * @returns { id }
 */
export async function insertRun(record) {
  const result = await pool.query(
    `INSERT INTO training_runs
      ("corpusContentHash", "corpusRowManifest", "corpusRowCount", "trainedAt",
       "metrics", "artifactPath", "promoted", "promotionReason", "championRunIdAtEval")
     VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      record.corpusContentHash, record.corpusRowManifest, record.corpusRowCount, record.trainedAt,
      record.metrics, record.artifactPath ?? null, record.promoted, record.promotionReason,
      record.championRunIdAtEval ?? null,
    ],
  );
  return { id: result.rows[0].id };
}

/** @returns the current champion run (the most recently promoted one), or undefined if none yet. */
export async function getChampion() {
  const result = await pool.query(
    'SELECT * FROM training_runs WHERE "promoted" = true ORDER BY id DESC LIMIT 1',
  );
  return result.rows[0];
}

/** @returns up to n most recent training runs, newest first. */
export async function listRuns(n = 50) {
  const result = await pool.query('SELECT * FROM training_runs ORDER BY id DESC LIMIT $1', [n]);
  return result.rows;
}
