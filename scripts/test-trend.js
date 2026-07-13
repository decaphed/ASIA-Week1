// scripts/test-trend.js — feeds a synthetic, accelerating monotonic ramp
// straight into POST /api/processed (bypassing raw ingestion + the 60-sample
// aggregation window) so the trend engine's Mann-Kendall/Theil-Sen check has
// enough real, consistently-trending processed rows to actually fire.
//
// Why this exists: a single manual reading via the dashboard's "Manual
// Reading" form only nudges a 60-sample rolling average by ~1/60th, and even
// a full processed row can't move the trend label by itself — trendService.js
// needs WINDOW=10 RUNNING rows with a statistically significant
// (Mann-Kendall Z>1.96) monotonic slope, plus a 2-evaluation debounce,
// before "Holding steady" changes to anything else.
//
// The ramp runs in 3 back-to-back PHASES at increasing rates, one targeting
// each magnitude bucket (slight -> moderate -> sharp), each long enough to
// fill trendService's 10-row window at that rate AND clear its 2-evaluation
// debounce — so the Analytics tab visibly steps "Holding steady" ->
// "Slightly ..." -> "Moderately ..." -> "Sharply Increasing/Decreasing"
// instead of jumping straight to the final grade.
//
// The ramp is ANCHORED to the metric's current live reading (fetched from
// GET /api/processed/live) rather than a fixed operating-range fraction —
// starting from an arbitrary fixed value regardless of where the sensor
// actually sits would draw a visible discontinuity (a vertical jump) on the
// dashboard chart the moment these rows land, since LiveChart just plots
// posted points in sequence with no continuity check. If there's no live
// reading yet (fresh DB), it falls back to the old fixed 30%-into-range start.
//
// Caveat: this reads/writes processed_telemetry like any other producer. If
// a live simulator/raw ingestion pipeline is also running concurrently, its
// rows can interleave with this script's backdated rows and disturb the
// clean ramp trendService's window sees — for a predictable demo, pause
// other ingestion (or accept some noise) while this runs.
//
// Usage: node scripts/test-trend.js [--metric=flowRate] [--direction=up] [--base=http://localhost:3000]

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const BASE_URL = args.base || 'http://localhost:3000';
const METRIC = args.metric || 'flowRate';
const DIRECTION = args.direction === 'down' ? -1 : 1;

// Mirrors server/services/trendService.js OPERATING_RANGE.
const METRIC_INFO = {
  flowRate: { min: 50, max: 300, unit: 'L/min' },
  rpm: { min: 1000, max: 3600, unit: 'rpm' },
  vibration: { min: 0.5, max: 12, unit: 'mm/s' },
  suctionPressure: { min: 0.5, max: 3, unit: 'bar' },
  dischargePressure: { min: 2, max: 12, unit: 'bar' },
  motorTemp: { min: 20, max: 90, unit: 'C' },
};

if (!METRIC_INFO[METRIC]) {
  console.error(`Unknown metric "${METRIC}". Choose one of: ${Object.keys(METRIC_INFO).join(', ')}`);
  process.exit(1);
}

const { min, max } = METRIC_INFO[METRIC];
const range = max - min;

// Rows land 1 simulated minute apart, so for trendService's WINDOW=10
// rows the span across a full window is 9 minutes, and the Theil-Sen slope
// of a straight line at stepPct/row works out to rangePct = stepPct * 900
// (see server/services/trendService.js classify()'s rangePct formula).
// Each phase's stepPct is picked to land mid-bucket against
// ENTER_THRESHOLDS=[0,2,5,15]:
//   slight:   stepPct 0.0035 -> rangePct ~3.15  (bucket [2,5))
//   moderate: stepPct 0.009  -> rangePct ~8.1   (bucket [5,15))
//   sharp:    stepPct 0.02   -> rangePct ~18    (bucket [15,+))
// `rows: 12` per phase = 10 to fully displace the previous phase's rows out
// of trendService's 10-row window, + 2 more evaluations to clear the
// debounce (a label must differ from the currently PUBLISHED one for 2
// consecutive evaluations before it publishes — see trendService.js
// classify()), with a little headroom.
const PHASES = [
  { label: 'slight', stepPct: 0.0035, rows: 12 },
  { label: 'moderate', stepPct: 0.009, rows: 12 },
  { label: 'sharp', stepPct: 0.02, rows: 12 },
];
const TOTAL_ROWS = PHASES.reduce((sum, p) => sum + p.rows, 0);
const TOTAL_TRAVERSE = PHASES.reduce((sum, p) => sum + p.stepPct * p.rows, 0) * range;

// Keep the whole ramp inside a 5%-in-from-each-edge safety margin so it
// never approaches the physics hard-reject RANGES in
// server/utils/validation.js regardless of where the live reading sits.
const SAFETY_MARGIN = 0.05;
const SAFE_LO = min + range * SAFETY_MARGIN;
const SAFE_HI = max - range * SAFETY_MARGIN;

