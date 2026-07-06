// ─────────────────────────────────────────────────────────────────────────
// driftController.js — handles GET /api/drift.
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/driftService.js';

export function getDrift(req, res, next) {
  try {
    const data = service.getDrift();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
