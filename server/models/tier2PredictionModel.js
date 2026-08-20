// ─────────────────────────────────────────────────────────────────────────
// tier2PredictionModel.js — the ONLY place that contains SQL for
// tier2_predictions (§14.6.2/D36, 007_tier2_predictions.sql).
//
// The every-window Tier 2 log: one row per closed window that was actually
// scored by a loaded model (verdict.tier2Label present), independent of
// whether that window ever gets a fault_events row (§15.3's correction —
// most windows never do). §14.6.1's monitoring reads from here.
// ─────────────────────────────────────────────────────────────────────────

import pool from '../database/db.js';

/**
 * @param record { processedTelemetryId, predictedLabel, probability,
 *   modelRunId, artifactSha256 }
 * @returns { id }
 */
export async function insertPrediction(record) {
  const result = await pool.query(
    `INSERT INTO tier2_predictions
      ("processedTelemetryId", "predictedLabel", "probability", "modelRunId", "artifactSha256")
     VALUES
      ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      record.processedTelemetryId, record.predictedLabel, record.probability,
      record.modelRunId ?? null, record.artifactSha256 ?? null,
    ],
  );
  return { id: result.rows[0]?.id };
}
