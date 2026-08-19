// ─────────────────────────────────────────────────────────────────────────
// externalUploadService.test.mjs — exercises confirmUpload's Stage B/C
// orchestration with the model layer + pdm's /process-window mocked via
// node:test's mock.module() (same pattern as
// faultEventService.manualBuffer.test.mjs). No live Postgres/pdm needed.
//
// Requires --experimental-test-module-mocks:
//   node --experimental-test-module-mocks --test scripts/tests/externalUploadService.test.mjs
//
// Focused especially on the design-review fix this suite exists to guard:
// the two Stage C floors (physicsPassRate/imputationRate) are evaluated
// PER WINDOW, not as a corpus-wide weighted mean — a batch of mostly-clean
// windows must NOT be able to dilute a few genuinely bad ones into a
// passing average.
// ─────────────────────────────────────────────────────────────────────────

import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

function makeUpload(overrides = {}) {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const rows = Array.from({ length: 120 }, (_, i) => ({
    ts: new Date(base + i * 1000).toISOString(),
    flow: '200',
  }));
  return {
    id: 1,
    status: 'AWAITING_MAPPING',
    stagedRows: rows,
    stageAResult: { detectedTimestampColumn: 'ts', survivingColumns: ['flow'] },
    ...overrides,
  };
}

const VALID_BODY = {
  columnMapping: { flow: { metric: 'flowRate', unit: 'L/min' } },
  faultType: 'BEARING',
  rootCause: 'test',
  resolution: 'test',
  notes: 'external dataset from a prior deployment',
};

function makeProcessedRecord(overrides = {}) {
  return {
    windowEnd: '2026-01-01T00:01:00.000Z',
    preprocessingVersion: 'v3-py',
    precapFeaturesByMetric: {},
    qualityScore: 95, physicsPassRate: 1, imputationRate: 0, outlierRate: 0,
    ...overrides,
  };
}

let uploadRow;
let finalizeCalls;
let upsertCalls;
let checkClassBalanceCalls;
let checkClassBalanceThrows;

beforeEach(() => {
  uploadRow = makeUpload();
  finalizeCalls = [];
  upsertCalls = [];
  checkClassBalanceCalls = [];
  checkClassBalanceThrows = null;

  mock.module('../../models/externalUploadModel.js', {
    exports: {
      getUploadById: async () => uploadRow,
      finalizeUpload: async (id, fields) => { finalizeCalls.push({ id, fields }); },
      insertUpload: async () => ({ id: 1 }),
      getStaleAwaitingMapping: async () => [],
      purgeStagedRows: async () => {},
    },
  });

  mock.module('../../models/corpusModel.js', {
    exports: {
      upsertRow: async (record) => { upsertCalls.push(record); return { id: upsertCalls.length }; },
      getClassBalance: async () => [],
      deleteByBuffer: async () => {},
      deleteByUploadId: async () => {},
      getByBuffer: async () => [],
      getRowCount: async () => 0,
    },
  });

  mock.module('../../services/corpusMaterializationService.js', {
    exports: {
      alignedWindowEndsInRange: (startMs, endMs) => {
        const WINDOW_MS = 60_000;
        const first = Math.ceil(startMs / WINDOW_MS) * WINDOW_MS;
        const last = Math.ceil(endMs / WINDOW_MS) * WINDOW_MS;
        const ends = [];
        for (let ms = first; ms <= last; ms += WINDOW_MS) ends.push(ms);
        return ends;
      },
      checkClassBalance: async (label, opts) => {
        checkClassBalanceCalls.push({ label, opts });
        if (checkClassBalanceThrows) throw checkClassBalanceThrows;
        return { warning: null };
      },
    },
  });
});

afterEach(() => {
  mock.reset();
});

function mockFetchSequence(responses) {
  let i = 0;
  global.fetch = async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r.networkError) throw new Error('simulated network failure');
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 422),
      json: async () => (r.ok ? { processedRecord: makeProcessedRecord(r.overrides) } : { detail: 'rejected' }),
    };
  };
}

test('Stage B mapping rejection: finalizes STAGE_B_REJECTED, never calls Stage C or materializes', async () => {
  const { confirmUpload } = await import('../../services/externalUploadService.js');
  await assert.rejects(
    () => confirmUpload(1, { ...VALID_BODY, columnMapping: { flow: { metric: 'flowRate', unit: 'psi' } } }, 'tester'),
    (err) => { assert.equal(err.status, 422); return true; },
  );
  assert.equal(finalizeCalls.length, 1);
  assert.equal(finalizeCalls[0].fields.status, 'STAGE_B_REJECTED');
  assert.equal(upsertCalls.length, 0);
});

test('range sanity warning without confirmRangeOverride returns requiresConfirmation, no finalize', async () => {
  uploadRow = makeUpload({
    stagedRows: Array.from({ length: 120 }, (_, i) => ({ ts: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString(), flow: '999999' })),
  });
  const { confirmUpload } = await import('../../services/externalUploadService.js');
  const result = await confirmUpload(1, VALID_BODY, 'tester');
  assert.equal(result.requiresConfirmation, true);
  assert.equal(finalizeCalls.length, 0);
});

