// ─────────────────────────────────────────────────────────────────────────
// summaryController.js — handles GET /api/summary.
//
// A management roll-up of a time window: availability, real run-time,
// per-sensor min/max/avg, and distinct excursion counts. The only input is
// ?range=24h|7d (default 24h); an unknown range is a 400 in the shared
// { success:false, error } shape.
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/summaryService.js';

export function getSummary(req, res, next) {
  try {
    const range = req.query.range ?? service.DEFAULT_SUMMARY_RANGE;
    if (!service.isValidSummaryRange(range)) {
      return res.status(400).json({
        success: false,
        error: `Invalid range '${range}'. Use one of: 24h, 7d.`,
      });
    }

    const data = service.getSummary(range);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
