// ─────────────────────────────────────────────────────────────────────────
// pdmManualBufferValidation.test.mjs — pure-function tests for
// pdmManualBufferValidation.js's validateManualBufferCreate (§10.4 Entry
// point 1's request-body gate). No DB/network involved — plain assertions
// against the validator's return value, same style as pdm/tests/test_rules.py.
//
// Run with: node --test scripts/tests/pdmManualBufferValidation.test.mjs
// ─────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManualBufferCreate } from '../../utils/pdmManualBufferValidation.js';

const VALID = {
  faultStart: '2026-08-10T02:00:00.000Z',
  faultEnd: '2026-08-10T02:03:00.000Z',
  faultType: 'BEARING',
  rootCause: 'worn bearing',
  resolution: 'replaced bearing',
  notes: 'operator noticed elevated vibration after the fact',
};

test('a fully valid body passes with no errors', () => {
  assert.deepEqual(validateManualBufferCreate(VALID), []);
});

test('rejects a non-object body', () => {
  assert.ok(validateManualBufferCreate(null).length > 0);
  assert.ok(validateManualBufferCreate('nope').length > 0);
  assert.ok(validateManualBufferCreate([]).length > 0);
});

test('rejects unparseable faultStart/faultEnd', () => {
  const errors = validateManualBufferCreate({ ...VALID, faultStart: 'not-a-date' });
  assert.ok(errors.some((e) => e.includes('faultStart')));
});

test('rejects faultStart >= faultEnd', () => {
  const errors = validateManualBufferCreate({ ...VALID, faultStart: VALID.faultEnd, faultEnd: VALID.faultStart });
  assert.ok(errors.some((e) => e.includes('faultStart must be before faultEnd')));
});

test('rejects a span shorter than one window (60s)', () => {
  const errors = validateManualBufferCreate({ ...VALID, faultStart: '2026-08-10T02:00:00.000Z', faultEnd: '2026-08-10T02:00:30.000Z' });
  assert.ok(errors.some((e) => e.includes('at least 60 seconds')));
});

test('rejects a span exceeding PDM_MANUAL_BUFFER_MAX_HOURS (default 168h)', () => {
  const errors = validateManualBufferCreate({ ...VALID, faultStart: '2026-08-01T00:00:00.000Z', faultEnd: '2026-08-10T00:00:00.000Z' });
  assert.ok(errors.some((e) => e.includes('must not exceed')));
});

test('accepts a span exactly at the minimum (60s)', () => {
  const errors = validateManualBufferCreate({ ...VALID, faultStart: '2026-08-10T02:00:00.000Z', faultEnd: '2026-08-10T02:01:00.000Z' });
  assert.deepEqual(errors, []);
});

test('rejects an invalid faultType', () => {
  const errors = validateManualBufferCreate({ ...VALID, faultType: 'ELECTRICAL' });
  assert.ok(errors.some((e) => e.includes('faultType must be one of')));
});

test('rejects blank rootCause/resolution', () => {
  const errors = validateManualBufferCreate({ ...VALID, rootCause: '   ', resolution: '' });
  assert.ok(errors.some((e) => e.includes('rootCause')));
  assert.ok(errors.some((e) => e.includes('resolution')));
});

test('rejects a blank or missing notes — mandatory here, unlike the PATCH review endpoint', () => {
  const missingNotes = { ...VALID };
  delete missingNotes.notes;
  assert.ok(validateManualBufferCreate(missingNotes).some((e) => e.includes('notes')));

  const blankNotes = { ...VALID, notes: '   ' };
  assert.ok(validateManualBufferCreate(blankNotes).some((e) => e.includes('notes')));
});

test('rejects a malformed triggerWindowEnd when supplied', () => {
  const errors = validateManualBufferCreate({ ...VALID, triggerWindowEnd: 'not-a-date' });
  assert.ok(errors.some((e) => e.includes('triggerWindowEnd')));
});

test('a valid triggerWindowEnd does not itself produce an error', () => {
  const errors = validateManualBufferCreate({ ...VALID, triggerWindowEnd: '2026-08-10T02:02:00.000Z' });
  assert.deepEqual(errors, []);
});

test('reports every violated rule at once, not just the first', () => {
  const errors = validateManualBufferCreate({
    faultStart: 'bad',
    faultEnd: 'also-bad',
    faultType: 'NOPE',
    rootCause: '',
    resolution: '',
    notes: '',
  });
  assert.ok(errors.length >= 5, `expected multiple errors, got ${errors.length}: ${errors.join('; ')}`);
});
