// ─────────────────────────────────────────────────────────────────────────
// seriesController.js — handles GET /api/history/series.
//
// Returns a downsampled per-metric time series for the trend charts. The only
// input is ?range=1h|8h|24h|7d (default 24h); an unknown range is a 400 in the
// same { success:false, error } shape errorHandler.js produces.
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/summaryService.js';

export function getSeries(req, res, next) {
  try {
    const range = req.query.range ?? service.DEFAULT_SERIES_RANGE;
    if (!service.isValidSeriesRange(range)) {
      return res.status(400).json({
        success: false,
        error: `Invalid range '${range}'. Use one of: 1h, 8h, 24h, 7d.`,
      });
    }

    const data = service.getSeries(range);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
