// ─────────────────────────────────────────────────────────────────────────
// trendController.js — handles GET /api/trend.
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/trendService.js';

export function getTrend(req, res, next) {
  try {
    const data = service.getTrend();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
