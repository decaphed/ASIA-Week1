// ─────────────────────────────────────────────────────────────────────────
// corpusMaterializationService.js — §10.5's persistent Tier 2 training
// corpus: turns confirmed fault_events rows into training_corpus rows.
//
// Called by faultEventService.js after a HITL confirm, a manual-buffer
// creation, or a negative-sample bank — always fire-and-forget-but-caught
// (own try/catch at the call site), same discipline this repo already
// uses for negative sampling itself (§3.3.1) and the Node->Python
// boundary generally (§3.4): materialization must never affect the
// HITL/manual-buffer HTTP response or ingestion.
//
// DESIGN NOTE (§10.6 item 4, resolved — see docs/plan/2026-08-05-pdm-
// implementation.md §10.5's design-review addendum for the full reasoning
// behind every decision below; this file implements it, doesn't re-derive
// it):
//   - label = fault_events.faultType for a CONFIRMED row (covers HITL-
//     confirmed TIER1_FLAGGED and CONFIRMED-at-creation MANUAL_BUFFER/
//     EXTERNAL_UPLOAD rows), or 'NORMAL' for a NEGATIVE_SAMPLE row.
//     PENDING_REVIEW/REJECTED/null-faultType rows are never materialized.
//   - Every window in a buffer is recomputed UNIFORMLY at materialization
//     time — NOT "keep the trigger window's stored featureSnapshot
//     verbatim, recompute the rest." Mixing a live-captured snapshot for
//     one row with after-the-fact-recomputed snapshots for its buffer-
//     mates was flagged in design review as a silent intra-buffer feature-
//     version skew risk: the two can differ in scale/derivation for the
//     same physical event purely because the feature code changed between
//     when the fault fired and when it was materialized, and nothing
//     would catch that. Every corpus row instead carries its own
//     featureCodeVersion (the processed_telemetry row's own
//     preprocessingVersion) so a training-time discrepancy is at least
//     detectable.
// ─────────────────────────────────────────────────────────────────────────

import * as faultEventModel from '../models/faultEventModel.js';
import * as corpusModel from '../models/corpusModel.js';
import * as processedModel from '../models/processedModel.js';
import * as sensorModel from '../models/sensorModel.js';
import * as processedService from './processedService.js';
import { buildFeatureSnapshot } from '../utils/featureSnapshot.js';
import { WINDOW_DURATION_SECONDS } from '../preprocessing/config.js';
import { logger } from '../utils/logger.js';

const WINDOW_MS = WINDOW_DURATION_SECONDS * 1000;
const PDM_SERVICE_URL = process.env.PDM_SERVICE_URL || 'http://localhost:8000';
const PROCESS_WINDOW_TIMEOUT_MS = 2000;

// Every metric-name-derived faultType this system currently emits (§12.1),
// plus HITL's 'OTHER' catch-all. Kept here rather than re-imported from
// pdmReviewValidation.js to avoid a server/utils <-> server/services
// import direction this file doesn't otherwise need.
const KNOWN_FAULT_TYPES = new Set([
  'THERMAL', 'CAVITATION', 'BEARING', 'IMPELLER_WEAR', 'SEAL_LEAK', 'MISALIGNMENT', 'DRY_RUN', 'OTHER',
]);

/**
 * §10.6 item 4, resolved: what counts as the training label. Pure/testable
 * — no DB access. status is eligibility, not label content: a REJECTED row
 * (even with a faultType filled in from before it was corrected) is never
 * a training example, and neither is a still-open PENDING_REVIEW row.
 * REJECTED specifically is NOT treated as a NORMAL/negative example either
 * — a human rejecting a Tier 1 flag doesn't carry NEGATIVE_SAMPLE's
 * rigorous two-condition sampling gate (§3.3.1), so conflating the two
 * would quietly degrade negative-example quality.
 * @returns the label string, or null if this row isn't corpus-eligible.
 */
export function resolveLabel(faultEventRow) {
  if (faultEventRow.eventType === 'NEGATIVE_SAMPLE') return 'NORMAL';
  if (faultEventRow.status !== 'CONFIRMED') return null;
  if (!faultEventRow.faultType || !KNOWN_FAULT_TYPES.has(faultEventRow.faultType)) return null;
  return faultEventRow.faultType;
}

