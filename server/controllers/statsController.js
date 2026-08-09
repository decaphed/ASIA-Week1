// ─────────────────────────────────────────────────────────────────────────
// statsController.js — handles GET /api/stats.
//
// Combines aggregate database statistics (counts, averages, latest time) with
// the live API-latency figure captured by the requestTimer middleware.
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/sensorService.js';
import { getLastLatencyMs } from '../middleware/requestTimer.js';

export async function getStats(req, res, next) {
  try {
    const stats = await service.getStatistics();
    res.json({
      success: true,
      data: {
        ...stats,
        apiLatencyMs: getLastLatencyMs(), // bonus metric
      },
    });
  } catch (err) {
    next(err);
  }
}
