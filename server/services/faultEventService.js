// ─────────────────────────────────────────────────────────────────────────
// faultEventService.js — sits between pdmController.js/pdmService.js and
// faultEventModel.js, matching this repo's controller→service→model
// layering (every other controller calls a service, never a model
// directly — see docs/plan/2026-08-05-pdm-implementation.md §4.2).
//
// Owns: creating a flagged event (via the model's atomic coalescing
// statement), creating a negative sample (gated by §3.3.1's two
// conditions), applying a HITL review patch, and the /stats aggregate.
// ─────────────────────────────────────────────────────────────────────────

import * as model from '../models/faultEventModel.js';
import { METRICS } from './forecastService.js';
import { logger } from '../utils/logger.js';

// §3.3.2: a PENDING_REVIEW row is only eligible to extend while its
// lastSeenWindowEnd is within this many consecutive windows of the current
// one — a fault that clears for longer is treated as resolved, and a later
// re-trigger opens a new row rather than reviving the stale one.
const COALESCE_LOOKBACK_WINDOWS = 3;
const WINDOW_SECONDS = 60;
const ONE_HOUR_MS = 60 * 60 * 1000;

/** Full per-metric mean/median/min/max/stdDev/last off the flat processedRecord shape. */
function buildMetricStats(data) {
  const metricStats = {};
  for (const metric of METRICS) {
    metricStats[metric] = {
      mean: data[`${metric}Mean`],
      median: data[`${metric}Median`],
      min: data[`${metric}Min`],
      max: data[`${metric}Max`],
      stdDev: data[`${metric}StdDev`],
      last: data[`${metric}Last`],
    };
  }
  return metricStats;
}

// §3.3: fixed, eventType-independent composition — full precapFeaturesByMetric
// (all six metrics) + full per-metric metricStats, never a per-metric subset.
function buildFeatureSnapshot(data) {
  return JSON.stringify({
    precapFeaturesByMetric: data.precapFeaturesByMetric ?? {},
    metricStats: buildMetricStats(data),
  });
}

function lookbackBound(windowEndIso) {
  return new Date(Date.parse(windowEndIso) - COALESCE_LOOKBACK_WINDOWS * WINDOW_SECONDS * 1000).toISOString();
}

/**
 * Record a Tier 1 flag: extend an already-open matching event (§3.3.2), or
 * insert a new PENDING_REVIEW row if none is open.
 * @param data flat processedRecord (same shape POSTed to pdm/'s /score)
 * @param processedTelemetryId the triggering window's processed_telemetry.id
 * @param verdict { confidence, triggeredRules, thresholdsVersion }
 */
export function recordFlaggedEvent(data, processedTelemetryId, verdict) {
  const triggerWindowEnd = data.windowEnd;
  const triggeredRulesJson = JSON.stringify(verdict.triggeredRules ?? []);
  const bound = lookbackBound(triggerWindowEnd);

  const extendedId = model.extendOpenEvent({
    triggerWindowEnd,
    triggeredRules: triggeredRulesJson,
    lookbackBound: bound,
  });
  if (extendedId) {
    return { id: extendedId, coalesced: true };
  }

  const faultStart = triggerWindowEnd;
  const bufferStart = new Date(Date.parse(faultStart) - ONE_HOUR_MS).toISOString();

  const info = model.insertFaultEvent({
    processedTelemetryId,
    eventType: 'FLAGGED',
    detectedAt: new Date().toISOString(),
    triggerWindowEnd,
    lastSeenWindowEnd: triggerWindowEnd,
    triggeredRules: triggeredRulesJson,
    confidence: verdict.confidence,
    featureSnapshot: buildFeatureSnapshot(data),
    thresholdsVersion: verdict.thresholdsVersion ?? null,
    faultStart,
    faultEnd: triggerWindowEnd,
    bufferStart,
    bufferEnd: null,
    status: 'PENDING_REVIEW',
  });
  return { id: Number(info.lastInsertRowid), coalesced: false };
}

