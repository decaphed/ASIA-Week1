// ─────────────────────────────────────────────────────────────────────────
// aggregation.dominantFaultType.test.mjs — TDD test for aggregateWindow()
// deriving dominantFaultType, mirroring the existing dominantStatus pattern
// (see server/preprocessing/aggregation.js). Ground truth: the Node-RED
// simulator (node-red/flow.json) already emits a per-sample `faultType`
// (THERMAL/CAVITATION/BEARING) whenever status === 'FAULT'; raw_telemetry
// stores it, but aggregateWindow currently drops it during the 60:1 rollup.
//
// Run with: node --test server/scripts/tests/aggregation.dominantFaultType.test.mjs
// ─────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateWindow } from '../../preprocessing/aggregation.js';
import { METRICS } from '../../services/forecastService.js';

const BASE_METRICS = {
  flowRate: 150, rpm: 2000, vibration: 3, suctionPressure: 2, dischargePressure: 7, motorTemp: 50,
};

function makeSample({ status, faultType = null, offsetSec }) {
  return {
    ...BASE_METRICS,
    status,
    faultType,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, offsetSec)).toISOString(),
  };
}

/** Build the (window, statsWindow, cappedByMetric) triple aggregateWindow expects. */
function buildInputs(samples) {
  const cappedByMetric = {};
  for (const metric of METRICS) {
    cappedByMetric[metric] = samples.map((s) => s[metric]);
  }
  return { window: samples, statsWindow: samples, cappedByMetric };
}

test('dominantFaultType is null when the window has no FAULT samples', () => {
  const samples = Array.from({ length: 5 }, (_, i) => makeSample({ status: 'RUNNING', offsetSec: i }));
  const { window, statsWindow, cappedByMetric } = buildInputs(samples);

  const agg = aggregateWindow(window, statsWindow, cappedByMetric);

  assert.equal(agg.dominantFaultType, null);
});

test('dominantFaultType is the most common faultType among FAULT samples', () => {
  const samples = [
    makeSample({ status: 'RUNNING', offsetSec: 0 }),
    makeSample({ status: 'FAULT', faultType: 'BEARING', offsetSec: 1 }),
    makeSample({ status: 'FAULT', faultType: 'BEARING', offsetSec: 2 }),
    makeSample({ status: 'FAULT', faultType: 'THERMAL', offsetSec: 3 }),
    makeSample({ status: 'RUNNING', offsetSec: 4 }),
  ];
  const { window, statsWindow, cappedByMetric } = buildInputs(samples);

  const agg = aggregateWindow(window, statsWindow, cappedByMetric);

  assert.equal(agg.dominantFaultType, 'BEARING');
});
