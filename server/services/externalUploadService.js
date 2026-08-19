// ─────────────────────────────────────────────────────────────────────────
// externalUploadService.js — §10.4 Entry point 2's Stage A/B/C orchestration
// (docs/plan/2026-08-05-pdm-implementation.md §10.4.1). Two entry functions,
// one per HTTP request in the upload/confirm flow:
//   - handleUpload: Stage A (structural gate) on a just-parsed CSV.
//   - confirmUpload: Stage B (mapping/unit/range) + Stage C (physics-aware
//     quality gate, reusing pdm's /process-window pipeline) + the
//     whole-corpus class-balance block-mode check + materialization.
//
// Design decisions (§10.4/§10.5's design-review addendum, D10-D18):
//   - D10: never creates a fault_events row — writes straight to
//     training_corpus with bufferId "upload:<uploadId>:<windowIndex>".
//   - D11: Stage C composite qualityScore reject threshold < 70 (reuses
//     computeQuality's existing GOOD/FAIR/POOR banding). physicsPassRate
//     and imputationRate floors are evaluated PER WINDOW, not as a
//     corpus-wide weighted mean (design-review fix: an aggregate mean
//     would let a batch of garbage windows dilute into a passing average
//     — exactly the failure mode the composite score's own
//     AllSamplesInvalidError=0 handling already worries about; the floors
//     exist specifically to be a backstop against that, so they can't be
//     vulnerable to the same averaging).
//   - D12: this is the only entry point where quality is a hard gate —
//     manual-buffer/live-ingest data was already validated once, at
//     original capture, by this same pipeline; upload data never was.
//   - D15: uploaded sample status is hardcoded 'RUNNING' — no status
//     mapping offered, stays within §10.4.1's 6-metric-only mapping scope.
// ─────────────────────────────────────────────────────────────────────────

import { unlink } from 'node:fs/promises';

import * as externalUploadModel from '../models/externalUploadModel.js';
import * as corpusModel from '../models/corpusModel.js';
import * as corpusMaterializationService from './corpusMaterializationService.js';
import { buildFeatureSnapshot } from '../utils/featureSnapshot.js';
import {
  validateStageA, validateStageBMapping, checkRangeSanity, parseNumeric,
} from '../utils/externalUploadValidation.js';
import { convertToInternalUnit } from '../utils/unitConversion.js';
import { parseCsvFile } from '../utils/csvParse.js';
import { RANGES } from '../utils/validation.js';
import { WINDOW_DURATION_SECONDS } from '../preprocessing/config.js';
import { logger } from '../utils/logger.js';

const WINDOW_MS = WINDOW_DURATION_SECONDS * 1000;
const PDM_SERVICE_URL = process.env.PDM_SERVICE_URL || 'http://localhost:8000';
const PROCESS_WINDOW_TIMEOUT_MS = 2000;

// D11 — Stage C thresholds. See this module's header comment for why the
// two floors are per-window, not an aggregate.
export const QUALITY_SCORE_REJECT_THRESHOLD = 70;
export const PHYSICS_PASS_RATE_FLOOR = 0.85;
export const IMPUTATION_RATE_CEILING = 0.3;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * Stage A: parse the just-uploaded temp file, run structural validation,
 * and either stage it (AWAITING_MAPPING) or reject it outright. The temp
 * file is ALWAYS deleted before this returns, success or failure — nothing
 * about the upload flow should ever leave content on the container
 * filesystem across requests (design review D18).
 */
export async function handleUpload(tempFilePath, originalFilename, uploadedBy) {
  try {
    const { headers, rows } = await parseCsvFile(tempFilePath);
    const stageA = validateStageA(headers, rows);

    if (!stageA.valid) {
      throw httpError(422, `Stage A structural validation failed: ${stageA.errors.join('; ')}`);
    }

    const stagedRows = rows.map((row) => {
      const kept = { [stageA.detectedTimestampColumn]: row[stageA.detectedTimestampColumn] };
      for (const col of stageA.survivingColumns) kept[col] = row[col];
      return kept;
    });

    const { id } = await externalUploadModel.insertUpload({
      originalFilename,
      uploadedBy,
      stagedRows,
      stageAResult: stageA,
    });

    return {
      uploadId: id,
      headers: stageA.survivingColumns,
      excludedColumns: stageA.excludedColumns,
      detectedTimestampColumn: stageA.detectedTimestampColumn,
      rowCount: stageA.rowCount,
      medianIntervalSec: stageA.medianIntervalSec,
      warnings: stageA.warnings,
    };
  } finally {
    try {
      await unlink(tempFilePath);
    } catch (err) {
      logger.error(`externalUploadService: failed to delete temp upload file ${tempFilePath}: ${err.message}`);
    }
  }
}

