// ─────────────────────────────────────────────────────────────────────────
// faultEventService.test.mjs — exercises the fault_events service layer
// directly against an isolated on-disk DB (§4.5):
//   - a flagged window creates a PENDING_REVIEW row with the fixed
//     featureSnapshot composition and correct processedTelemetryId
//   - two consecutive triggering windows (same rule) coalesce into one row
//   - a third triggering window past the lookback bound opens a new row
//   - negative-sample suppression while a FLAGGED event is open
//   - the /stats aggregate
//
// Run with: node --test scripts/tests/faultEventService.test.mjs
// (also picked up by `npm test`, which runs node --test scripts/tests)
// ─────────────────────────────────────────────────────────────────────────

process.env.DB_PATH = './scripts/tests/_faultEventService.db';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';

function removeDbFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = process.env.DB_PATH + suffix;
    // better-sqlite3 keeps its file handle open for the life of the
    // process (db.js exports no close()) — on Windows that can make a
    // post-test unlink of the still-open main DB file EBUSY. Best-effort:
    // still clean up the always-closable -wal/-shm files, but don't fail
    // the suite over an OS-level file lock that doesn't affect test outcome.
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // ignore
    }
  }
}
removeDbFiles();

const { saveProcessedReading } = await import('../../services/processedService.js');
const faultEventService = await import('../../services/faultEventService.js');

const METRICS = ['flowRate', 'rpm', 'vibration', 'suctionPressure', 'dischargePressure', 'motorTemp'];

/** A minimal, well-formed flat processedRecord for one window, ending at windowEndIso. */
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

/** Insert a real processed_telemetry row (needed for the FK) and return { data, id }. */
function seedProcessedRow(windowEndIso, overrides = {}) {
  const data = makeProcessedRecord(windowEndIso, overrides);
  const stored = saveProcessedReading(data);
  return { data, id: stored.id };
}

after(() => removeDbFiles());

test('recordFlaggedEvent creates a PENDING_REVIEW row with the fixed featureSnapshot composition and correct processedTelemetryId', () => {
  const { data, id } = seedProcessedRow('2026-08-05T00:01:00.000Z');
  const verdict = { confidence: 'HIGH', triggeredRules: ['vibration.rateOfChange'], thresholdsVersion: '1' };

  const { id: eventId, coalesced } = faultEventService.recordFlaggedEvent(data, id, verdict);
  assert.equal(coalesced, false);

  const event = faultEventService.getFaultEvent(eventId);
  assert.equal(event.status, 'PENDING_REVIEW');
  assert.equal(event.eventType, 'FLAGGED');
  assert.equal(event.processedTelemetryId, id);

  const snapshot = JSON.parse(event.featureSnapshot);
  assert.equal(Object.keys(snapshot.precapFeaturesByMetric).length, 6);
  assert.equal(Object.keys(snapshot.metricStats).length, 6);
  for (const metric of METRICS) {
    assert.ok(snapshot.metricStats[metric], `expected metricStats.${metric}`);
    assert.equal(typeof snapshot.metricStats[metric].mean, 'number');
  }
});

test('a second triggering window for the same rule within the lookback bound coalesces into the same row', () => {
  const { data: data1, id: id1 } = seedProcessedRow('2026-08-05T01:00:00.000Z');
  const verdict = { confidence: 'LOW', triggeredRules: ['motorTemp.stdDev'], thresholdsVersion: '1' };
  const first = faultEventService.recordFlaggedEvent(data1, id1, verdict);

  // 60 seconds later — well within the 3-window/180s lookback bound.
  const { data: data2, id: id2 } = seedProcessedRow('2026-08-05T01:01:00.000Z');
  const second = faultEventService.recordFlaggedEvent(data2, id2, verdict);

  assert.equal(second.coalesced, true);
  assert.equal(second.id, first.id);

  const event = faultEventService.getFaultEvent(first.id);
  assert.equal(event.triggerWindowEnd, '2026-08-05T01:01:00.000Z');
  assert.equal(event.lastSeenWindowEnd, '2026-08-05T01:01:00.000Z');

  const allEvents = faultEventService.listFaultEvents('PENDING_REVIEW');
  assert.equal(allEvents.filter((e) => e.id === first.id).length, 1);
});

