// ─────────────────────────────────────────────────────────────────────────
// faultEventService.manualBuffer.test.mjs — exercises
// faultEventService.js::createManualBufferEvent (§10.4 Entry point 1)
// directly, with the model/service layer mocked via node:test's
// mock.module() — same pattern pipelineProcessWindow.test.mjs uses, so no
// live Postgres/pdm connection is needed to run this suite.
//
// Requires Node's --experimental-test-module-mocks flag (module mocking is
// still experimental as of Node 24) — run explicitly:
//   node --experimental-test-module-mocks --test scripts/tests/faultEventService.manualBuffer.test.mjs
//
// Covers:
//   1. Path A — an existing processed_telemetry row covers the resolved
//      window: reused directly, no /process-window call, correct
//      featureSnapshot/processedTelemetryId/sourceType/status.
//   2. Path B — no existing row: reconstructs via a mocked /process-window
//      call, persists via saveProcessedReading (asserted NOT saveAndTrigger
//      — the mock only exports saveProcessedReading, so an accidental call
//      to saveAndTrigger would throw and fail the test), and captures
//      tier1Verdict.thresholdsVersion rather than discarding it.
//   3. Overlap conflict -> Error with .status 409.
//   4. No raw_telemetry data in range -> Error with .status 422.
//   5. An explicit triggerWindowEnd outside [faultStart, faultEnd] -> Error
//      with .status 400 (the bounds-check safety net, not just trusting
//      the resolution query).
// ─────────────────────────────────────────────────────────────────────────

import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const METRICS = ['flowRate', 'rpm', 'vibration', 'suctionPressure', 'dischargePressure', 'motorTemp'];