test('Stage C: a single window breaching the physicsPassRate floor rejects the WHOLE upload, even though the composite average would pass', async () => {
  // 3 windows: two pristine (physicsPassRate=1), one that breaches the
  // floor (physicsPassRate=0.5, below the 0.85 floor) — a weighted mean
  // across ~equal-sized windows would land around 0.83, itself just under
  // 0.85, but the real regression this test guards is that the check must
  // never even compute that mean for the floor — it must catch the single
  // bad window directly, per-window, regardless of what the average is.
  uploadRow = makeUpload({
    stagedRows: Array.from({ length: 180 }, (_, i) => ({ ts: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString(), flow: '200' })),
  });
  mockFetchSequence([
    { ok: true, overrides: { physicsPassRate: 1, imputationRate: 0, qualityScore: 100 } },
    { ok: true, overrides: { physicsPassRate: 0.5, imputationRate: 0, qualityScore: 95 } }, // breaches floor
    { ok: true, overrides: { physicsPassRate: 1, imputationRate: 0, qualityScore: 100 } },
  ]);

  const { confirmUpload } = await import('../../services/externalUploadService.js');
  await assert.rejects(
    () => confirmUpload(1, VALID_BODY, 'tester'),
    (err) => {
      assert.equal(err.status, 422);
      assert.match(err.message, /breached the per-window/);
      return true;
    },
  );
  assert.equal(finalizeCalls[0].fields.status, 'STAGE_C_REJECTED');
  assert.equal(upsertCalls.length, 0, 'must not materialize any window once the upload is rejected');
});

test('Stage C: an AllSamplesInvalidError (422) window counts as the worst case, not dropped from the average', async () => {
  uploadRow = makeUpload({
    stagedRows: Array.from({ length: 120 }, (_, i) => ({ ts: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString(), flow: '200' })),
  });
  mockFetchSequence([
    { ok: false, status: 422 },
    { ok: true, overrides: { physicsPassRate: 1, imputationRate: 0, qualityScore: 100 } },
  ]);

  const { confirmUpload } = await import('../../services/externalUploadService.js');
  await assert.rejects(() => confirmUpload(1, VALID_BODY, 'tester'), (err) => { assert.equal(err.status, 422); return true; });
  // The 422 window forces physicsPassRate down (0 for that window), which
  // breaches the per-window floor on its own — must reject.
  assert.equal(finalizeCalls[0].fields.status, 'STAGE_C_REJECTED');
});

test('checkClassBalance block-mode rejection happens BEFORE any training_corpus write', async () => {
  uploadRow = makeUpload({
    stagedRows: Array.from({ length: 120 }, (_, i) => ({ ts: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString(), flow: '200' })),
  });
  mockFetchSequence([{ ok: true, overrides: { physicsPassRate: 1, imputationRate: 0, qualityScore: 100 } }]);
  checkClassBalanceThrows = Object.assign(new Error('corpus imbalance'), { status: 422 });

  const { confirmUpload } = await import('../../services/externalUploadService.js');
  await assert.rejects(() => confirmUpload(1, VALID_BODY, 'tester'), (err) => { assert.equal(err.status, 422); return true; });
  assert.equal(upsertCalls.length, 0);
  assert.equal(checkClassBalanceCalls[0].opts.mode, 'block');
});

test('full accept path: materializes one training_corpus row per window, with sourceType EXTERNAL_UPLOAD, faultEventId null, and the reserved upload: bufferId scheme (D10)', async () => {
  uploadRow = makeUpload({
    stagedRows: Array.from({ length: 120 }, (_, i) => ({ ts: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString(), flow: '200' })),
  });
  mockFetchSequence([
    { ok: true, overrides: { physicsPassRate: 1, imputationRate: 0, qualityScore: 100, windowEnd: '2026-01-01T00:01:00.000Z' } },
    { ok: true, overrides: { physicsPassRate: 1, imputationRate: 0, qualityScore: 100, windowEnd: '2026-01-01T00:02:00.000Z' } },
  ]);

  const { confirmUpload } = await import('../../services/externalUploadService.js');
  const result = await confirmUpload(1, VALID_BODY, 'tester');

  assert.equal(result.materializedWindows, 2);
  assert.equal(upsertCalls.length, 2);
  for (const call of upsertCalls) {
    assert.equal(call.sourceType, 'EXTERNAL_UPLOAD');
    assert.equal(call.faultEventId, null);
    assert.match(call.bufferId, /^upload:1:\d+$/);
    assert.equal(call.label, 'BEARING');
  }
  assert.equal(finalizeCalls[0].fields.status, 'ACCEPTED');
});

test('a re-confirm on an already-terminal upload is rejected with 409', async () => {
  uploadRow = makeUpload({ status: 'ACCEPTED' });
  const { confirmUpload } = await import('../../services/externalUploadService.js');
  await assert.rejects(() => confirmUpload(1, VALID_BODY, 'tester'), (err) => { assert.equal(err.status, 409); return true; });
});
