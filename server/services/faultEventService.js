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
import * as processedModel from '../models/processedModel.js';
import * as sensorModel from '../models/sensorModel.js';
import * as processedService from './processedService.js';
import { WINDOW_DURATION_SECONDS } from '../preprocessing/config.js';
import { buildFeatureSnapshot } from '../utils/featureSnapshot.js';
import * as corpusMaterializationService from './corpusMaterializationService.js';
import { logger } from '../utils/logger.js';

// §3.3.2: a PENDING_REVIEW row is only eligible to extend while its
// lastSeenWindowEnd is within this many consecutive windows of the current
// one — a fault that clears for longer is treated as resolved, and a later
// re-trigger opens a new row rather than reviving the stale one.
const COALESCE_LOOKBACK_WINDOWS = 3;
const WINDOW_SECONDS = 60;
const ONE_HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = WINDOW_DURATION_SECONDS * 1000;
const PDM_SERVICE_URL = process.env.PDM_SERVICE_URL || 'http://localhost:8000';
const PROCESS_WINDOW_TIMEOUT_MS = 2000;

function lookbackBound(windowEndIso) {
  return new Date(Date.parse(windowEndIso) - COALESCE_LOOKBACK_WINDOWS * WINDOW_SECONDS * 1000).toISOString();
}

/** True if a and b contain exactly the same rule strings, order-independent. */
function sameRuleSet(a, b) {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((rule) => setB.has(rule));
}

/**
 * Auto-labeling: if triggeredRules is an exact-set match for a rule
 * signature a human has already reviewed and CONFIRMED, a newly-flagged
 * event can inherit that label instead of going to PENDING_REVIEW (the
 * user's request — same fault signature shouldn't need re-classifying by
 * hand every time it recurs). Only matches against human-reviewed rows
 * ("autoLabeled" = false, enforced in the model query) so a label can never
 * propagate through a chain of prior auto-labels.
 * @returns the most recently reviewed exact match, or null.
 */
async function findAutoLabelSource(triggeredRules) {
  if (!triggeredRules.length) return null;
  const candidates = await model.findRecentConfirmedByRuleCount(triggeredRules.length);
  return candidates.find((c) => sameRuleSet(triggeredRules, c.triggeredRules)) ?? null;
}

/**
 * §15.4/D54: which tier(s) actually flagged this window — verdict.flagged
 * is Tier 1's own boolean; verdict.tier2Label === 'FAULT' is Tier 2's.
 * Callers only reach recordFlaggedEvent when at least one is true
 * (pdmService.js's gate), so exactly one of TIER1_RULE/TIER2_MODEL/BOTH
 * always applies here — never a silent default.
 */
function derivePredictionSource(verdict) {
  const tier1 = !!verdict.flagged;
  const tier2 = verdict.tier2Label === 'FAULT';
  if (tier1 && tier2) return 'BOTH';
  if (tier2) return 'TIER2_MODEL';
  return 'TIER1_RULE';
}

/**
 * Record a flag — Tier 1, Tier 2, or both (§15.4/D54): extend an already-
 * open matching event (§3.3.2, extended to also coalesce Tier-2-only
 * detections — see faultEventModel.js::extendOpenEvent), or insert a new
 * row if none is open — CONFIRMED and auto-labeled if this exact rule
 * signature has been human-reviewed before, otherwise PENDING_REVIEW as
 * usual.
 * @param data flat processedRecord (same shape POSTed to pdm/'s /score)
 * @param processedTelemetryId the triggering window's processed_telemetry.id
 * @param verdict { confidence, triggeredRules, thresholdsVersion,
 *   flagged, tier2Label?, tier2Probability? }
 */