/** Every 60s-aligned window boundary covering [startMs, endMs], inclusive. */
function alignedWindowEndsInRange(startMs, endMs) {
  const first = Math.ceil(startMs / WINDOW_MS) * WINDOW_MS;
  const last = Math.ceil(endMs / WINDOW_MS) * WINDOW_MS;
  const ends = [];
  for (let ms = first; ms <= last; ms += WINDOW_MS) ends.push(ms);
  return ends;
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
 * Reconstruct one window's processed_telemetry row from raw_telemetry when
 * no existing row covers it — same Path B mechanism as
 * faultEventService.js::createManualBufferEvent, duplicated rather than
 * shared because that function resolves exactly one bounds-checked window
 * while this one loops over many; the looping/error-handling shape differs
 * enough that literal sharing wasn't worth the coupling. Persists via
 * saveProcessedReading (NOT saveAndTrigger) — a backfilled historical
 * window must not re-fire forecast/drift/trend/PdM triggers.
 * @returns the flat, persisted processed_telemetry row, or null if there's
 *   genuinely no raw_telemetry data for this window (skip, don't fabricate).
 */
async function reconstructWindow(windowEndIso) {
  const windowEndMs = Date.parse(windowEndIso);
  const windowStartIso = new Date(windowEndMs - WINDOW_MS).toISOString();
  const rawSamples = await sensorModel.getRangeChronological(windowStartIso, new Date(windowEndMs - 1).toISOString());
  if (rawSamples.length === 0) return null;

  const prevSample = await sensorModel.getLastBefore(windowStartIso);
  const payload = {
    windowSamples: rawSamples.map(toWindowSampleIn),
    prevSample: prevSample ? toWindowSampleIn(prevSample) : null,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
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
    logger.error(`corpusMaterializationService: /process-window call failed for window ${windowEndIso}: ${err.stack || err.message}`);
    return null;
  }
  if (!res.ok) {
    logger.warn(`corpusMaterializationService: /process-window responded ${res.status} for window ${windowEndIso} — skipping`);
    return null;
  }

  const { processedRecord } = await res.json();
  return processedService.saveProcessedReading(processedRecord);
}

/**
 * Materialize every window in a CONFIRMED fault_events row's [faultStart,
 * faultEnd] span into training_corpus — NOT [bufferStart, bufferEnd], which
 * includes an hour of surrounding context on each side that was never
 * itself confirmed as the fault (or as normal) and would corrupt the
 * corpus if labeled either way.
 */
export async function materializeBuffer(faultEventId) {
  const event = await faultEventModel.getFaultEventById(faultEventId);
  if (!event || !event.faultStart || !event.faultEnd) return { materialized: 0, skippedStale: 0 };

  const label = resolveLabel(event);
  if (label === null) return { materialized: 0, skippedStale: 0 };

  const faultStartMs = Date.parse(event.faultStart);
  const faultEndMs = Date.parse(event.faultEnd);
  const windowEndsMs = alignedWindowEndsInRange(faultStartMs, faultEndMs);
  const bufferId = `fault_events:${event.id}`;
  const sourceUpdatedAt = event.reviewedAt ?? event.detectedAt;

  // Batch-fetch existing processed_telemetry rows covering the whole span
  // in one query — most windows already exist (every live-ingested window
  // gets processed regardless of Tier 1 triggering, per §11), so this
  // avoids N round-trips for the common case.
  const spanStartIso = new Date(windowEndsMs[0] - WINDOW_MS).toISOString();
  const spanEndIso = new Date(windowEndsMs[windowEndsMs.length - 1]).toISOString();
  const existingRows = await processedModel.getProcessedByWindowRange(spanStartIso, spanEndIso);
  const existingByWindowEnd = new Map(existingRows.map((row) => [row.windowEnd, row]));

  let materialized = 0;
  let skippedStale = 0;
  for (const ms of windowEndsMs) {
    const windowEnd = new Date(ms).toISOString();
    // eslint-disable-next-line no-await-in-loop -- Path B genuinely must
    // happen one window at a time (each POST /process-window depends on
    // the previous window's samples via prevSample continuity).
    const processedRow = existingByWindowEnd.get(windowEnd) ?? (await reconstructWindow(windowEnd));
    if (!processedRow) continue; // no raw_telemetry data for this window — skip, don't fabricate

    // eslint-disable-next-line no-await-in-loop
    const result = await corpusModel.upsertRow({
      bufferId,
      faultEventId: event.id,
      windowEnd,
      featureSnapshot: buildFeatureSnapshot(processedRow),
      featureCodeVersion: processedRow.preprocessingVersion,
      label,
      eventType: event.eventType,
      sourceType: event.sourceType,
      thresholdsVersion: event.thresholdsVersion ?? null,
      sourceUpdatedAt,
    });
    if (result) materialized += 1;
    else skippedStale += 1;
  }

  if (skippedStale > 0) {
    logger.warn(`corpusMaterializationService: ${skippedStale} window(s) for fault_events#${event.id} skipped as stale (sourceUpdatedAt not newer than what's already stored)`);
  }

  await checkClassBalance(label, { mode: 'warn' });
  return { materialized, skippedStale };
}

/**
 * Materialize a NEGATIVE_SAMPLE row — always exactly one window, no
 * buffer, so there's no intra-buffer heterogeneity risk and the row's own
 * already-stored featureSnapshot (captured live, by the same code that
 * scored it at the time) is reused directly rather than recomputed.
 */
export async function materializeNegativeSample(faultEventId) {
  const event = await faultEventModel.getFaultEventById(faultEventId);
  if (!event || event.eventType !== 'NEGATIVE_SAMPLE') return { materialized: 0 };

  const processedRow = await processedModel.getById(event.processedTelemetryId);
  if (!processedRow) return { materialized: 0 };

  const bufferId = `fault_events:${event.id}`;
  const result = await corpusModel.upsertRow({
    bufferId,
    faultEventId: event.id,
    windowEnd: event.triggerWindowEnd,
    featureSnapshot: JSON.stringify(event.featureSnapshot),
    featureCodeVersion: processedRow.preprocessingVersion,
    label: 'NORMAL',
    eventType: event.eventType,
    sourceType: event.sourceType,
    thresholdsVersion: event.thresholdsVersion ?? null,
    sourceUpdatedAt: event.detectedAt,
  });

  await checkClassBalance('NORMAL', { mode: 'warn' });
  return { materialized: result ? 1 : 0 };
}

/**
 * §10.5's whole-corpus (not per-contribution) class-balance check. Warn-
 * only for HITL-confirm/manual-buffer/negative-sample paths — discarding a
 * human-confirmed real fault to preserve balance would mean throwing away
 * real ground truth, contrary to this system's "never fabricate/discard
 * confidence" ethos (§3.2). A future EXTERNAL_UPLOAD path (not built) can
 * call this same function in 'block' mode, since it already has its own
 * per-file quality gate (§10.4.1 Stage C) capable of bouncing a whole batch.
 * @returns { warning: string|null } — non-null in 'warn' mode when the
 *   post-merge corpus looks skewed; throws in 'block' mode instead.
 */
export async function checkClassBalance(candidateLabel, { mode = 'warn' } = {}) {
  const balance = await corpusModel.getClassBalance();
  const total = balance.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) return { warning: null };

  const candidateCount = balance.find((row) => row.label === candidateLabel)?.count ?? 0;
  const candidateShare = candidateCount / total;

  // A single label dominating more than 80% of a corpus with meaningful
  // size isn't yet a hard rule from §10.5 (no concrete threshold specified
  // there) — this is a coarse, deliberately simple heuristic to surface
  // the concern the doc describes ("operators only ever upload fault
  // examples... the corpus's fault:normal ratio drifts"), not a tuned gate.
  const SKEW_THRESHOLD = 0.8;
  const MIN_TOTAL_FOR_CHECK = 20;
  if (total >= MIN_TOTAL_FOR_CHECK && candidateShare > SKEW_THRESHOLD) {
    const message = `corpus class balance: '${candidateLabel}' is ${(candidateShare * 100).toFixed(1)}% of ${total} rows`;
    if (mode === 'block') {
      throw Object.assign(new Error(message), { status: 422 });
    }
    logger.warn(`corpusMaterializationService: ${message}`);
    return { warning: message };
  }
  return { warning: null };
}

/** Dispatches a just-confirmed/just-created fault_events row to the right materialization path. */
export async function onFaultEventConfirmed(faultEventId) {
  const event = await faultEventModel.getFaultEventById(faultEventId);
  if (!event) return;
  if (event.eventType === 'NEGATIVE_SAMPLE') {
    await materializeNegativeSample(faultEventId);
  } else {
    await materializeBuffer(faultEventId);
  }
}

/** Removes any corpus rows for a fault_events row that was rejected or later corrected away from CONFIRMED. */
export async function onFaultEventRejectedOrExcluded(faultEventId) {
  await corpusModel.deleteByBuffer(`fault_events:${faultEventId}`);
}
