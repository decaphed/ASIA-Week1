// ─────────────────────────────────────────────────────────────────────────
// pipeline.js — the single public entry point for the preprocessing
// pipeline: processSample(sample).
//
// Cutover (docs/plan/2026-08-05-pdm-implementation.md §11.6.3): window-close
// computation (gap-fill, physics validation, physics-invalid-run repair,
// Hampel-filtered outlier capping, aggregation, precap features, quality
// scoring) no longer runs locally — it's a single synchronous HTTP call to
// the Python pdm/ service's POST /process-window (§11.2), which returns
// both the full processed_telemetry row shape and the Tier 1 verdict.
// Node's job here is now: raw ingestion, event-time windowing/buffering
// (unchanged, still buffer.js), and persisting whatever Python computed.
//
// This means Node no longer generates IMPUTED gap-fill rows at ingest time,
// and no longer computes physicsValid/physicsViolations locally —
// raw_telemetry rows Node writes directly fall back to the DB's own
// defaults (physicsValid=TRUE, provenance='MEASURED'; see
// server/database/migrations/001_init.up.sql) rather than reflecting a
// real per-row Node-computed value. Nothing outside the now-retired local
// preprocessing modules reads those two raw_telemetry columns today
// (verified against the import graph during Phase 3's design), so this is
// an accepted, intentional semantic narrowing, not an oversight.
//
// Workflow:
//   1. Classify the incoming sample's timestamp -> buffer.js::classify()
//      (ACCEPTED | DUPLICATE | MERGED | REJECTED_STALE)
//   2. Store raw sample as-is -> sensorService.saveReading
//   3. DUPLICATE/REJECTED_STALE stop here — stored for audit, never buffered.
//   4. ACCEPTED/MERGED: commit into the event-time-windowed buffer ->
//      buffer.js.
//   5. Any window(s) that just closed (0, 1, or several on a multi-boundary
//      jump) get handed to Python via POST /process-window; a successful
//      response is persisted + triggers forecast/drift/trend/PdM exactly as
//      a Node-computed row did before this cutover.
//
// A background sweep (see runBackgroundSweep(), wired into server.js) force-
// closes any window whose event-time boundary has passed even with no new
// sample arriving, since ingestion is otherwise entirely push-driven.
//
// CONCURRENCY / LOCK SCOPING (§11.6.3's explicit call-out, easy to get
// wrong): withLock() (ingestLock.js) wraps ONLY the in-memory
// classify+commit step below — never the POST /process-window HTTP call,
// never the resulting processed_telemetry DB write. If the Python call ran
// inside the lock, every concurrent POST /api/data request would serialize
// behind one window's ~2s Python round-trip, a much worse regression than
// "the one request that closes a window gets slower." processSampleLocked()/
// runBackgroundSweepLocked() are private and only ever run from inside an
// already-locked call; processClosedWindowViaPython() runs strictly AFTER
// the lock is released, in the public processSample()/runBackgroundSweep()
// entry points below.
// ─────────────────────────────────────────────────────────────────────────

import { classify, commit, closeExpiredWindows } from './buffer.js';
import * as sensorService from '../services/sensorService.js';
import * as processedService from '../services/processedService.js';
import { logger } from '../utils/logger.js';
import { withLock } from './ingestLock.js';

const PDM_SERVICE_URL = process.env.PDM_SERVICE_URL || 'http://localhost:8000';
// Matches pdmService.js's existing /score budget (§11.5 item 1) — reusing
// the same env var and timeout convention, not a second, differently-
// configured HTTP client (§11.6.4).
const PROCESS_WINDOW_TIMEOUT_MS = 2000;

/** Strip a stored raw-reading row down to the flat shape pdm/app/schemas.py's
 * WindowSampleIn expects — no id/provenance/physicsValid/etc.; Python
 * computes all of that fresh per window (pdm/app/preprocessing/pipeline.py's
 * _build_audit_window). extra fields would be ignored by Pydantic's
 * extra="ignore" regardless, but sending exactly the intended shape keeps
 * the contract explicit rather than relying on that as a safety net. */
function toWindowSampleIn(sample) {
  return {
    timestamp: sample.timestamp,
    status: sample.status,
    faultType: sample.faultType ?? null,
    flowRate: sample.flowRate,
    rpm: sample.rpm,
    vibration: sample.vibration,
    suctionPressure: sample.suctionPressure,
    dischargePressure: sample.dischargePressure,
    motorTemp: sample.motorTemp,
  };
}

/**
 * Send one closed window to Python, and persist+trigger on success.
 *
 * Runs entirely OUTSIDE withLock() — see this file's header comment. On any
 * failure (network error/timeout, non-2xx response, or a downstream
 * persistence error), logs and returns: no processed_telemetry insert, no
 * forecast/drift/trend/PdM trigger calls for this window. raw_telemetry is
 * completely unaffected either way — every sample in `win` was already
 * saved by ingestSample() before this ever runs.
 *
 * @param {object} win a closed WindowState (buffer.js). Its own
 *   `win.prevSample` (captured by buffer.js at the moment this window was
 *   FIRST created, before its own first sample was ever committed) is the
 *   cross-window continuity context Python's gap-fill needs (§11.2) — NOT
 *   something computed here. Reading the live getLastSample() pointer at
 *   window-CLOSE time would return this window's own last sample instead
 *   of its true predecessor, since that pointer advances on every
 *   ACCEPTED commit including this window's own — a real bug caught
 *   during Phase 3's review; buffer.js now owns this bookkeeping per
 *   window instead.
 */
