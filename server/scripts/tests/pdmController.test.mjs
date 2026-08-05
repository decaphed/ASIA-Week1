// ─────────────────────────────────────────────────────────────────────────
// pdmController.test.mjs — exercises the HITL review HTTP endpoints (§3.6)
// against a real listening createApp() instance and real fetch calls,
// standing up the "spin up the Express app + hit routes" pattern this repo
// didn't have before (§4.5).
//
// Run with: node --test scripts/tests/pdmController.test.mjs
// ─────────────────────────────────────────────────────────────────────────

process.env.DB_PATH = './scripts/tests/_pdmController.db';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';

function removeDbFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = process.env.DB_PATH + suffix;
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // Windows may still hold the main DB file open — see faultEventService.test.mjs.
    }
  }
}
removeDbFiles();

const { createApp } = await import('../../app.js');
const { saveProcessedReading } = await import('../../services/processedService.js');
const faultEventService = await import('../../services/faultEventService.js');

const METRICS = ['flowRate', 'rpm', 'vibration', 'suctionPressure', 'dischargePressure', 'motorTemp'];

function makeProcessedRecord(windowEndIso) {
  const record = {
    windowStart: new Date(Date.parse(windowEndIso) - 60_000).toISOString(),
    windowEnd: windowEndIso,
    timestamp: windowEndIso,
    dominantStatus: 'RUNNING',
    dominantFaultType: null,
    runningSeconds: 60,
    faultSeconds: 0,
    stoppedSeconds: 0,
    sampleCount: 60,
    expectedSampleCount: 60,
    missingSampleCount: 0,
    imputedSampleCount: 0,
    outlierCount: 0,
    outliersByMetric: {},
    physicsViolationCount: 0,
    violationsByMetric: {},
    physicsImputedCount: 0,
    precapFeaturesByMetric: Object.fromEntries(
      METRICS.map((m) => [m, { rawStdDev: 0.1, rawRateOfChange: 0.01, rawMaxExcursion: 0.2 }]),
    ),
    missingRate: 0,
    imputationRate: 0,
    physicsImputationRate: 0,
    outlierRate: 0,
    physicsPassRate: 1,
    qualityScore: 100,
    qualityLabel: 'GOOD',
    isImputed: 0,
    lateSampleCount: 0,
    mergedSampleCount: 0,
    duplicateSampleCount: 0,
    partiallyImputedCount: 0,
    partiallyImputedRate: 0,
    abnormalOperationSampleCount: 0,
    preprocessingVersion: 'v2',
    preprocessingTimestamp: new Date().toISOString(),
  };
  for (const metric of METRICS) {
    record[`${metric}Mean`] = 100;
    record[`${metric}Median`] = 100;
    record[`${metric}Min`] = 90;
    record[`${metric}Max`] = 110;
    record[`${metric}StdDev`] = 1;
    record[`${metric}Last`] = 100;
  }
  return record;
}

let server;
let baseUrl;

before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  removeDbFiles();
});

test('GET /api/pdm/fault-events lists PENDING_REVIEW events and GET /:id returns one with a bufferSampleCount', async () => {
  const data = makeProcessedRecord('2026-08-05T09:00:00.000Z');
  const stored = saveProcessedReading(data);
  const { id } = faultEventService.recordFlaggedEvent(data, stored.id, {
    confidence: 'MEDIUM',
    triggeredRules: ['rpm.stdDev'],
    thresholdsVersion: '1',
  });

  const listRes = await fetch(`${baseUrl}/api/pdm/fault-events?status=PENDING_REVIEW`);
  const listBody = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.ok(listBody.data.some((e) => e.id === id));

  const getRes = await fetch(`${baseUrl}/api/pdm/fault-events/${id}`);
  const getBody = await getRes.json();
  assert.equal(getRes.status, 200);
  assert.equal(getBody.data.id, id);
  assert.equal(typeof getBody.data.bufferSampleCount, 'number');
});

test('GET /api/pdm/fault-events/:id returns 404 for an unknown id', async () => {
  const res = await fetch(`${baseUrl}/api/pdm/fault-events/999999`);
  assert.equal(res.status, 404);
});

test('PATCH /api/pdm/fault-events/:id confirms an event and finalizes bufferEnd = faultEnd + 1h', async () => {
  const data = makeProcessedRecord('2026-08-05T10:00:00.000Z');
  const stored = saveProcessedReading(data);
  const { id } = faultEventService.recordFlaggedEvent(data, stored.id, {
    confidence: 'LOW',
    triggeredRules: ['flowRate.min'],
    thresholdsVersion: '1',
  });

  const faultEnd = '2026-08-05T10:05:00.000Z';
  const res = await fetch(`${baseUrl}/api/pdm/fault-events/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'CONFIRMED', faultType: 'BEARING', rootCause: 'worn bearing', resolution: 'replaced', reviewedBy: 'tester', faultEnd }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.data.status, 'CONFIRMED');
  assert.equal(body.data.bufferEnd, new Date(Date.parse(faultEnd) + 60 * 60 * 1000).toISOString());

  // Now out of the PENDING_REVIEW list.
  const pendingRes = await fetch(`${baseUrl}/api/pdm/fault-events?status=PENDING_REVIEW`);
  const pendingBody = await pendingRes.json();
  assert.ok(!pendingBody.data.some((e) => e.id === id));
});

test('GET /api/pdm/fault-events/stats returns confidence/status counts', async () => {
  const res = await fetch(`${baseUrl}/api/pdm/fault-events/stats`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(typeof body.data, 'object');
});
