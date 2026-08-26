// ─────────────────────────────────────────────────────────────────────────
// unitConversion.test.mjs — §10.4.1 Stage B's fixed per-metric unit lists
// and conversion math.
//
// Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
// migration.md Phase 9. flowRate/vibration have no engine analogue and are
// dropped (not renamed) — see utils/unitConversion.js's Phase 3 rewrite.
//
// Run with: node --test scripts/tests/unitConversion.test.mjs
// ─────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitsForMetric, convertToInternalUnit } from '../../utils/unitConversion.js';

test('the internal unit is always a no-op conversion', () => {
  assert.equal(convertToInternalUnit('engineRpm', 'RPM', 800), 800);
  assert.equal(convertToInternalUnit('lubOilPressure', 'bar', 4), 4);
  assert.equal(convertToInternalUnit('coolantTemperature', '°C', 78), 78);
});

test('pressure metrics convert psi/kPa correctly to bar', () => {
  assert.ok(Math.abs(convertToInternalUnit('lubOilPressure', 'psi', 14.5038) - 1) < 0.001); // ~1 bar
  assert.equal(convertToInternalUnit('coolantPressure', 'kPa', 100), 1); // 100 kPa = 1 bar
  assert.ok(Math.abs(convertToInternalUnit('fuelPressure', 'psi', 14.5038) - 1) < 0.001);
});

test('temperature conversions use an offset, not a pure multiplier', () => {
  assert.ok(Math.abs(convertToInternalUnit('coolantTemperature', '°F', 212) - 100) < 0.001); // boiling point
  assert.equal(convertToInternalUnit('lubOilTemperature', 'K', 373.15), 100);
});

test('engineRpm has only its own unit — no alternate unit list', () => {
  assert.deepEqual(unitsForMetric('engineRpm'), ['RPM']);
});

test('an unknown metric/unit combination returns null, not a throw', () => {
  assert.equal(convertToInternalUnit('lubOilPressure', 'g', 1), null);
  assert.equal(convertToInternalUnit('notAMetric', 'x', 1), null);
});

test('a non-finite value returns null', () => {
  assert.equal(convertToInternalUnit('coolantPressure', 'bar', NaN), null);
  assert.equal(convertToInternalUnit('coolantPressure', 'bar', 'not-a-number'), null);
});

test('unitsForMetric returns undefined for an unrecognized metric', () => {
  assert.equal(unitsForMetric('notAMetric'), undefined);
});