export async function recordFlaggedEvent(data, processedTelemetryId, verdict) {
  const triggerWindowEnd = data.windowEnd;
  const triggeredRules = verdict.triggeredRules ?? [];
  const triggeredRulesJson = JSON.stringify(triggeredRules);
  const bound = lookbackBound(triggerWindowEnd);

  const predictionSource = derivePredictionSource(verdict);
  // §15.1/D56, persistence-layer derivation (§15.3) — NOT the model's own
  // wire shape (tier2Label/tier2Probability): 0/1 + a bare confidence
  // number, exactly what a HITL reviewer sees next to this specific event.
  const tier2FaultStatus = verdict.tier2Label != null ? (verdict.tier2Label === 'FAULT' ? 1 : 0) : null;
  const tier2Confidence = verdict.tier2Probability ?? null;

  const extendedId = await model.extendOpenEvent({
    triggerWindowEnd,
    // Raw array, not triggeredRulesJson — extendOpenEvent's own SQL call
    // does JSON.stringify(triggeredRules) internally; passing the already-
    // stringified string here double-encodes it into a jsonb *string*
    // scalar (e.g. '"[]"' instead of '[]'), which jsonb_array_length/
    // jsonb_array_elements_text then reject with "cannot get array length
    // of a scalar" — breaks coalescing for every flag, Tier 1 or Tier 2.
    triggeredRules,
    lookbackBound: bound,
    predictionSource,
    tier2FaultStatus,
    tier2Confidence,
  });
  if (extendedId) {
    return { id: extendedId, coalesced: true, autoLabeled: false };
  }

  const faultStart = triggerWindowEnd;
  const bufferStart = new Date(Date.parse(faultStart) - ONE_HOUR_MS).toISOString();

  const autoLabelSource = await findAutoLabelSource(triggeredRules);
  const nowIso = new Date().toISOString();

  const record = {
    processedTelemetryId,
    eventType: 'FLAGGED',
    detectedAt: nowIso,
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
    predictionSource,
    tier2FaultStatus,
    tier2Confidence,
  };

  if (autoLabelSource) {
    record.status = 'CONFIRMED';
    record.faultType = autoLabelSource.faultType;
    record.rootCause = autoLabelSource.rootCause;
    record.resolution = autoLabelSource.resolution;
    record.reviewedBy = 'auto-label';
    record.reviewedAt = nowIso;
    record.bufferEnd = new Date(Date.parse(triggerWindowEnd) + ONE_HOUR_MS).toISOString();
    record.notes = `Auto-labeled: identical trigger signature to fault event #${autoLabelSource.id}`;
    record.autoLabeled = true;
    record.autoLabeledFromEventId = autoLabelSource.id;
    logger.info(`faultEventService: auto-labeled new event from fault event #${autoLabelSource.id} (${record.faultType})`);
  }

  const info = await model.insertFaultEvent(record);
  return { id: Number(info.lastInsertRowid), coalesced: false, autoLabeled: !!autoLabelSource };
}

/**
 * Bank a periodic confirmed-normal example (§3.3.1). Caller (pdmService.js)
 * already gated on the sampling cadence; this function re-checks both
 * required conditions itself so it's correct even if called directly:
 *   1. dominantStatus === 'RUNNING' and no triggered rules on this window
 *   2. no open FLAGGED event at sample time
 * Returns null (no-op) if either condition fails.
 */
