// ─────────────────────────────────────────────────────────────────────────
// corpusMaterializationService.test.mjs — pure-function tests for
// resolveLabel (§10.6 item 4's resolution). No DB involved.
//
// Run with: node --test scripts/tests/corpusMaterializationService.test.mjs
// ─────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLabel } from '../../services/corpusMaterializationService.js';

test('a CONFIRMED row with a known faultType resolves to that faultType', () => {
  assert.equal(resolveLabel({ eventType: 'FLAGGED', status: 'CONFIRMED', faultType: 'BEARING' }), 'BEARING');
});

test('a NEGATIVE_SAMPLE row always resolves to NORMAL, regardless of status', () => {
  assert.equal(resolveLabel({ eventType: 'NEGATIVE_SAMPLE', status: 'N/A', faultType: null }), 'NORMAL');
});

test('OTHER is a legitimate label when CONFIRMED', () => {
  assert.equal(resolveLabel({ eventType: 'FLAGGED', status: 'CONFIRMED', faultType: 'OTHER' }), 'OTHER');
});

test('PENDING_REVIEW rows are excluded (not materialized), even with a faultType present', () => {
  assert.equal(resolveLabel({ eventType: 'FLAGGED', status: 'PENDING_REVIEW', faultType: 'BEARING' }), null);
});

test('REJECTED rows are excluded — not treated as a NORMAL/negative example either', () => {
  assert.equal(resolveLabel({ eventType: 'FLAGGED', status: 'REJECTED', faultType: 'BEARING' }), null);
});

test('DISMISSED rows are excluded', () => {
  assert.equal(resolveLabel({ eventType: 'FLAGGED', status: 'DISMISSED', faultType: null }), null);
});

test('a CONFIRMED row with a null faultType is excluded (defensive — should not occur, but never fabricate a label)', () => {
  assert.equal(resolveLabel({ eventType: 'FLAGGED', status: 'CONFIRMED', faultType: null }), null);
});

test('a CONFIRMED row with an unrecognized faultType string is excluded, not passed through', () => {
  assert.equal(resolveLabel({ eventType: 'FLAGGED', status: 'CONFIRMED', faultType: 'NOT_A_REAL_TYPE' }), null);
});
