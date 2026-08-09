// ─────────────────────────────────────────────────────────────────────────
// pdmService.js — Tier 1 predictive-maintenance hook, wired into
// processedService.saveAndTrigger() the same way forecast/drift/trend are
// (see docs/plan/2026-08-05-pdm-implementation.md §3.4).
//
// onNewProcessedRecord(data, processedTelemetryId) fires a fire-and-forget
// POST to the Python pdm/ service and, once a response arrives, persists a
// fault_events row via faultEventService.js. Node owns every fault_events
// write — Python never touches SQLite directly (§3.4, already-settled
// process boundary).
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

/**
 * @param data flat, pre-insert processedRecord — the same shape POSTed
 *   verbatim as forecast/drift/trend's `data` argument.
 * @param processedTelemetryId the just-inserted row's id — the one extra
 *   value PdM alone needs, for fault_events.processedTelemetryId.
 */
export function onNewProcessedRecord(data, processedTelemetryId) {
  windowCounter += 1;
  const shouldTryNegativeSample = windowCounter % PDM_NEGATIVE_SAMPLE_RATE === 0;

  fetch(`${PDM_SERVICE_URL}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(SCORE_TIMEOUT_MS),
  })
    .then(async (res) => {
      if (!res.ok) {
        throw new Error(`pdm /score responded ${res.status}`);
      }
      const verdict = await res.json();

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
      logger.error(`pdmService: /score call failed: ${err.stack || err.message}`);
    });
}
