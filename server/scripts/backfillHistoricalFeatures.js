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

import db from '../database/db.js';
import { getAllProcessedChronological, updateHistoricalFeatures } from '../models/processedModel.js';
import { computeHistoricalFeatures } from '../preprocessing/historicalFeatures.js';
import { logger } from '../utils/logger.js';

const rows = getAllProcessedChronological();
console.log(`Recomputing historicalFeaturesByMetric for ${rows.length} processed_telemetry row(s)...`);

const results = computeHistoricalFeatures(rows);

const runAll = db.transaction((items) => {
  for (const item of items) {
    updateHistoricalFeatures(item.id, JSON.stringify(item.historicalFeaturesByMetric));
  }
});
runAll(results);

logger.info(`Backfilled historicalFeaturesByMetric for ${results.length} processed_telemetry row(s).`);
console.log(`Done. Backfilled ${results.length} row(s).`);