test('a triggering window arriving after the lookback bound opens a new row instead of extending the stale one', () => {
  const { data: data1, id: id1 } = seedProcessedRow('2026-08-05T02:00:00.000Z');
  const verdict = { confidence: 'LOW', triggeredRules: ['rpm.max'], thresholdsVersion: '1' };
  const first = faultEventService.recordFlaggedEvent(data1, id1, verdict);

  // 5 minutes later — past the 3-window/180s lookback bound.
  const { data: data2, id: id2 } = seedProcessedRow('2026-08-05T02:05:00.000Z');
  const second = faultEventService.recordFlaggedEvent(data2, id2, verdict);

  assert.equal(second.coalesced, false);
  assert.notEqual(second.id, first.id);
});

test('negative sampling is suppressed while a FLAGGED event is open, and resumes once it is resolved', () => {
  const { data: flagData, id: flagId } = seedProcessedRow('2026-08-05T03:00:00.000Z');
  const verdict = { confidence: 'MEDIUM', triggeredRules: ['flowRate.stdDev'], thresholdsVersion: '1' };
  const flagged = faultEventService.recordFlaggedEvent(flagData, flagId, verdict);

  const { data: normalData, id: normalId } = seedProcessedRow('2026-08-05T03:01:00.000Z');
  const suppressed = faultEventService.recordNegativeSample(normalData, normalId, '1');
  assert.equal(suppressed, null, 'expected negative sampling to be suppressed while the event is open');

  // Resolve the event, then push a window well past the lookback bound.
  faultEventService.reviewFaultEvent(flagged.id, { status: 'CONFIRMED', faultEnd: '2026-08-05T03:00:00.000Z', reviewedBy: 'tester' });
  const { data: laterData, id: laterId } = seedProcessedRow('2026-08-05T03:10:00.000Z');
  const sampleId = faultEventService.recordNegativeSample(laterData, laterId, '1');
  assert.notEqual(sampleId, null, 'expected negative sampling to resume once no event is open');

  const sample = faultEventService.getFaultEvent(sampleId);
  assert.equal(sample.eventType, 'NEGATIVE_SAMPLE');
  assert.equal(sample.status, 'N/A');
  assert.equal(sample.triggeredRules, null);
});

test('recordNegativeSample is a no-op when dominantStatus is not RUNNING', () => {
  const { data, id } = seedProcessedRow('2026-08-05T04:00:00.000Z', { dominantStatus: 'STOPPED' });
  const sampleId = faultEventService.recordNegativeSample(data, id, '1');
  assert.equal(sampleId, null);
});

test('getFaultEventStats aggregates confidence/status counts for reviewed FLAGGED rows', () => {
  const seeds = [
    { confidence: 'HIGH', status: 'CONFIRMED' },
    { confidence: 'HIGH', status: 'CONFIRMED' },
    { confidence: 'HIGH', status: 'REJECTED' },
    { confidence: 'LOW', status: 'REJECTED' },
  ];
  let ts = Date.parse('2026-08-05T05:00:00.000Z');
  for (const seed of seeds) {
    ts += 10 * 60_000; // 10 minutes apart — comfortably past the coalescing bound each time
    const windowEnd = new Date(ts).toISOString();
    const { data, id } = seedProcessedRow(windowEnd);
    const { id: eventId } = faultEventService.recordFlaggedEvent(data, id, {
      confidence: seed.confidence,
      triggeredRules: ['vibration.stdDev'],
      thresholdsVersion: '1',
    });
    faultEventService.reviewFaultEvent(eventId, { status: seed.status, reviewedBy: 'tester' });
  }

  const stats = faultEventService.getFaultEventStats();
  assert.equal(stats.HIGH.CONFIRMED, 2);
  assert.equal(stats.HIGH.REJECTED, 1);
  assert.equal(stats.LOW.REJECTED, 1);
});