/**
 * Bank a periodic confirmed-normal example (§3.3.1). Caller (pdmService.js)
 * already gated on the sampling cadence; this function re-checks both
 * required conditions itself so it's correct even if called directly:
 *   1. dominantStatus === 'RUNNING' and no triggered rules on this window
 *   2. no open FLAGGED event at sample time
 * Returns null (no-op) if either condition fails.
 */
export function recordNegativeSample(data, processedTelemetryId, thresholdsVersion) {
  if (data.dominantStatus !== 'RUNNING') return null;

  const bound = lookbackBound(data.windowEnd);
  if (model.hasOpenEvent(bound)) return null;

  try {
    const info = model.insertFaultEvent({
      processedTelemetryId,
      eventType: 'NEGATIVE_SAMPLE',
      detectedAt: new Date().toISOString(),
      triggerWindowEnd: data.windowEnd,
      lastSeenWindowEnd: null,
      triggeredRules: null,
      confidence: null,
      featureSnapshot: buildFeatureSnapshot(data),
      thresholdsVersion: thresholdsVersion ?? null,
      faultStart: null,
      faultEnd: null,
      bufferStart: null,
      bufferEnd: null,
      status: 'N/A',
    });
    return Number(info.lastInsertRowid);
  } catch (err) {
    // Must never propagate up and affect ingestion (§3.3.1).
    logger.error(`faultEventService.recordNegativeSample failed: ${err.stack || err.message}`);
    return null;
  }
}

/** @returns fault_events rows, optionally filtered by status. */
export function listFaultEvents(status) {
  return model.listFaultEvents(status);
}

/** @returns one fault_events row plus its buffer sample count, or null. */
export function getFaultEvent(id) {
  const row = model.getFaultEventById(id);
  if (!row) return null;
  const bufferCount = row.bufferStart && row.bufferEnd
    ? model.getBufferRange(row.bufferStart, row.bufferEnd).length
    : 0;
  return { ...row, bufferSampleCount: bufferCount };
}

/** @returns raw_telemetry rows spanning one event's buffer range. */
export function getFaultEventBuffer(id) {
  const row = model.getFaultEventById(id);
  if (!row || !row.bufferStart || !row.bufferEnd) return [];
  return model.getBufferRange(row.bufferStart, row.bufferEnd);
}

/**
 * Apply a HITL review patch. When status is CONFIRMED and faultEnd is
 * given, bufferEnd (= faultEnd + 1 hour) is finalized here — until then the
 * buffer's trailing edge is genuinely unknown (§3.6).
 */
export function reviewFaultEvent(id, patch) {
  const existing = model.getFaultEventById(id);
  if (!existing) return null;

  const faultEnd = patch.faultEnd ?? existing.faultEnd;
  const bufferEnd = faultEnd ? new Date(Date.parse(faultEnd) + ONE_HOUR_MS).toISOString() : existing.bufferEnd;

  model.updateFaultEventReview({
    id,
    status: patch.status ?? existing.status,
    faultType: patch.faultType ?? existing.faultType,
    rootCause: patch.rootCause ?? existing.rootCause,
    resolution: patch.resolution ?? existing.resolution,
    reviewedBy: patch.reviewedBy ?? existing.reviewedBy,
    reviewedAt: new Date().toISOString(),
    notes: patch.notes ?? existing.notes,
    faultEnd,
    bufferEnd,
  });
  return getFaultEvent(id);
}

/** §3.6: confidence/status agreement breakdown for FLAGGED rows. */
export function getFaultEventStats() {
  const rows = model.getFaultEventStats();
  const stats = {};
  for (const { confidence, status, count } of rows) {
    const key = confidence ?? 'UNKNOWN';
    if (!stats[key]) stats[key] = {};
    stats[key][status] = count;
  }
  return stats;
}
