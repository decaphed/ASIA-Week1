// ─────────────────────────────────────────────────────────────────────────
// liveController.js — handles GET /api/live (the newest reading).
//
// Polled by the React dashboard once per second to drive the live cards and
// charts. Returns data:null (not an error) when no readings exist yet, so a
// freshly-started system renders cleanly.
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/sensorService.js';

export async function getLive(req, res, next) {
  try {
    const reading = await service.getLatestReading();

    if (!reading) {
      return res.json({ success: true, data: null, message: 'No readings yet' });
    }

    res.json({ success: true, data: reading });
  } catch (err) {
    next(err);
  }
}