function makeProcessedRecord(windowEndIso, overrides = {}) {
  const record = {
    id: 4242,
    windowStart: new Date(Date.parse(windowEndIso) - 60_000).toISOString(),
    windowEnd: windowEndIso,
    timestamp: windowEndIso,
    dominantStatus: 'FAULT',
    dominantFaultType: 'BEARING',
    precapFeaturesByMetric: Object.fromEntries(
      METRICS.map((m) => [m, { rawStdDev: 0.1, rawRateOfChange: 0.01, rawMaxExcursion: 0.2 }]),
    ),
    preprocessingVersion: 'v3-py',
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

function makeRawSample(timestamp, overrides = {}) {
  return {
    timestamp,
    status: 'FAULT',
    faultType: 'BEARING',
    flowRate: 100,
    rpm: 1500,
    vibration: 8,
    suctionPressure: 3,
    dischargePressure: 8,
    motorTemp: 70,
    ...overrides,
  };
}

const VALID_BODY = {
  faultStart: '2026-08-10T02:00:00.000Z',
  faultEnd: '2026-08-10T02:03:00.000Z', // 3 minutes — >= one window, well under the default 168h cap
  faultType: 'BEARING',
  rootCause: 'worn bearing',
  resolution: 'replaced bearing',
  notes: 'operator noticed elevated vibration on the dashboard after the fact',
};

let insertedRecords;
let insertedFaultEventRow;
let overlapResult;
let processedByWindowEndResult;
let countInRangeResult;
let rangeChronologicalResult;
let lastBeforeResult;
let saveProcessedReadingCalls;
let fetchCalls;
let originalFetch;

beforeEach(() => {
  insertedRecords = [];
  saveProcessedReadingCalls = [];
  fetchCalls = [];
  overlapResult = [];
  processedByWindowEndResult = undefined;
  countInRangeResult = 60;
  rangeChronologicalResult = [];
  lastBeforeResult = undefined;
  insertedFaultEventRow = null;

  mock.module('../../models/faultEventModel.js', {
    namedExports: {
      findOverlappingFaultEvents: async () => overlapResult,
      insertFaultEvent: async (record) => {
        insertedRecords.push(record);
        insertedFaultEventRow = { id: 777, ...record };
        return { lastInsertRowid: 777 };
      },
      getFaultEventById: async (id) => (insertedFaultEventRow && insertedFaultEventRow.id === id ? insertedFaultEventRow : undefined),
      getBufferRange: async () => [],
    },
  });

  mock.module('../../models/processedModel.js', {
    namedExports: {
      getProcessedByWindowEnd: async () => processedByWindowEndResult,
      // Not exercised by these tests, but forecastModel.js (pulled in
      // transitively via faultEventService.js's `import { METRICS } from
      // './forecastService.js'`) imports this at module-load time — ESM's
      // static export check fails the whole import if it's missing from
      // the mock, even though nothing here ever calls it.
      getRecentProcessed: async () => [],
    },
  });

  mock.module('../../models/sensorModel.js', {
    namedExports: {
      getCountInRange: async () => countInRangeResult,
      getRangeChronological: async () => rangeChronologicalResult,
      getLastBefore: async () => lastBeforeResult,
    },
  });

  // Deliberately export ONLY saveProcessedReading — if createManualBufferEvent
  // ever called saveAndTrigger (the live-ingest path, which would wrongly
  // re-fire forecast/drift/trend for a historical backfill), this mock has
  // no such export and the call throws, failing the test loudly.
  mock.module('../../services/processedService.js', {
    namedExports: {
      saveProcessedReading: async (data) => {
        const row = { id: 999, ...data };
        saveProcessedReadingCalls.push(data);
        return row;
      },
    },
  });

  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  mock.reset();
});

test('Path A: an existing processed_telemetry row covering the window is reused, no /process-window call made', async () => {
  const windowEnd = '2026-08-10T02:03:00.000Z'; // aligned to a 60s boundary, latest <= faultEnd
  processedByWindowEndResult = makeProcessedRecord(windowEnd, { id: 555 });
  global.fetch = async () => { throw new Error('must not be called on Path A'); };

  const { createManualBufferEvent } = await import('../../services/faultEventService.js');
  const result = await createManualBufferEvent(VALID_BODY, 'tester');

  assert.equal(insertedRecords.length, 1);
  const record = insertedRecords[0];
  assert.equal(record.processedTelemetryId, 555);
  assert.equal(record.sourceType, 'MANUAL_BUFFER');
  assert.equal(record.eventType, 'FLAGGED');
  assert.equal(record.status, 'CONFIRMED');
  assert.equal(record.faultType, 'BEARING');
  assert.equal(record.rootCause, 'worn bearing');
  assert.equal(record.notes, VALID_BODY.notes);
  assert.equal(record.reviewedBy, 'tester');
  assert.equal(record.triggeredRules, null);
  assert.equal(record.confidence, null);

  const snapshot = JSON.parse(record.featureSnapshot);
  assert.equal(Object.keys(snapshot.precapFeaturesByMetric).length, 6);
  assert.equal(Object.keys(snapshot.metricStats).length, 6);

  assert.equal(saveProcessedReadingCalls.length, 0, 'Path A must not persist a new processed_telemetry row');
  assert.equal(result.id, 777);
});

test('Path B: no existing row reconstructs via /process-window, persists via saveProcessedReading (not saveAndTrigger), and captures thresholdsVersion', async () => {
  processedByWindowEndResult = undefined; // forces Path B
  rangeChronologicalResult = Array.from({ length: 60 }, (_, i) =>
    makeRawSample(new Date(Date.parse('2026-08-10T02:02:00.000Z') + i * 1000).toISOString()));
  lastBeforeResult = makeRawSample('2026-08-10T02:01:59.000Z');

  // No `id` field here, deliberately — a genuine Python /process-window
  // response never has one (that's the whole reason saveProcessedReading
  // needs to run: to get one from the DB). Reusing makeProcessedRecord's
  // default `id: 4242` here would mask processedService.js's own
  // `{ id: info.lastInsertRowid, ...record }` ordering (record.id, if
  // present, would win) — Path B must derive processedTelemetryId from
  // the insert, never from the payload.
  const { id: _unused, ...processedRecord } = makeProcessedRecord('2026-08-10T02:03:00.000Z');
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, body: JSON.parse(opts.body) });
    return {
      ok: true,
      json: async () => ({
        processedRecord,
        tier1Verdict: { flagged: true, confidence: 'HIGH', triggeredRules: ['vibration.rateOfChange'], thresholdsVersion: '3' },
      }),
    };
  };

  const { createManualBufferEvent } = await import('../../services/faultEventService.js');
  await createManualBufferEvent(VALID_BODY, 'tester');

  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.endsWith('/process-window'));
  assert.equal(fetchCalls[0].body.windowSamples.length, 60);
  assert.ok(fetchCalls[0].body.prevSample, 'expected a prevSample for gap-fill continuity');

  assert.equal(saveProcessedReadingCalls.length, 1, 'Path B must persist via saveProcessedReading');

  assert.equal(insertedRecords.length, 1);
  const record = insertedRecords[0];
  assert.equal(record.processedTelemetryId, 999); // saveProcessedReadingCalls mock returns id: 999
  assert.equal(record.thresholdsVersion, '3', 'thresholdsVersion from the just-computed tier1Verdict must be captured, not discarded');
});

test('an overlapping existing fault event rejects with .status 409 and does not insert', async () => {
  overlapResult = [{ id: 42, status: 'CONFIRMED', faultType: 'CAVITATION' }];

  const { createManualBufferEvent } = await import('../../services/faultEventService.js');
  await assert.rejects(
    () => createManualBufferEvent(VALID_BODY, 'tester'),
    (err) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /#42/);
      return true;
    },
  );
  assert.equal(insertedRecords.length, 0);
});

test('no raw_telemetry data in the requested range rejects with .status 422 and does not insert', async () => {
  countInRangeResult = 0;

  const { createManualBufferEvent } = await import('../../services/faultEventService.js');
  await assert.rejects(
    () => createManualBufferEvent(VALID_BODY, 'tester'),
    (err) => {
      assert.equal(err.status, 422);
      return true;
    },
  );
  assert.equal(insertedRecords.length, 0);
});

test('an explicit triggerWindowEnd outside [faultStart, faultEnd] rejects with .status 400 and does not insert', async () => {
  const body = { ...VALID_BODY, triggerWindowEnd: '2026-08-10T05:00:00.000Z' }; // hours past faultEnd

  const { createManualBufferEvent } = await import('../../services/faultEventService.js');
  await assert.rejects(
    () => createManualBufferEvent(body, 'tester'),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /does not overlap/);
      return true;
    },
  );
  assert.equal(insertedRecords.length, 0);
});