export async function recordNegativeSample(data, processedTelemetryId, thresholdsVersion) {
  if (data.dominantStatus !== 'RUNNING') return null;

  const bound = lookbackBound(data.windowEnd);
  if (await model.hasOpenEvent(bound)) return null;

  try {
    const info = await model.insertFaultEvent({
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
    const eventId = Number(info.lastInsertRowid);
    try {
      await corpusMaterializationService.materializeNegativeSample(eventId);
    } catch (corpusErr) {
      // Must never propagate up and affect ingestion (§3.3.1) — same
      // discipline as the outer try/catch this sits inside.
      logger.error(`corpusMaterializationService.materializeNegativeSample failed for fault_events#${eventId}: ${corpusErr.stack || corpusErr.message}`);
    }
    return eventId;
  } catch (err) {
    // Must never propagate up and affect ingestion (§3.3.1).
    logger.error(`faultEventService.recordNegativeSample failed: ${err.stack || err.message}`);
    return null;
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

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
 * Default trigger-window resolution when the operator doesn't supply an
 * explicit triggerWindowEnd: the latest window boundary at or before
 * faultEnd, unless that boundary sits at/before faultStart (a fault period
 * shorter than one window) — in that case, the earliest window boundary at
 * or after faultStart instead. Either way the result is later
 * bounds-checked against [faultStart, faultEnd] before use (see
 * createManualBufferEvent) — this function is a starting guess, not the
 * final authority.
 */
function resolveDefaultWindowEndMs(faultStartMs, faultEndMs) {
  const latestBoundaryAtOrBeforeEnd = Math.floor(faultEndMs / WINDOW_MS) * WINDOW_MS;
  if (latestBoundaryAtOrBeforeEnd > faultStartMs) return latestBoundaryAtOrBeforeEnd;
  return Math.ceil(faultStartMs / WINDOW_MS) * WINDOW_MS;
}

/**
 * §10.4 Entry point 1 — an operator retroactively confirms a fault over a
 * raw_telemetry range that already exists but was never flagged by Tier 1
 * or never reviewed. Unlike recordFlaggedEvent (an automated candidate
 * needing HITL review), this is a human directly asserting ground truth,
 * so the row is created CONFIRMED immediately — no PENDING_REVIEW step
 * (§10.4's explicit resolution).
 *
 * @param body { faultStart, faultEnd, faultType, rootCause, resolution,
 *   notes, triggerWindowEnd? } — already validated by the controller via
 *   pdmManualBufferValidation.js.
 * @param reviewedBy the resolved actor identity (controller resolves
 *   req.identity?.username vs. client-supplied value, same as reviewFaultEvent).
 * @throws an Error with .status 422 (no raw_telemetry data in range),
 *   409 (overlaps an existing fault_events row), or 502 (pdm's
 *   /process-window call failed during Path B reconstruction).
 */
export async function createManualBufferEvent(body, reviewedBy) {
  const faultStart = new Date(body.faultStart).toISOString();
  const faultEnd = new Date(body.faultEnd).toISOString();
  const faultStartMs = Date.parse(faultStart);
  const faultEndMs = Date.parse(faultEnd);

  const dataCount = await sensorModel.getCountInRange(faultStart, faultEnd);
  if (dataCount === 0) {
    throw httpError(422, `no raw_telemetry data in [${faultStart}, ${faultEnd}]`);
  }

  const overlaps = await model.findOverlappingFaultEvents(faultStart, faultEnd);
  if (overlaps.length > 0) {
    const ids = overlaps.map((o) => `#${o.id} (${o.status})`).join(', ');
    throw httpError(409, `overlaps existing fault event(s): ${ids}`);
  }

  const windowEndMs = body.triggerWindowEnd
    ? Date.parse(new Date(body.triggerWindowEnd).toISOString())
    : resolveDefaultWindowEndMs(faultStartMs, faultEndMs);
  const windowStartMs = windowEndMs - WINDOW_MS;

  // Safety net (not just trusting the resolution above, whether explicit or
  // default): the chosen window must actually overlap the requested fault
  // period, or featureSnapshot would be captured from a semantically
  // unrelated window with no error to show for it (§10.4's design has no FK
  // to catch this — processedTelemetryId is an unenforced BIGINT, see
  // 002_fault_events.sql's header comment).
  if (windowEndMs <= faultStartMs || windowStartMs >= faultEndMs) {
    throw httpError(400, `resolved trigger window [${new Date(windowStartMs).toISOString()}, ${new Date(windowEndMs).toISOString()}) does not overlap the requested fault range`);
  }

  const windowStart = new Date(windowStartMs).toISOString();
  const windowEnd = new Date(windowEndMs).toISOString();

  let processedTelemetryId;
  let featureSnapshotSource;
  let thresholdsVersion = null;

  const existing = await processedModel.getProcessedByWindowEnd(windowEnd);
  if (existing) {
    // Path A: the window was already computed at ingest time (the common
    // case — every live window goes through POST /process-window per §11,
    // whether or not Tier 1 fired). Reuse it rather than recomputing.
    processedTelemetryId = existing.id;
    featureSnapshotSource = existing;
  } else {
    // Path B: the window failed to process at the time (pdm was down,
    // timed out, or every sample failed physics validation) — reconstruct
    // it from raw_telemetry through the exact same /process-window call
    // pipeline.js uses live, and persist via saveProcessedReading (NOT
    // saveAndTrigger — a backfilled historical window must not re-fire
    // forecast/drift/trend, which are live-only concerns).
    const rawSamples = await sensorModel.getRangeChronological(windowStart, new Date(windowEndMs - 1).toISOString());
    if (rawSamples.length === 0) {
      throw httpError(422, `no raw_telemetry data in the resolved trigger window [${windowStart}, ${windowEnd})`);
    }
    const prevSample = await sensorModel.getLastBefore(windowStart);

    const payload = {
      windowSamples: rawSamples.map(toWindowSampleIn),
      prevSample: prevSample ? toWindowSampleIn(prevSample) : null,
      windowStart,
      windowEnd,
      mergedSampleCount: 0,
      duplicateSampleCount: 0,
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
      throw httpError(502, `pdm /process-window call failed: ${err.message}`);
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = JSON.stringify(await res.json());
      } catch {
        // not JSON — status code alone is enough context.
      }
      throw httpError(502, `pdm /process-window responded ${res.status} for window ${windowStart}-${windowEnd}: ${detail}`);
    }

    const { processedRecord, tier1Verdict } = await res.json();
    const saved = await processedService.saveProcessedReading(processedRecord);
    processedTelemetryId = saved.id;
    featureSnapshotSource = processedRecord;
    // Captured, not discarded: Tier 1 DID score this window just now (the
    // same /process-window call computes tier1Verdict alongside
    // processedRecord) — recording its thresholdsVersion here is the
    // difference between "never evaluated by Tier 1" and "evaluated, no
    // trigger," which otherwise becomes indistinguishable and silently
    // corrupts later precision/recall analysis of Tier 1 against confirmed
    // faults (caught in this feature's design review).
    thresholdsVersion = tier1Verdict?.thresholdsVersion ?? null;
  }

  const nowIso = new Date().toISOString();
  const record = {
    processedTelemetryId,
    eventType: 'FLAGGED',
    sourceType: 'MANUAL_BUFFER',
    detectedAt: nowIso,
    triggerWindowEnd: windowEnd,
    lastSeenWindowEnd: windowEnd,
    triggeredRules: null,
    confidence: null,
    featureSnapshot: buildFeatureSnapshot(featureSnapshotSource),
    thresholdsVersion,
    faultStart,
    faultEnd,
    bufferStart: new Date(faultStartMs - ONE_HOUR_MS).toISOString(),
    bufferEnd: new Date(faultEndMs + ONE_HOUR_MS).toISOString(),
    status: 'CONFIRMED',
    faultType: body.faultType,
    rootCause: body.rootCause.trim(),
    resolution: body.resolution.trim(),
    reviewedBy,
    reviewedAt: nowIso,
    notes: body.notes.trim(),
  };

  const info = await model.insertFaultEvent(record);
  const eventId = Number(info.lastInsertRowid);
  try {
    await corpusMaterializationService.onFaultEventConfirmed(eventId);
  } catch (corpusErr) {
    // Must never block the manual-buffer HTTP response (same fire-and-
    // forget-but-caught discipline as §3.3.1/§3.4 elsewhere in this file).
    logger.error(`corpusMaterializationService.onFaultEventConfirmed failed for fault_events#${eventId}: ${corpusErr.stack || corpusErr.message}`);
  }
  return getFaultEvent(eventId);
}

/** @returns fault_events rows, optionally filtered by status. */
export async function listFaultEvents(status) {
  return model.listFaultEvents(status);
}

/** @returns one fault_events row plus its buffer sample count, or null. */
export async function getFaultEvent(id) {
  const row = await model.getFaultEventById(id);
  if (!row) return null;
  const bufferCount = row.bufferStart && row.bufferEnd
    ? (await model.getBufferRange(row.bufferStart, row.bufferEnd)).length
    : 0;
  return { ...row, bufferSampleCount: bufferCount };
}

/** @returns raw_telemetry rows spanning one event's buffer range. */
export async function getFaultEventBuffer(id) {
  const row = await model.getFaultEventById(id);
  if (!row || !row.bufferStart || !row.bufferEnd) return [];
  return model.getBufferRange(row.bufferStart, row.bufferEnd);
}

/**
 * Flat, per-sample rows for CSV export / model training data: every
 * eligible event's buffer window (faultStart-1h .. faultEnd+1h), each row
 * tagged with its own faultEventId + phase (BEFORE_FAULT/FAULT/AFTER_FAULT).
 *
 * Deliberately NOT a single concatenated time series: two events can be
 * hours or days apart, so nothing here implies row N follows row N-1 in
 * real time. A consumer (e.g. a training pipeline) must group by
 * faultEventId before building sequences — the phase column marks where
 * within that one event's window each row falls.
 *
 * Only events whose buffer window is fully known (bufferStart AND
 * bufferEnd both set — i.e. reviewed, see reviewFaultEvent()) are
 * included; a still-PENDING_REVIEW event's bufferEnd is null because its
 * fault hasn't been confirmed as over yet.
 * @param status optional fault_events status filter (e.g. 'CONFIRMED').
 */
export async function exportBufferRows(status) {
  const events = await model.listFaultEvents(status);
  const eligible = events.filter((e) => e.bufferStart && e.bufferEnd);

  const rows = [];
  for (const event of eligible) {
    const faultStartMs = Date.parse(event.faultStart);
    const faultEndMs = Date.parse(event.faultEnd);
    const samples = await model.getBufferRange(event.bufferStart, event.bufferEnd);
    for (const sample of samples) {
      const ts = Date.parse(sample.timestamp);
      const phase = ts < faultStartMs ? 'BEFORE_FAULT' : ts > faultEndMs ? 'AFTER_FAULT' : 'FAULT';
      rows.push({
        faultEventId: event.id,
        phase,
        eventStatus: event.status,
        eventFaultType: event.faultType,
        timestamp: sample.timestamp,
        flowRate: sample.flowRate,
        rpm: sample.rpm,
        vibration: sample.vibration,
        suctionPressure: sample.suctionPressure,
        dischargePressure: sample.dischargePressure,
        motorTemp: sample.motorTemp,
        pumpStatus: sample.status,
      });
    }
  }
  return rows;
}

/**
 * Apply a HITL review patch. When status is CONFIRMED and faultEnd is
 * given, bufferEnd (= faultEnd + 1 hour) is finalized here — until then the
 * buffer's trailing edge is genuinely unknown (§3.6).
 */
export async function reviewFaultEvent(id, patch) {
  const existing = await model.getFaultEventById(id);
  if (!existing) return null;

  const faultEnd = patch.faultEnd ?? existing.faultEnd;
  const bufferEnd = faultEnd ? new Date(Date.parse(faultEnd) + ONE_HOUR_MS).toISOString() : existing.bufferEnd;

  const newStatus = patch.status ?? existing.status;

  await model.updateFaultEventReview({
    id,
    status: newStatus,
    faultType: patch.faultType ?? existing.faultType,
    rootCause: patch.rootCause ?? existing.rootCause,
    resolution: patch.resolution ?? existing.resolution,
    reviewedBy: patch.reviewedBy ?? existing.reviewedBy,
    reviewedAt: new Date().toISOString(),
    notes: patch.notes ?? existing.notes,
    faultEnd,
    bufferEnd,
  });

  // §10.5 corpus materialization — explicit branch, not a blanket call:
  // a PATCH that CONFIRMS materializes/re-materializes the buffer (the
  // upsert dedup in corpusModel.js handles the "already materialized,
  // fields changed" case correctly); a PATCH that moves a PREVIOUSLY
  // CONFIRMED row away from CONFIRMED (a correction) removes whatever was
  // materialized for it. Any other transition (e.g. PENDING_REVIEW ->
  // REJECTED, which never touched the corpus) is a no-op here. Own
  // try/catch — must never block the HITL PATCH response (§3.4's pattern).
  try {
    if (newStatus === 'CONFIRMED') {
      await corpusMaterializationService.onFaultEventConfirmed(id);
    } else if (existing.status === 'CONFIRMED') {
      await corpusMaterializationService.onFaultEventRejectedOrExcluded(id);
    }
  } catch (corpusErr) {
    logger.error(`corpusMaterializationService hook failed for fault_events#${id} (status ${existing.status} -> ${newStatus}): ${corpusErr.stack || corpusErr.message}`);
  }

  return getFaultEvent(id);
}

/** §3.6: confidence/status agreement breakdown for FLAGGED rows. */
export async function getFaultEventStats() {
  const rows = await model.getFaultEventStats();
  const stats = {};
  for (const { confidence, status, count } of rows) {
    const key = confidence ?? 'UNKNOWN';
    if (!stats[key]) stats[key] = {};
    stats[key][status] = count;
  }
  return stats;
}