function toWindowSample(row, tsColumn, columnMapping) {
  const sample = {
    timestamp: new Date(Date.parse(String(row[tsColumn]))).toISOString(),
    status: 'RUNNING', // D15 — no status column mapping offered
    faultType: null,
    flowRate: null, rpm: null, vibration: null, suctionPressure: null, dischargePressure: null, motorTemp: null,
  };
  for (const [sourceColumn, mapping] of Object.entries(columnMapping)) {
    if (!mapping || !mapping.metric) continue;
    const raw = parseNumeric(row[sourceColumn]);
    if (raw === null) continue;
    sample[mapping.metric] = convertToInternalUnit(mapping.metric, mapping.unit, raw);
  }
  return sample;
}

/** Groups rows into aligned 60s windows spanning the file's own time range, chronological. */
function chunkIntoWindows(rows, tsColumn) {
  const withMs = rows
    .map((row) => ({ row, ms: Date.parse(String(row[tsColumn])) }))
    .filter((r) => !Number.isNaN(r.ms))
    .sort((a, b) => a.ms - b.ms);
  if (withMs.length === 0) return [];

  const windowEndsMs = corpusMaterializationService.alignedWindowEndsInRange(withMs[0].ms, withMs[withMs.length - 1].ms);
  const windows = [];
  let cursor = 0;
  for (const windowEndMs of windowEndsMs) {
    const windowStartMs = windowEndMs - WINDOW_MS;
    const rowsInWindow = [];
    while (cursor < withMs.length && withMs[cursor].ms < windowEndMs) {
      if (withMs[cursor].ms >= windowStartMs) rowsInWindow.push(withMs[cursor].row);
      cursor += 1;
    }
    if (rowsInWindow.length > 0) windows.push({ windowStartMs, windowEndMs, rows: rowsInWindow });
  }
  return windows;
}

/**
 * Stage B (mapping/unit/range) + Stage C (quality gate) + class-balance
 * block-mode check + materialization, all in one confirm call.
 * @param uploadId
 * @param body { columnMapping, faultType, rootCause, resolution, notes, confirmRangeOverride? }
 * @param reviewedBy resolved actor identity (controller resolves req.identity vs. client value).
 */
