// ─────────────────────────────────────────────────────────────────────────
// One-off manual integration check (not part of the node:test suite) for
// dominantFaultType, exercising the REAL end-to-end path: processSample()
// -> aggregateWindow() -> processedService.saveAndTrigger() ->
// processedModel.insertProcessed() -> DB -> processedService.getRecent().
// Run with: node scripts/tests/_dominantFaultType.integration.mjs
// Uses an isolated on-disk DB file (via DB_PATH) so it never touches the
// real server/data.db.
// ─────────────────────────────────────────────────────────────────────────

process.env.DB_PATH = './scripts/tests/_integration.db';

import { unlinkSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';

if (existsSync(process.env.DB_PATH)) unlinkSync(process.env.DB_PATH);

const { processSample } = await import('../../preprocessing/pipeline.js');
const { getRecentProcessed } = await import('../../models/processedModel.js');

const BASE = { flowRate: 150, rpm: 2000, vibration: 3, suctionPressure: 2, dischargePressure: 7, motorTemp: 50 };
const startMs = Date.UTC(2026, 0, 1, 0, 0, 0); // aligned to a minute boundary

// 60 samples inside minute 0: first 55 RUNNING, last 5 FAULT/BEARING.
for (let i = 0; i < 60; i++) {
  const status = i >= 55 ? 'FAULT' : 'RUNNING';
  const faultType = i >= 55 ? 'BEARING' : null;
  processSample({
    ...BASE,
    status,
    faultType,
    timestamp: new Date(startMs + i * 1000).toISOString(),
  });
}
// One more sample in the next minute to force-close window 0.
processSample({ ...BASE, status: 'RUNNING', faultType: null, timestamp: new Date(startMs + 60_000).toISOString() });

const rows = getRecentProcessed(5);
const closedRow = rows.find((r) => r.windowStart === new Date(startMs).toISOString());
assert.ok(closedRow, 'expected window 0 to have closed and been persisted');
assert.equal(closedRow.dominantFaultType, 'BEARING', `expected dominantFaultType 'BEARING', got ${closedRow.dominantFaultType}`);

console.log('PASS: dominantFaultType round-tripped through processSample -> DB ->', closedRow.dominantFaultType);

unlinkSync(process.env.DB_PATH);
if (existsSync(process.env.DB_PATH + '-wal')) unlinkSync(process.env.DB_PATH + '-wal');
if (existsSync(process.env.DB_PATH + '-shm')) unlinkSync(process.env.DB_PATH + '-shm');
