// ─────────────────────────────────────────────────────────────────────────
// pipelineProcessWindow.test.mjs — verifies pipeline.js's Phase 3 rewire
// (docs/plan/2026-08-05-pdm-implementation.md §11.6.3) without needing a
// live Postgres connection: sensorService/processedService are mocked via
// node:test's module mocking, and global fetch is mocked to stand in for
// the Python pdm/ service.
//
// Requires Node's --experimental-test-module-mocks flag (module mocking is
// still experimental as of Node 24) — not wired into the default `npm test`
// glob for that reason; run explicitly:
//   node --experimental-test-module-mocks --test scripts/tests/pipelineProcessWindow.test.mjs
//
// Covers the two things §11.6.5/§11.7 call out as load-bearing for this
// cutover and that a live-DB integration test can't easily isolate:
//   1. Lock scoping — a slow /process-window call for one window-closing
//      request must NOT block a concurrent non-window-closing request's
//      response (the exact regression §11.6.3's lock-scoping warning
//      exists to prevent).
//   2. Failure/skip behavior — a failed /process-window call must not call
//      processedService.saveAndTrigger, must not throw, and must leave
//      raw_telemetry writes (sensorService.saveReading) unaffected.
// ─────────────────────────────────────────────────────────────────────────

import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetAll } from '../../preprocessing/buffer.js';

const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');

function makeSample(offsetSec, overrides = {}) {
  return {
    timestamp: new Date(BASE_MS + offsetSec * 1000).toISOString(),
    status: 'RUNNING',
    flowRate: 200,
    rpm: 1500,
    vibration: 2,
    suctionPressure: 3,
    dischargePressure: 8,
    motorTemp: 60,
    ...overrides,
  };
}

let savedReadings;
let saveAndTriggerCalls;
let originalFetch;

beforeEach(() => {
  resetAll();
  savedReadings = [];
  saveAndTriggerCalls = [];

  mock.module('../../services/sensorService.js', {
    namedExports: {
      saveReading: async (data) => {
        const reading = { id: savedReadings.length + 1, ...data };
        savedReadings.push(reading);
        return reading;
      },
    },
  });

  mock.module('../../services/processedService.js', {
    namedExports: {
      saveAndTrigger: async (record) => {
        saveAndTriggerCalls.push(record);
        return { id: saveAndTriggerCalls.length, ...record };
      },
    },
  });

  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  mock.reset();
});

test('successful /process-window response is persisted via saveAndTrigger', async () => {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      processedRecord: { windowEnd: '2026-01-01T00:01:00.000Z', qualityScore: 100 },
      tier1Verdict: { flagged: false },
    }),
  });

  const { processSample } = await import('../../preprocessing/pipeline.js');

  // 60 samples fill exactly one minute-aligned window; the 61st (next
  // minute) sample triggers the close.
  for (let i = 0; i < 60; i++) {
    await processSample(makeSample(i));
  }
  await processSample(makeSample(60));

  assert.equal(savedReadings.length, 61, 'every raw sample stored regardless of window closure');
  assert.equal(saveAndTriggerCalls.length, 1, 'exactly one window closed and was persisted');
  assert.equal(saveAndTriggerCalls[0].qualityScore, 100);
});

test('a failed /process-window call is logged and skipped, not thrown, and does not persist', async () => {
  global.fetch = async () => {
    throw new Error('simulated network failure');
  };

  const { processSample } = await import('../../preprocessing/pipeline.js');

  for (let i = 0; i < 60; i++) {
    await processSample(makeSample(i));
  }
  // Must not throw even though the window-closing call's Python request fails.
  await assert.doesNotReject(processSample(makeSample(60)));

  assert.equal(savedReadings.length, 61, 'raw_telemetry writes unaffected by the Python failure');
  assert.equal(saveAndTriggerCalls.length, 0, 'no processed_telemetry row written on failure');
});

test('a non-2xx /process-window response is logged and skipped, not thrown', async () => {
  global.fetch = async () => ({
    ok: false,
    status: 422,
    json: async () => ({ detail: 'entire window failed physics validation' }),
  });

  const { processSample } = await import('../../preprocessing/pipeline.js');

  for (let i = 0; i < 60; i++) {
    await processSample(makeSample(i));
  }
  await assert.doesNotReject(processSample(makeSample(60)));

  assert.equal(saveAndTriggerCalls.length, 0);
});

test('lock scoping: a slow window-closing /process-window call does not block a concurrent non-closing ingest', async () => {
  let pythonCallStarted = false;
  let releasePython;
  const pythonGate = new Promise((resolve) => { releasePython = resolve; });

  global.fetch = async () => {
    pythonCallStarted = true;
    await pythonGate; // hangs until the test explicitly releases it
    return {
      ok: true,
      json: async () => ({
        processedRecord: { windowEnd: '2026-01-01T00:01:00.000Z', qualityScore: 100 },
        tier1Verdict: { flagged: false },
      }),
    };
  };

  const { processSample } = await import('../../preprocessing/pipeline.js');

  for (let i = 0; i < 60; i++) {
    await processSample(makeSample(i));
  }

  // This call closes the first window and triggers the (hung) Python call.
  const closingCall = processSample(makeSample(60));

  // Give the closing call's unlocked HTTP phase a chance to actually start
  // before asserting anything about it.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pythonCallStarted, true, 'the Python call for the closing window has started');

  // A second, non-window-closing ingest (still within the second window)
  // must resolve promptly — proving withLock() released before the Python
  // call, not after it. If the lock still wrapped the fetch, this would
  // hang until releasePython() is called below.
  const nonClosingStart = Date.now();
  await processSample(makeSample(61));
  const nonClosingElapsed = Date.now() - nonClosingStart;
  assert.ok(nonClosingElapsed < 500, `non-closing ingest should return promptly, took ${nonClosingElapsed}ms`);

  releasePython();
  await closingCall;
  assert.equal(saveAndTriggerCalls.length, 1);
});