async function processClosedWindowViaPython(win) {
  if (win.samples.length === 0) return;

  const payload = {
    windowSamples: win.samples.map(toWindowSampleIn),
    prevSample: win.prevSample ? toWindowSampleIn(win.prevSample) : null,
    windowStart: win.windowStart,
    windowEnd: win.windowEnd,
    mergedSampleCount: win.mergedSampleCount || 0,
    // buffer.js never actually sets a duplicateCount field on WindowState
    // (only mergedSampleCount is mutated in commit()) — this is a
    // pre-existing no-op inherited unchanged from the prior local-
    // computation code, not introduced by this cutover; always 0 today.
    duplicateSampleCount: win.duplicateCount || 0,
  };

  let res;
  try {
    res = await fetch(`${PDM_SERVICE_URL}/process-window`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PROCESS_WINDOW_TIMEOUT_MS),
    });
  } catch (err) {
    logger.error(`pipeline: /process-window call failed for window ${win.windowStart}-${win.windowEnd}: ${err.stack || err.message}`);
    return;
  }

  if (!res.ok) {
    // Covers both a malformed-request 422 (Pydantic validation) and an
    // all-samples-invalid 422 (AllSamplesInvalidError) — both collapse to
    // the same "nothing to process, skip this window" outcome here; see
    // pdm/app/main.py's process_window_endpoint docstring for the
    // full detail-shape distinction, not needed by this skip-logic.
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // response body wasn't JSON — ignore, status code alone is enough context.
    }
    logger.warn(`pipeline: /process-window responded ${res.status} for window ${win.windowStart}-${win.windowEnd} — skipping. ${detail}`);
    return;
  }

  try {
    const { processedRecord, tier1Verdict } = await res.json();
    // tier1Verdict: already computed by pdm in the same call — passed
    // through so pdmService.js's downstream fault_events hook doesn't
    // redundantly POST /score a second time for data it already scored
    // (§11.6.3's deferred cleanup item, now done).
    await processedService.saveAndTrigger(processedRecord, tier1Verdict);
  } catch (err) {
    logger.error(`pipeline: failed to persist Python-computed window (window ${win.windowStart}-${win.windowEnd}): ${err.stack || err.message}`);
  }
}

/**
 * Validate (hard-reject already happened in middleware), store, and (for
 * ACCEPTED/MERGED only) buffer ONE sample. No local gap-fill or physics
 * validation — see this file's header comment.
 *
 * @param {object} rawSample metrics + status + timestamp.
 * @param {'ACCEPTED'|'DUPLICATE'|'MERGED'|'REJECTED_STALE'} classification
 * @returns the saved reading (API shape).
 */
async function ingestSample(rawSample, classification) {
  // Store every sample, unconditionally — including DUPLICATE/
  // REJECTED_STALE, so raw_telemetry keeps a complete audit trail even for
  // samples that never enter a window.
  const savedReading = await sensorService.saveReading(rawSample);

  if (classification === 'DUPLICATE' || classification === 'REJECTED_STALE') {
    return { savedReading, closedWindows: [] };
  }

  const closedWindows = commit(savedReading, classification);
  return { savedReading, closedWindows };
}

async function processSampleLocked(sample) {
  const tsMs = Date.parse(sample.timestamp);
  const classification = classify(tsMs);
  const { savedReading, closedWindows } = await ingestSample(sample, classification);
  return { savedReading, classification, closedWindows };
}

/**
 * Process one incoming raw telemetry sample: classify it against the
 * event-time windowed buffer, store it, and hand off any window(s) that
 * close as a result to Python for computation — see this file's header
 * comment for the full lock-scoping rationale.
 *
 * @param {object} sample raw sample as POSTed to /api/data.
 * @returns the saved raw reading for `sample` (same shape dataController.js
 *   has always returned), plus accepted/reason/duplicate flags for
 *   DUPLICATE/REJECTED_STALE outcomes.
 */
export async function processSample(sample) {
  const { savedReading, classification, closedWindows } =
    await withLock(() => processSampleLocked(sample));

  // Unlocked phase: one Python round-trip (+ persistence) per closed
  // window, entirely outside the mutex. Each WindowState already carries
  // its own correct `prevSample` (buffer.js captured it at that window's
  // creation time) — no threading needed here, including for a multi-
  // boundary-jump batch where several windows close at once.
  for (const win of closedWindows) {
    await processClosedWindowViaPython(win);
  }

  if (classification === 'REJECTED_STALE') {
    return { ...savedReading, accepted: false, reason: 'STALE' };
  }
  if (classification === 'DUPLICATE') {
    return { ...savedReading, accepted: true, duplicate: true };
  }
  return savedReading;
}

async function runBackgroundSweepLocked() {
  return closeExpiredWindows(Date.now());
}

/**
 * Force-close and process any window whose event-time boundary has passed,
 * even with no new sample arriving — called on a wall-clock interval from
 * server.js, since ingestion is otherwise entirely push-driven and a fully
 * silent stream would otherwise never close its last window.
 */
export async function runBackgroundSweep() {
  const closedWindows = await withLock(() => runBackgroundSweepLocked());
  for (const win of closedWindows) {
    await processClosedWindowViaPython(win);
  }
}
