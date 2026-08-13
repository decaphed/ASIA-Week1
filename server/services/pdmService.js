// ─────────────────────────────────────────────────────────────────────────
// pdmService.js — Tier 1 predictive-maintenance hook, wired into
// processedService.saveAndTrigger() the same way forecast/drift/trend are
// (see docs/plan/2026-08-05-pdm-implementation.md §3.4).
//
// onNewProcessedRecord(data, processedTelemetryId, precomputedVerdict) uses
// a verdict already computed by pdm's POST /process-window if one was
// supplied — since that cutover (§11.2/§11.6.3), pipeline.js's window-close
// call already gets a Tier 1 verdict back in the same response as the
// processedRecord, so scoring it again here via a second POST /score would
// be pure duplicated work (the same rules.evaluate() logic run twice against
// the same data). Falls back to its own fire-and-forget POST /score only
// when no precomputed verdict is available (e.g. the manual/back-compat
// POST /api/processed path, which never goes through pipeline.js at all).
// Either way, once a verdict is in hand, persists a fault_events row via
// faultEventService.js — Node owns every fault_events write, Python never
// touches Postgres directly (§3.4, already-settled process boundary).
// ─────────────────────────────────────────────────────────────────────────

import * as faultEventService from './faultEventService.js';
import { logger } from '../utils/logger.js';

const PDM_SERVICE_URL = process.env.PDM_SERVICE_URL || 'http://localhost:8000';
const PDM_NEGATIVE_SAMPLE_RATE = parseInt(process.env.PDM_NEGATIVE_SAMPLE_RATE, 10) || 60;
const SCORE_TIMEOUT_MS = 2000;

// In-process only, reset on restart (§3.3.1) — acceptable since
// under-sampling by a few windows after a restart has no correctness
// impact, only a minor density one.
let windowCounter = 0;

async function fetchScore(data) {
  const res = await fetch(`${PDM_SERVICE_URL}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(SCORE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`pdm /score responded ${res.status}`);
  }
  return res.json();
}

/**
 * @param data flat, pre-insert processedRecord — the same shape POSTed
 *   verbatim as forecast/drift/trend's `data` argument.
 * @param processedTelemetryId the just-inserted row's id — the one extra
 *   value PdM alone needs, for fault_events.processedTelemetryId.
 * @param precomputedVerdict a Tier 1 verdict already returned by pdm's
 *   POST /process-window (pipeline.js's window-close call), if available —
 *   skips this function's own POST /score entirely when supplied, since
 *   that would just recompute the identical verdict a second time.
 */
export function onNewProcessedRecord(data, processedTelemetryId, precomputedVerdict = null) {
  windowCounter += 1;
  const shouldTryNegativeSample = windowCounter % PDM_NEGATIVE_SAMPLE_RATE === 0;

  const verdictPromise = precomputedVerdict ? Promise.resolve(precomputedVerdict) : fetchScore(data);

  verdictPromise
    .then(async (verdict) => {
      if (verdict.flagged) {
        // recordNegativeSample already catches its own errors internally
        // (§3.3.1: must never affect ingestion); recordFlaggedEvent does
        // not, so an await + catch here is required to avoid an unhandled
        // promise rejection (fault_events doesn't exist until PdM's own
        // migration — every call rejects until then).
        await faultEventService.recordFlaggedEvent(data, processedTelemetryId, verdict).catch((err) => {
          logger.error(`faultEventService.recordFlaggedEvent failed: ${err.stack || err.message}`);
        });
      } else if (shouldTryNegativeSample) {
        await faultEventService.recordNegativeSample(data, processedTelemetryId, verdict.thresholdsVersion);
      }
    })
    // The outer try/catch in saveAndTrigger only guards a synchronous
    // throw — it never sees a rejected promise from this fire-and-forget
    // call. Without this .catch(), a network failure or timeout becomes an
    // unhandled promise rejection instead of a logged error (§3.4, §5.6).
    .catch((err) => {
      logger.error(`pdmService: verdict handling failed: ${err.stack || err.message}`);
    });
}
