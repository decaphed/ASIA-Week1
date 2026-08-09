// ─────────────────────────────────────────────────────────────────────────
// backfillHistoricalFeatures.js — one-time (idempotent, re-runnable) backfill
// of historicalFeaturesByMetric for every existing processed_telemetry row.
//
// New rows get this column populated automatically at ingest time (see
// processedService.js::saveProcessedReading), but rows written before that
// wiring existed have it NULL. Fault-prediction training needs it on the
// whole history, not just rows going forward, so this script recomputes it
// causally over everything already stored.
//
// Run with: node server/scripts/backfillHistoricalFeatures.js
// ─────────────────────────────────────────────────────────────────────────

import pool from '../database/db.js';
import { withTransaction } from '../database/withTransaction.js';
import { getAllProcessedChronological, updateHistoricalFeatures } from '../models/processedModel.js';
import { computeHistoricalFeatures } from '../preprocessing/historicalFeatures.js';
import { logger } from '../utils/logger.js';

async function main() {
  const rows = await getAllProcessedChronological();
  console.log(`Recomputing historicalFeaturesByMetric for ${rows.length} processed_telemetry row(s)...`);

  const results = computeHistoricalFeatures(rows);

  await withTransaction(async (client) => {
    for (const item of results) {
      // Pass the object directly — pg serialises to jsonb; JSON.stringify
      // here would double-encode it.
      await updateHistoricalFeatures(item.id, item.historicalFeaturesByMetric, client);
    }
  });

  logger.info(`Backfilled historicalFeaturesByMetric for ${results.length} processed_telemetry row(s).`);
  console.log(`Done. Backfilled ${results.length} row(s).`);
}

try {
  await main();
} finally {
  await pool.end();
}
