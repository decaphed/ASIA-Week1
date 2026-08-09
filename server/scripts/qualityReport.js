// ─────────────────────────────────────────────────────────────────────────
// qualityReport.js — summarizes preprocessing quality over recent
// processed_telemetry windows, so you can eyeball how clean the incoming
// Node-RED stream actually is before it reaches the statistical model.
//
// Usage:
//   node server/scripts/qualityReport.js [windowCount]
//   (defaults to the most recent 100 windows; pass 0 for all rows)
// ─────────────────────────────────────────────────────────────────────────

import pool, { toIso } from '../database/db.js';

async function main() {
  const windowCount = Number(process.argv[2]) || 100;

  const result = windowCount > 0
    ? await pool.query('SELECT * FROM processed_telemetry ORDER BY "timestamp" DESC LIMIT $1', [windowCount])
    : await pool.query('SELECT * FROM processed_telemetry ORDER BY "timestamp" DESC');
  // Normalise TIMESTAMPTZ columns to ISO strings, same as the model layer —
  // this script bypasses the models (direct pool.query) but must keep the
  // same Date/string convention (plan §4.4.1/§6).
  const rows = result.rows.map((r) => ({
    ...r,
    windowStart: toIso(r.windowStart),
    windowEnd: toIso(r.windowEnd),
    timestamp: toIso(r.timestamp),
  }));

  if (rows.length === 0) {
    console.log('No processed_telemetry rows yet — nothing to report.');
    return;
  }

  const avg = (key) => rows.reduce((sum, r) => sum + r[key], 0) / rows.length;
  const max = (key) => Math.max(...rows.map((r) => r[key]));
  const count = (pred) => rows.filter(pred).length;

  const labelCounts = rows.reduce((acc, r) => {
    acc[r.qualityLabel] = (acc[r.qualityLabel] || 0) + 1;
    return acc;
  }, {});

  // Detect skipped windows: a gap between consecutive windowEnd timestamps
  // bigger than ~90s (60 expected + slack) means an all-physics-invalid
  // window was silently dropped (see pipeline.js's total-failure branch).
  const sorted = [...rows].sort((a, b) => new Date(a.windowEnd) - new Date(b.windowEnd));
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const dtSec = (new Date(sorted[i].windowStart) - new Date(sorted[i - 1].windowEnd)) / 1000;
    if (dtSec > 90) {
      gaps.push({ from: sorted[i - 1].windowEnd, to: sorted[i].windowStart, gapSeconds: Math.round(dtSec) });
    }
  }

  console.log(`\nPreprocessing quality report — last ${rows.length} window(s)`);
  console.log('='.repeat(60));
  console.log(`Quality label distribution: ${JSON.stringify(labelCounts)}`);
  console.log(`Avg qualityScore:     ${avg('qualityScore').toFixed(2)}`);
  console.log(`Avg missingRate:      ${avg('missingRate').toFixed(4)}  (max ${max('missingRate').toFixed(4)})`);
  console.log(`Avg imputationRate:   ${avg('imputationRate').toFixed(4)}  (max ${max('imputationRate').toFixed(4)})`);
  console.log(`Avg outlierRate:      ${avg('outlierRate').toFixed(4)}  (max ${max('outlierRate').toFixed(4)})`);
  console.log(`Avg physicsPassRate:  ${avg('physicsPassRate').toFixed(4)}  (min ${Math.min(...rows.map((r) => r.physicsPassRate)).toFixed(4)})`);
  console.log(`Windows with any imputation: ${count((r) => r.isImputed)} / ${rows.length}`);
  console.log(`Windows below GOOD (FAIR/POOR): ${count((r) => r.qualityLabel !== 'GOOD')} / ${rows.length}`);

  if (gaps.length > 0) {
    console.log(`\nSkipped windows detected (all samples failed physics validation): ${gaps.length}`);
    for (const g of gaps) {
      console.log(`  ${g.from} -> ${g.to}  (~${g.gapSeconds}s gap)`);
    }
  } else {
    console.log('\nNo skipped windows detected in this range.');
  }

  console.log('');
}

try {
  await main();
} finally {
  // Without this, the pool's open connections keep the event loop alive and
  // the script never exits on its own.
  await pool.end();
}
