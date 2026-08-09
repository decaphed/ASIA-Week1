// ─────────────────────────────────────────────────────────────────────────
// historyController.js — handles GET /api/history.
//
// Supports pagination + sorting via query string:
//   ?page=1&limit=100&sort=desc
// We defensively parse and clamp these values so bad input can never crash the
// query or request a million rows.
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/sensorService.js';

const DEFAULT_LIMIT = 100; // spec: "return the latest 100 readings"
const MAX_LIMIT = 1000; // safety ceiling

export async function getHistory(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT)
    );
    // Only two valid sort values; anything else falls back to 'desc' (newest).
    const sort = req.query.sort === 'asc' ? 'asc' : 'desc';

    const result = await service.getHistoryPage({ page, limit, sort });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}
