// ─────────────────────────────────────────────────────────────────────────
// pdmService.test.mjs — exercises the fire-and-forget Node<->Python
// boundary (§3.4, §5.6) with a mocked global.fetch (no real pdm/ container
// required for this suite — the Python side has its own tests in
// pdm/tests/test_rules.py):
//   - a flagged verdict creates a fault_events row via faultEventService
//   - a non-flagged verdict, on the sampling cadence, banks a NEGATIVE_SAMPLE
//   - the PdM service being fully unreachable never throws synchronously and
//     never produces an unhandled promise rejection (saveAndTrigger still
//     returns and the processed_telemetry row is still stored)
//
// Run with: node --test scripts/tests/pdmService.test.mjs
// ─────────────────────────────────────────────────────────────────────────

process.env.DB_PATH = './scripts/tests/_pdmService.db';
process.env.PDM_NEGATIVE_SAMPLE_RATE = '1'; // sample every eligible window, for a deterministic test
process.env.PDM_SERVICE_URL = 'http://pdm-mock.invalid:8000';

import { test, after } from 'node:test';
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
after(() => removeDbFiles());

const { saveAndTrigger, saveProcessedReading } = await import('../../services/processedService.js');
const { onNewProcessedRecord } = await import('../../services/pdmService.js');
const faultEventService = await import('../../services/faultEventService.js');

const METRICS = ['flowRate', 'rpm', 'vibration', 'suctionPressure', 'dischargePressure', 'motorTemp'];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeProcessedRecord(windowEndIso, overrides = {}) {
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
  return { ...record, ...overrides };
}

const originalFetch = global.fetch;
function mockFetchOnce(handler) {
  global.fetch = async (url, opts) => handler(url, opts);
}
function restoreFetch() {
  global.fetch = originalFetch;
}

test('a flagged verdict creates a fault_events row', async () => {
  const data = makeProcessedRecord('2026-08-05T06:00:00.000Z');
  const stored = saveProcessedReading(data);

  mockFetchOnce(async () => ({
    ok: true,
    json: async () => ({
      flagged: true,
      confidence: 'HIGH',
      triggeredRules: ['vibration.stdDev'],
      metric: 'vibration',
      windowEnd: data.windowEnd,
      thresholdsVersion: '1',
    }),
  }));

  onNewProcessedRecord(data, stored.id);
  await wait(50);
  restoreFetch();

  const events = faultEventService.listFaultEvents('PENDING_REVIEW');
  const created = events.find((e) => e.processedTelemetryId === stored.id);
  assert.ok(created, 'expected a PENDING_REVIEW fault_events row linked to this window');
  assert.equal(created.confidence, 'HIGH');
});

test('a non-flagged verdict on the sampling cadence banks a NEGATIVE_SAMPLE row', async () => {
  const data = makeProcessedRecord('2026-08-05T07:00:00.000Z');
  const stored = saveProcessedReading(data);

  mockFetchOnce(async () => ({
    ok: true,
    json: async () => ({
      flagged: false,
      confidence: null,
      triggeredRules: [],
      metric: null,
      windowEnd: data.windowEnd,
      thresholdsVersion: '1',
    }),
  }));

  onNewProcessedRecord(data, stored.id);
  await wait(50);
  restoreFetch();

  const events = faultEventService.listFaultEvents();
  const sample = events.find((e) => e.processedTelemetryId === stored.id && e.eventType === 'NEGATIVE_SAMPLE');
  assert.ok(sample, 'expected a NEGATIVE_SAMPLE row for this window');
  assert.equal(sample.status, 'N/A');
});

test('the PdM service being fully down never throws synchronously and never produces an unhandled rejection', async () => {
  let unhandled = null;
  const onUnhandledRejection = (err) => { unhandled = err; };
  process.on('unhandledRejection', onUnhandledRejection);

  mockFetchOnce(async () => {
    throw new Error('simulated: PdM service unreachable');
  });

  const data = makeProcessedRecord('2026-08-05T08:00:00.000Z');

  // saveAndTrigger must return successfully and store the processed record
  // even though the fire-and-forget PdM call is guaranteed to reject.
  const record = saveAndTrigger(data);
  assert.ok(record && record.id, 'expected saveAndTrigger to return the stored record');

  await wait(50);
  restoreFetch();
  process.off('unhandledRejection', onUnhandledRejection);

  assert.equal(unhandled, null, `expected no unhandled promise rejection, got: ${unhandled}`);
});
