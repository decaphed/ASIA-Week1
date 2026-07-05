// ─────────────────────────────────────────────────────────────────────────
// forecastController.js — handles GET /api/forecast.
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/forecastService.js';

export function getForecast(req, res, next) {
  try {
    const data = service.getForecast();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