export async function confirmUpload(uploadId, body, reviewedBy) {
  const upload = await externalUploadModel.getUploadById(uploadId);
  if (!upload) throw httpError(404, `upload #${uploadId} not found`);
  if (upload.status !== 'AWAITING_MAPPING') {
    throw httpError(409, `upload #${uploadId} is already in a terminal state (${upload.status})`);
  }

  const stageAResult = upload.stageAResult;
  const mappingErrors = validateStageBMapping(body.columnMapping, stageAResult.survivingColumns);
  if (mappingErrors.length > 0) {
    await externalUploadModel.finalizeUpload(uploadId, {
      status: 'STAGE_B_REJECTED', columnMapping: body.columnMapping, rejectedReason: mappingErrors.join('; '),
    });
    throw httpError(422, `Stage B mapping validation failed: ${mappingErrors.join('; ')}`);
  }

  const tsColumn = stageAResult.detectedTimestampColumn;
  const stagedRows = upload.stagedRows;

  // Range sanity-check (soft gate) — build converted value arrays per metric.
  const convertedByMetric = {};
  for (const [sourceColumn, mapping] of Object.entries(body.columnMapping)) {
    if (!mapping || !mapping.metric) continue;
    convertedByMetric[mapping.metric] = stagedRows
      .map((row) => parseNumeric(row[sourceColumn]))
      .filter((v) => v !== null)
      .map((v) => convertToInternalUnit(mapping.metric, mapping.unit, v));
  }
  const rangeSanity = checkRangeSanity(convertedByMetric, RANGES);
  if (rangeSanity.requiresConfirmation && !body.confirmRangeOverride) {
    return {
      requiresConfirmation: true,
      rangeSanityWarnings: rangeSanity.warnings,
    };
  }

  // Stage C — chunk into windows, run each through pdm's /process-window.
  const windows = chunkIntoWindows(stagedRows, tsColumn);
  if (windows.length === 0) {
    await externalUploadModel.finalizeUpload(uploadId, { status: 'STAGE_C_REJECTED', columnMapping: body.columnMapping, rejectedReason: 'no windows could be formed from the mapped data' });
    throw httpError(422, 'no windows could be formed from the mapped data');
  }

  const windowResults = [];
  let prevWindowLastSample = null;
  for (const window of windows) {
    const samples = window.rows.map((row) => toWindowSample(row, tsColumn, body.columnMapping));
    const payload = {
      windowSamples: samples,
      prevSample: prevWindowLastSample,
      windowStart: new Date(window.windowStartMs).toISOString(),
      windowEnd: new Date(window.windowEndMs).toISOString(),
      mergedSampleCount: 0,
      duplicateSampleCount: 0,
    };
    prevWindowLastSample = samples[samples.length - 1] ?? prevWindowLastSample;

    let res;
    try {
      // eslint-disable-next-line no-await-in-loop -- each window's prevSample depends on the previous one.
      res = await fetch(`${PDM_SERVICE_URL}/process-window`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PROCESS_WINDOW_TIMEOUT_MS),
      });
    } catch (err) {
      throw httpError(502, `pdm /process-window call failed for window ${payload.windowEnd}: ${err.message}`);
    }

    if (!res.ok) {
      // AllSamplesInvalidError (422) or any other non-2xx: counted as the
      // worst possible window (qualityScore=0, physicsPassRate=0,
      // imputationRate=1), NOT dropped — an upload can't improve its score
      // by having its worst windows silently vanish from the average.
      windowResults.push({
        windowEnd: payload.windowEnd, sampleCount: samples.length,
        qualityScore: 0, physicsPassRate: 0, imputationRate: 1, outlierRate: 0,
        processedRecord: null,
      });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const { processedRecord } = await res.json();
    windowResults.push({
      windowEnd: payload.windowEnd, sampleCount: samples.length,
      qualityScore: processedRecord.qualityScore, physicsPassRate: processedRecord.physicsPassRate,
      imputationRate: processedRecord.imputationRate, outlierRate: processedRecord.outlierRate,
      processedRecord,
    });
  }

  // D11: the two floors are evaluated PER WINDOW — reject the whole upload
  // if ANY window individually breaches either floor. A weighted-mean
  // floor would be exactly as gameable as the composite alone, defeating
  // the point of having an independent backstop (design-review finding).
  const violatingWindows = windowResults.filter(
    (w) => w.physicsPassRate < PHYSICS_PASS_RATE_FLOOR || w.imputationRate > IMPUTATION_RATE_CEILING,
  );

  const totalSamples = windowResults.reduce((sum, w) => sum + w.sampleCount, 0) || 1;
  const weightedQualityScore = windowResults.reduce((sum, w) => sum + w.qualityScore * w.sampleCount, 0) / totalSamples;
  const weightedPhysicsPassRate = windowResults.reduce((sum, w) => sum + w.physicsPassRate * w.sampleCount, 0) / totalSamples;
  const weightedImputationRate = windowResults.reduce((sum, w) => sum + w.imputationRate * w.sampleCount, 0) / totalSamples;
  const weightedOutlierRate = windowResults.reduce((sum, w) => sum + w.outlierRate * w.sampleCount, 0) / totalSamples;

  if (violatingWindows.length > 0 || weightedQualityScore < QUALITY_SCORE_REJECT_THRESHOLD) {
    const reason = violatingWindows.length > 0
      ? `${violatingWindows.length} of ${windowResults.length} window(s) breached the per-window physicsPassRate>=${PHYSICS_PASS_RATE_FLOOR}/imputationRate<=${IMPUTATION_RATE_CEILING} floor`
      : `composite qualityScore ${weightedQualityScore.toFixed(1)} is below the ${QUALITY_SCORE_REJECT_THRESHOLD} threshold`;
    await externalUploadModel.finalizeUpload(uploadId, {
      status: 'STAGE_C_REJECTED', columnMapping: body.columnMapping,
      qualityScore: weightedQualityScore, physicsPassRate: weightedPhysicsPassRate,
      imputationRate: weightedImputationRate, outlierRate: weightedOutlierRate,
      windowCount: windowResults.length, rejectedReason: reason,
    });
    throw httpError(422, `Stage C quality gate failed: ${reason}`);
  }

  // Whole-corpus class-balance pre-check (D17), block mode — runs BEFORE
  // any training_corpus write.
  await corpusMaterializationService.checkClassBalance(body.faultType, { mode: 'block', additionalCount: windowResults.length });

  const now = new Date().toISOString();
  for (let i = 0; i < windowResults.length; i++) {
    const w = windowResults[i];
    if (!w.processedRecord) continue; // an AllSamplesInvalidError window has nothing to materialize
    // eslint-disable-next-line no-await-in-loop
    await corpusModel.upsertRow({
      bufferId: `upload:${uploadId}:${i}`,
      faultEventId: null,
      windowEnd: w.windowEnd,
      featureSnapshot: buildFeatureSnapshot(w.processedRecord),
      featureCodeVersion: w.processedRecord.preprocessingVersion,
      label: body.faultType,
      eventType: 'FLAGGED',
      sourceType: 'EXTERNAL_UPLOAD',
      thresholdsVersion: null,
      uploadId: String(uploadId),
      uploadedAt: now,
      uploadedBy: reviewedBy,
      sourceUpdatedAt: now,
    });
  }

  await externalUploadModel.finalizeUpload(uploadId, {
    status: 'ACCEPTED', columnMapping: body.columnMapping, faultType: body.faultType,
    rootCause: body.rootCause, resolution: body.resolution, notes: body.notes,
    qualityScore: weightedQualityScore, physicsPassRate: weightedPhysicsPassRate,
    imputationRate: weightedImputationRate, outlierRate: weightedOutlierRate,
    windowCount: windowResults.length,
  });

  return {
    uploadId, materializedWindows: windowResults.filter((w) => w.processedRecord).length,
    qualityScore: weightedQualityScore, physicsPassRate: weightedPhysicsPassRate, imputationRate: weightedImputationRate,
  };
}
