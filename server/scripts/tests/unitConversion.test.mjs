// ─────────────────────────────────────────────────────────────────────────
// unitConversion.test.mjs — §10.4.1 Stage B's fixed per-metric unit lists
// and conversion math.
//
// Run with: node --test scripts/tests/unitConversion.test.mjs
// ─────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitsForMetric, convertToInternalUnit } from '../../utils/unitConversion.js';

test('the internal unit is always a no-op conversion', () => {
  assert.equal(convertToInternalUnit('flowRate', 'L/min', 100), 100);
  assert.equal(convertToInternalUnit('vibration', 'mm/s', 5), 5);
  assert.equal(convertToInternalUnit('motorTemp', '°C', 60), 60);
});

test('vibration unit list deliberately excludes g (D13 — acceleration needs frequency to convert, which a scalar column cannot supply)', () => {
  assert.deepEqual(unitsForMetric('vibration'), ['mm/s', 'in/s']);
});

test('vibration in/s converts correctly (1 in/s = 25.4 mm/s)', () => {
  assert.equal(convertToInternalUnit('vibration', 'in/s', 1), 25.4);
});

test('pressure psi/kPa convert correctly to bar', () => {
  assert.ok(Math.abs(convertToInternalUnit('suctionPressure', 'psi', 14.5038) - 1) < 0.001); // ~1 bar
  assert.equal(convertToInternalUnit('dischargePressure', 'kPa', 100), 1); // 100 kPa = 1 bar
});

test('temperature conversions use an offset, not a pure multiplier', () => {
  assert.ok(Math.abs(convertToInternalUnit('motorTemp', '°F', 212) - 100) < 0.001); // boiling point
  assert.equal(convertToInternalUnit('motorTemp', 'K', 373.15), 100);
});

test('flowRate GPM/m3h convert correctly', () => {
  assert.ok(Math.abs(convertToInternalUnit('flowRate', 'GPM', 1) - 3.785411784) < 1e-9);
  assert.ok(Math.abs(convertToInternalUnit('flowRate', 'm3/h', 60) - 1000) < 1e-9);
});

test('rpm has only its own unit — no alternate unit list', () => {
  assert.deepEqual(unitsForMetric('rpm'), ['rpm']);
});

test('an unknown metric/unit combination returns null, not a throw', () => {
  assert.equal(convertToInternalUnit('vibration', 'g', 1), null);
  assert.equal(convertToInternalUnit('notAMetric', 'x', 1), null);
});

test('a non-finite value returns null', () => {
  assert.equal(convertToInternalUnit('flowRate', 'L/min', NaN), null);
  assert.equal(convertToInternalUnit('flowRate', 'L/min', 'not-a-number'), null);
});

test('unitsForMetric returns undefined for an unrecognized metric', () => {
  assert.equal(unitsForMetric('notAMetric'), undefined);
});
