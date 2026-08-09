// ─────────────────────────────────────────────────────────────────────────
// healthController.js — handles GET /api/health.
//
// The dashboard polls this to light up its status indicators:
//   • Backend indicator  → this endpoint responding at all.
//   • Database indicator → the `database` field below.
//   • Node-RED indicator → derived on the client from `lastReadingAt`
//     freshness (if the newest reading is only a few seconds old, data is
//     still flowing in, so Node-RED must be alive).
// ─────────────────────────────────────────────────────────────────────────

import { isDatabaseHealthy } from '../database/db.js';
import * as service from '../services/sensorService.js';

const startedAt = Date.now();

export async function getHealth(req, res) {
  const dbOk = await isDatabaseHealthy();
  const latest = dbOk ? await service.getLatestReading() : null;

  res.status(dbOk ? 200 : 503).json({
    success: dbOk,
    status: dbOk ? 'ok' : 'degraded',
    database: dbOk ? 'connected' : 'unavailable',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    lastReadingAt: latest ? latest.timestamp : null,
    serverTime: new Date().toISOString(),
  });
}