const ALL_METRICS = ['flowRate', 'rpm', 'vibration', 'suctionPressure', 'dischargePressure', 'motorTemp'];

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** Anchor the ramp's start to where the metric actually is right now. */
function resolveStartValue(liveValue) {
  let start = Number.isFinite(liveValue) ? liveValue : (DIRECTION > 0 ? min + range * 0.3 : max - range * 0.3);
  start = Math.max(SAFE_LO, Math.min(SAFE_HI, start));

  // If ramping from here would run past the safe edge, slide the start back
  // so the ramp still ends inside bounds — rather than clamping mid-ramp,
  // which would flatten the tail into a false "Stable" plateau.
  const rawEnd = start + DIRECTION * TOTAL_TRAVERSE;
  if (DIRECTION > 0 && rawEnd > SAFE_HI) start = SAFE_HI - TOTAL_TRAVERSE;
  if (DIRECTION < 0 && rawEnd < SAFE_LO) start = SAFE_LO + TOTAL_TRAVERSE;
  return start;
}

/** Full chronological value series for METRIC across every phase. */
function buildValueSeries(startValue) {
  const values = [];
  let current = startValue;
  for (const phase of PHASES) {
    for (let i = 0; i < phase.rows; i++) {
      current += DIRECTION * phase.stepPct * range;
      values.push(current);
    }
  }
  return values;
}

/** A calm baseline for every metric other than the one under test, anchored
 *  to its current live reading (falling back to the operating-range
 *  midpoint) so the other 5 charts stay genuinely "Stable" as a control. */
function baselineFor(metric, latest) {
  const { min: mn, max: mx } = METRIC_INFO[metric];
  const liveValue = latest?.[`${metric}Mean`];
  return Number.isFinite(liveValue) ? liveValue : mn + (mx - mn) * 0.5;
}

function buildRow(value, timestampMs, latest) {
  const windowStart = new Date(timestampMs - 60_000).toISOString();
  const windowEnd = new Date(timestampMs).toISOString();

  const row = {
    windowStart,
    windowEnd,
    timestamp: windowEnd,
    dominantStatus: 'RUNNING',
    // A full RUNNING minute, no faults/stops/gaps/outliers — a clean
    // control window so the only thing changing is the metric under test.
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
    missingRate: 0,
    imputationRate: 0,
    outlierRate: 0,
    physicsPassRate: 1,
    physicsImputationRate: 0,
    qualityScore: 100,
    qualityLabel: 'GOOD',
    isImputed: 0,
    preprocessingVersion: 'test-trend-script',
    preprocessingTimestamp: windowEnd,
  };

  for (const metric of ALL_METRICS) {
    const v = metric === METRIC ? value : baselineFor(metric, latest);
    row[`${metric}Mean`] = round2(v);
    row[`${metric}Median`] = round2(v);
    row[`${metric}Min`] = round2(v);
    row[`${metric}Max`] = round2(v);
    row[`${metric}StdDev`] = 0;
    row[`${metric}Last`] = round2(v);
  }

  return row;
}

async function postRow(row, i) {
  const res = await fetch(`${BASE_URL}/api/processed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(row),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error(`Row ${i}: FAILED (${res.status})`, body);
    process.exit(1);
  }
  console.log(`Row ${i}: ${METRIC}=${row[`${METRIC}Mean`]} @ ${row.timestamp} -> stored id=${body.data?.id ?? body.id}`);
  return body;
}

async function fetchLatestProcessed() {
  const res = await fetch(`${BASE_URL}/api/processed/live`).catch(() => null);
  if (!res || !res.ok) return null;
  const body = await res.json();
  return body.data ?? null;
}

async function fetchTrend() {
  const res = await fetch(`${BASE_URL}/api/trend`).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json();
}

async function main() {
  const latest = await fetchLatestProcessed();
  const startValue = resolveStartValue(latest?.[`${METRIC}Mean`]);
  const values = buildValueSeries(startValue);
  const endValue = round2(values[values.length - 1]);

  console.log(
    (Number.isFinite(latest?.[`${METRIC}Mean`])
      ? `Anchoring to current live ${METRIC} reading (${round2(latest[`${METRIC}Mean`])} ${METRIC_INFO[METRIC].unit}).\n`
      : `No live reading found — starting from a fixed 30%-into-range value.\n`) +
    `Ramping ${METRIC} ${DIRECTION > 0 ? 'up' : 'down'} from ${round2(startValue)} to ${endValue} ` +
    `${METRIC_INFO[METRIC].unit} over ${TOTAL_ROWS} rows in 3 phases (${PHASES.map((p) => p.label).join(' -> ')}), ` +
    `one simulated minute apart.\n`
  );

  // Backdate rows so their timestamps are chronologically ordered and ~1
  // minute apart, ending now — trendService reads them back oldest-first.
  const now = Date.now();
  const startMs = now - (TOTAL_ROWS - 1) * 60_000;

  for (let i = 0; i < TOTAL_ROWS; i++) {
    const row = buildRow(values[i], startMs + i * 60_000, latest);
    await postRow(row, i);
  }

  const trend = await fetchTrend();
  if (trend) {
    const entry = trend.data?.[METRIC] ?? trend[METRIC];
    console.log('\nCurrent /api/trend response for', METRIC, ':', JSON.stringify(entry, null, 2));
  } else {
    console.log('\nCould not fetch /api/trend directly — check the Analytics tab in the UI instead.');
  }

  console.log(`\nDone. Open the Analytics tab and look at the ${METRIC} chart — it should have stepped through Slight -> Moderate -> Sharp ${DIRECTION > 0 ? 'Increasing' : 'Decreasing'}.`);
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
