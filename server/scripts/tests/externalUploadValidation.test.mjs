// ─────────────────────────────────────────────────────────────────────────
// externalUploadValidation.test.mjs — pure Stage A/B tests for §10.4 Entry
// point 2 (docs/plan/2026-08-05-pdm-implementation.md §10.4.1). No DB.
//
// Run with: node --test scripts/tests/externalUploadValidation.test.mjs
// ─────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStageA, validateStageBMapping, checkRangeSanity, parseNumeric,
  MIN_ROWS,
} from '../../utils/externalUploadValidation.js';

function makeRows(n, overrides = {}) {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  return Array.from({ length: n }, (_, i) => ({
    ts: new Date(base + i * 1000).toISOString(),
    flow: (200 + i % 10).toString(),
    vib: (2 + (i % 3) * 0.1).toString(),
    ...overrides,
  }));
}

test('Stage A: a well-formed file passes with the timestamp column detected', () => {
  const rows = makeRows(MIN_ROWS);
  const result = validateStageA(['ts', 'flow', 'vib'], rows);
  assert.equal(result.valid, true);
  assert.equal(result.detectedTimestampColumn, 'ts');
  assert.deepEqual(result.survivingColumns, ['flow', 'vib']);
  assert.equal(result.medianIntervalSec, 1);
});

test('Stage A: fewer than MIN_ROWS fails', () => {
  const rows = makeRows(MIN_ROWS - 1);
  const result = validateStageA(['ts', 'flow'], rows);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('fewer than the minimum')));
});

test('Stage A: no parseable timestamp column fails outright, cannot manufacture a time axis', () => {
  const rows = Array.from({ length: MIN_ROWS }, (_, i) => ({ a: `row${i}`, b: i }));
  const result = validateStageA(['a', 'b'], rows);
  assert.equal(result.valid, false);
  assert.equal(result.detectedTimestampColumn, null);
});

test('Stage A: a cadence outside [0.5s, 5s] fails (D14 — resampling not supported)', () => {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const rows = Array.from({ length: MIN_ROWS }, (_, i) => ({
    ts: new Date(base + i * 60_000).toISOString(), // 60s cadence — far outside [0.5,5]
    flow: '200',
  }));
  const result = validateStageA(['ts', 'flow'], rows);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('outside the supported')));
});

test('Stage A: a column >50% empty is excluded, not fatal, if others survive', () => {
  const rows = makeRows(MIN_ROWS).map((row, i) => ({ ...row, sparse: i % 3 === 0 ? '1' : '' }));
  const result = validateStageA(['ts', 'flow', 'vib', 'sparse'], rows);
  assert.equal(result.valid, true);
  assert.ok(result.excludedColumns.some((c) => c.name === 'sparse'));
  assert.ok(!result.survivingColumns.includes('sparse'));
});

test('Stage A: fails outright when EVERY non-timestamp column is too sparse', () => {
  const rows = makeRows(MIN_ROWS).map((row, i) => ({ ts: row.ts, flow: i % 10 === 0 ? '1' : '', vib: i % 10 === 0 ? '1' : '' }));
  const result = validateStageA(['ts', 'flow', 'vib'], rows);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('every non-timestamp column')));
});

test('Stage A: excessive exact-duplicate rows fail', () => {
  const base = makeRows(1)[0];
  const rows = Array.from({ length: MIN_ROWS }, () => ({ ...base }));
  const result = validateStageA(['ts', 'flow', 'vib'], rows);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('exact duplicates')));
});

test('Stage B mapping: injective mapping required — two columns to the same metric fails', () => {
  const errors = validateStageBMapping(
    { rpm1: { metric: 'engineRpm', unit: 'RPM' }, rpm2: { metric: 'engineRpm', unit: 'RPM' } },
    ['rpm1', 'rpm2'],
  );
  assert.ok(errors.some((e) => e.includes('injective')));
});

test('Stage B mapping: at least one metric must be mapped', () => {
  const errors = validateStageBMapping({ flow: null }, ['flow']);
  assert.ok(errors.some((e) => e.includes('at least 1 metric')));
});

test('Stage B mapping: an invalid unit for the metric fails', () => {
  const errors = validateStageBMapping({ oil: { metric: 'lubOilPressure', unit: 'g' } }, ['oil']);
  assert.ok(errors.some((e) => e.includes("declares unit 'g'")));
});

test('Stage B mapping: a column not in survivingColumns fails', () => {
  const errors = validateStageBMapping({ ghost: { metric: 'engineRpm', unit: 'RPM' } }, ['flow']);
  assert.ok(errors.some((e) => e.includes('not a column that survived Stage A')));
});

test('Stage B mapping: a fully valid mapping passes with no errors', () => {
  const errors = validateStageBMapping(
    { rpm: { metric: 'engineRpm', unit: 'RPM' }, oil: { metric: 'lubOilPressure', unit: 'bar' }, extra: null },
    ['rpm', 'oil', 'extra'],
  );
  assert.deepEqual(errors, []);
});

test('checkRangeSanity: values mostly outside the physical range require confirmation', () => {
  const result = checkRangeSanity({ engineRpm: [9999, 9998, 9997, 1] }, { engineRpm: { min: 0, max: 2500 } });
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.warnings[0].metric, 'engineRpm');
});

test('checkRangeSanity: values mostly inside the range do not require confirmation', () => {
  const result = checkRangeSanity({ engineRpm: [800, 900, 1000, 9999] }, { engineRpm: { min: 0, max: 2500 } });
  assert.equal(result.requiresConfirmation, false);
});

test('parseNumeric handles strings, numbers, and blanks', () => {
  assert.equal(parseNumeric('123.5'), 123.5);
  assert.equal(parseNumeric(42), 42);
  assert.equal(parseNumeric(''), null);
  assert.equal(parseNumeric('not-a-number'), null);
  assert.equal(parseNumeric(null), null);
});
