// ─────────────────────────────────────────────────────────────────────────
// ingestConcurrency.test.mjs — regression test for the migration plan's §4.5
// concurrency requirement: N concurrent POST /api/data-equivalent calls must
// produce the same raw_telemetry/processed_telemetry result as running them
// sequentially, because processSample()/runBackgroundSweep() are wrapped in
// a shared mutex (see preprocessing/ingestLock.js).
//
// Requires a real Postgres/TimescaleDB reachable via DATABASE_URL, with
// `npm run migrate:up` already applied — this is NOT a pure in-memory unit
// test like aggregation.dominantFaultType.test.mjs.
// ─────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../database/db.js';
import { processSample, runBackgroundSweep } from '../../preprocessing/index.js';
import { resetAll } from '../../preprocessing/buffer.js';

const SAMPLE_COUNT = 90; // > 60s window duration, guarantees at least one window closes
const METRICS = {
  flowRate: 150,
  rpm: 1800,
  vibration: 3,
  suctionPressure: 1.5,
  dischargePressure: 6,
  motorTemp: 55,
};

function buildSamples(startMs) {
  const samples = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    samples.push({
      ...METRICS,
      status: 'RUNNING',
      timestamp: new Date(startMs + i * 1000).toISOString(),
    });
  }
  return samples;
}

async function resetDatabase() {
  await pool.query('TRUNCATE TABLE raw_telemetry, processed_telemetry RESTART IDENTITY');
  resetAll();
}

async function snapshotState() {
  const raw = await pool.query('SELECT "timestamp" FROM raw_telemetry ORDER BY id ASC');
  const processed = await pool.query('SELECT "windowStart", "windowEnd", "sampleCount" FROM processed_telemetry ORDER BY id ASC');
  return {
    rawCount: raw.rows.length,
    rawTimestamps: raw.rows.map((r) => r.timestamp.toISOString()),
    processed: processed.rows.map((r) => ({
      windowStart: r.windowStart.toISOString(),
      windowEnd: r.windowEnd.toISOString(),
      sampleCount: r.sampleCount,
    })),
  };
}

test('concurrent processSample() calls match the sequential result', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);

  try {
    // Baseline: sequential.
    await resetDatabase();
    const baseStartMs = Date.parse('2026-01-01T00:00:00.000Z');
    for (const sample of buildSamples(baseStartMs)) {
      await processSample(sample);
    }
    const expected = await snapshotState();

    // Concurrent: same samples, same timestamps, fired without awaiting
    // between them — deliberately racing the mutex.
    await resetDatabase();
    const concurrentStartMs = Date.parse('2026-01-02T00:00:00.000Z');
    const samples = buildSamples(concurrentStartMs);
    await Promise.all(samples.map((s) => processSample(s)));
    const actual = await snapshotState();

    assert.equal(actual.rawCount, expected.rawCount, 'raw_telemetry row count must match the sequential run');
    assert.deepEqual(
      actual.processed.map((p) => p.sampleCount),
      expected.processed.map((p) => p.sampleCount),
      'processed_telemetry window sampleCounts must match the sequential run',
    );
    assert.equal(actual.processed.length, expected.processed.length, 'same number of windows must close');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(unhandled, [], 'no unhandled promise rejections during the concurrent run');
});

test('runBackgroundSweep() interleaved with concurrent processSample() calls stays consistent', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);

  try {
    await resetDatabase();
    const startMs = Date.parse('2026-01-03T00:00:00.000Z');
    const samples = buildSamples(startMs);

    await Promise.all([
      ...samples.map((s) => processSample(s)),
      runBackgroundSweep(),
      runBackgroundSweep(),
    ]);

    const raw = await pool.query('SELECT COUNT(*)::int AS count FROM raw_telemetry');
    assert.ok(raw.rows[0].count >= SAMPLE_COUNT, 'every sample must still be stored even with sweeps racing ingestion');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(unhandled, [], 'no unhandled promise rejections when sweeps race ingestion');
});
