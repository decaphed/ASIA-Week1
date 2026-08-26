// ─────────────────────────────────────────────────────────────────────────
// externalUploadValidation.js — pure Stage A (structural) and Stage B
// (mapping) checks for §10.4.1's external-upload gate. No DB, no HTTP —
// same convention as pdmManualBufferValidation.js.
//
// Stage A runs on the raw parsed file, before the operator ever sees a
// mapping screen — cheap, semantics-free checks that reject an obviously-
// unusable file (§10.4.1: "column mapping cannot manufacture a time axis
// that doesn't exist"). Stage B runs after Stage A passes, once the
// operator has supplied a column mapping.
//
// Every concrete threshold below is a judgment call the plan doc left as
// "still open" (§10.6 item 3) — chosen and documented here, not asserted
// without reasoning:
//   - MIN_ROWS = 120: at least two 60-second windows' worth of data at
//     this system's own ~1Hz cadence — a shorter file can't produce even
//     one full training-corpus contribution.
//   - TIMESTAMP_PARSE_SUCCESS_RATE = 0.95: the column with the highest
//     Date-parseable fraction is the timestamp column, but only if that
//     fraction clears 95% — below that, no column is confidently a real
//     time axis (Stage A's own reason for existing).
//   - MEDIAN_INTERVAL_[MIN|MAX]_SEC = [0.5, 5]: a tolerance band around
//     this system's own ~1Hz sampling. Not a stylistic choice — Stage C
//     reuses pdm/app/preprocessing/quality.py's missingRate accounting,
//     which is hardwired to EXPECTED_SAMPLE_COUNT at that cadence
//     (pdm/app/preprocessing/config.py). A genuinely slower-cadence
//     source (e.g. a once-a-minute historian export) would need
//     resampling to fit that accounting, which is its own kind of
//     fabrication — explicitly out of scope for v1, not silently handled.
//   - DUPLICATE_ROW_RATE_MAX = 0.10: more than 1-in-10 exact-duplicate
//     rows suggests a corrupted export, not just incidental repeats.
//   - COLUMN_MISSING_RATE_EXCLUDE = 0.5: a column more than half empty is
//     auto-dropped from the Stage B mapping offer rather than failing the
//     whole file — Stage A has no semantic knowledge yet, so a sparse
//     irrelevant column (e.g. one sensor of a wide anonymized export)
//     shouldn't sink an otherwise-good file. The file fails Stage A
//     outright only if EVERY non-timestamp column is this sparse.
//   - MIN_MAPPED_METRICS = 1: at least one of the six metrics must be
//     mapped, or there's nothing for Stage C to score at all.
//   - RANGE_SANITY_IN_RANGE_FRACTION = 0.7: fewer than 70% of a mapped
//     column's converted values falling inside pump-physics.yaml's range
//     is treated as a likely wrong mapping/unit choice, not a physically
//     extreme-but-real pump — surfaced as a soft warning requiring
//     explicit operator re-confirmation, not a hard reject (only Stage C
//     hard-rejects, per design-review decision D12).
// ─────────────────────────────────────────────────────────────────────────

import { unitsForMetric } from './unitConversion.js';

export const MIN_ROWS = 120;
export const TIMESTAMP_PARSE_SUCCESS_RATE = 0.95;
export const MEDIAN_INTERVAL_MIN_SEC = 0.5;
export const MEDIAN_INTERVAL_MAX_SEC = 5;
export const DUPLICATE_ROW_RATE_MAX = 0.1;
export const COLUMN_MISSING_RATE_EXCLUDE = 0.5;
export const MIN_MAPPED_METRICS = 1;
export const RANGE_SANITY_IN_RANGE_FRACTION = 0.7;

const KNOWN_METRICS = ['engineRpm', 'lubOilPressure', 'fuelPressure', 'coolantPressure', 'lubOilTemperature', 'coolantTemperature'];

function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

export function parseNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Detect the timestamp column: the header whose values parse as dates at
 * or above TIMESTAMP_PARSE_SUCCESS_RATE, highest success rate wins ties
 * broken by column order.
 * @returns { column: string, successRate: number } | null
 */
function detectTimestampColumn(headers, rows) {
  let best = null;
  for (const header of headers) {
    let parsed = 0;
    for (const row of rows) {
      const raw = row[header];
      if (!isBlank(raw) && !Number.isNaN(Date.parse(String(raw)))) parsed += 1;
    }
    const successRate = rows.length === 0 ? 0 : parsed / rows.length;
    if (successRate >= TIMESTAMP_PARSE_SUCCESS_RATE && (!best || successRate > best.successRate)) {
      best = { column: header, successRate };
    }
  }
  return best;
}

function rowSignature(row, headers) {
  return headers.map((h) => String(row[h] ?? '')).join(' ');
}

/**
 * @param headers string[] — the CSV's column headers, in file order.
 * @param rows object[] — parsed rows, each { [header]: rawCellString|number }.
 * @returns {
 *   valid: boolean, errors: string[],
 *   detectedTimestampColumn: string|null, rowCount: number,
 *   medianIntervalSec: number|null,
 *   excludedColumns: { name: string, missingRate: number }[],
 *   survivingColumns: string[],
 *   warnings: string[],
 * }
 */
export function validateStageA(headers, rows) {
  const errors = [];
  const warnings = [];

  if (rows.length < MIN_ROWS) {
    errors.push(`file has ${rows.length} rows, fewer than the minimum ${MIN_ROWS} required`);
  }

  const timestampMatch = detectTimestampColumn(headers, rows);
  if (!timestampMatch) {
    errors.push(`no column has a real, regular time axis (need >= ${TIMESTAMP_PARSE_SUCCESS_RATE * 100}% parseable timestamps) — column mapping cannot manufacture a missing time axis`);
    return {
      valid: false, errors, detectedTimestampColumn: null, rowCount: rows.length,
      medianIntervalSec: null, excludedColumns: [], survivingColumns: [], warnings,
    };
  }

  const tsCol = timestampMatch.column;
  const timestampsMs = rows
    .map((row) => Date.parse(String(row[tsCol])))
    .filter((ms) => !Number.isNaN(ms))
    .sort((a, b) => a - b);

  let medianIntervalSec = null;
  if (timestampsMs.length >= 2) {
    const intervals = [];
    for (let i = 1; i < timestampsMs.length; i++) intervals.push((timestampsMs[i] - timestampsMs[i - 1]) / 1000);
    const sorted = intervals.slice().sort((a, b) => a - b);
    medianIntervalSec = sorted[Math.floor(sorted.length / 2)];
    if (medianIntervalSec < MEDIAN_INTERVAL_MIN_SEC || medianIntervalSec > MEDIAN_INTERVAL_MAX_SEC) {
      errors.push(`median inter-sample interval is ${medianIntervalSec.toFixed(2)}s, outside the supported [${MEDIAN_INTERVAL_MIN_SEC}, ${MEDIAN_INTERVAL_MAX_SEC}]s range — a materially different cadence isn't supported yet (would require resampling, which this system doesn't fabricate)`);
    }
  }

  const seen = new Map();
  for (const row of rows) {
    const sig = rowSignature(row, headers);
    seen.set(sig, (seen.get(sig) ?? 0) + 1);
  }
  const duplicateCount = [...seen.values()].reduce((sum, c) => sum + (c > 1 ? c - 1 : 0), 0);
  const duplicateRate = rows.length === 0 ? 0 : duplicateCount / rows.length;
  if (duplicateRate > DUPLICATE_ROW_RATE_MAX) {
    errors.push(`${(duplicateRate * 100).toFixed(1)}% of rows are exact duplicates, above the ${DUPLICATE_ROW_RATE_MAX * 100}% threshold — likely a corrupted export`);
  }

  const nonTimestampColumns = headers.filter((h) => h !== tsCol);
  const excludedColumns = [];
  const survivingColumns = [];
  for (const col of nonTimestampColumns) {
    const missing = rows.filter((row) => isBlank(row[col])).length;
    const missingRate = rows.length === 0 ? 1 : missing / rows.length;
    if (missingRate > COLUMN_MISSING_RATE_EXCLUDE) {
      excludedColumns.push({ name: col, missingRate });
    } else {
      survivingColumns.push(col);
    }
  }
  if (survivingColumns.length === 0) {
    errors.push('every non-timestamp column is more than 50% empty — nothing usable survives to the mapping stage');
  }
  if (excludedColumns.length > 0) {
    warnings.push(`${excludedColumns.length} column(s) excluded for being >${COLUMN_MISSING_RATE_EXCLUDE * 100}% empty: ${excludedColumns.map((c) => c.name).join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    detectedTimestampColumn: tsCol,
    rowCount: rows.length,
    medianIntervalSec,
    excludedColumns,
    survivingColumns,
    warnings,
  };
}

/**
 * @param columnMapping { [sourceColumn]: { metric: string|null, unit: string } }
 * @param availableColumns string[] — the survivingColumns from Stage A.
 * @returns string[] errors (empty = valid).
 */
export function validateStageBMapping(columnMapping, availableColumns) {
  const errors = [];
  if (typeof columnMapping !== 'object' || columnMapping === null || Array.isArray(columnMapping)) {
    return ['columnMapping must be an object'];
  }

  const availableSet = new Set(availableColumns);
  const usedMetrics = new Map(); // metric -> sourceColumn, to detect non-injective mappings

  for (const [sourceColumn, mapping] of Object.entries(columnMapping)) {
    if (!availableSet.has(sourceColumn)) {
      errors.push(`'${sourceColumn}' is not a column that survived Stage A`);
      continue;
    }
    if (mapping === null || mapping.metric === null || mapping.metric === undefined) {
      continue; // explicitly marked unused — valid, not an error
    }
    if (!KNOWN_METRICS.includes(mapping.metric)) {
      errors.push(`'${sourceColumn}' maps to unknown metric '${mapping.metric}' — must be one of: ${KNOWN_METRICS.join(', ')}`);
      continue;
    }
    if (usedMetrics.has(mapping.metric)) {
      errors.push(`both '${usedMetrics.get(mapping.metric)}' and '${sourceColumn}' map to '${mapping.metric}' — mapping must be injective (one source column per metric)`);
      continue;
    }
    usedMetrics.set(mapping.metric, sourceColumn);

    const validUnits = unitsForMetric(mapping.metric);
    if (!validUnits || !validUnits.includes(mapping.unit)) {
      errors.push(`'${sourceColumn}' -> '${mapping.metric}' declares unit '${mapping.unit}', must be one of: ${(validUnits ?? []).join(', ')}`);
    }
  }

  if (usedMetrics.size < MIN_MAPPED_METRICS) {
    errors.push(`at least ${MIN_MAPPED_METRICS} metric must be mapped — none were`);
  }

  return errors;
}

/**
 * Stage B's post-mapping, post-conversion range sanity-check — a fast
 * signal the MAPPING/UNIT CHOICE is wrong, not a claim about whether the
 * source pump behaved impossibly (§10.4.1's own framing). Soft gate: the
 * caller surfaces this as `requiresConfirmation`, not a hard rejection.
 * @param convertedRowsByMetric { [metric]: number[] } — already unit-converted values.
 * @param ranges { [metric]: { min: number, max: number } } — pump-physics.yaml's RANGES.
 * @returns { requiresConfirmation: boolean, warnings: { metric, inRangeFraction }[] }
 */
export function checkRangeSanity(convertedRowsByMetric, ranges) {
  const warnings = [];
  for (const [metric, values] of Object.entries(convertedRowsByMetric)) {
    const range = ranges[metric];
    if (!range || values.length === 0) continue;
    const inRange = values.filter((v) => v >= range.min && v <= range.max).length;
    const inRangeFraction = inRange / values.length;
    if (inRangeFraction < RANGE_SANITY_IN_RANGE_FRACTION) {
      warnings.push({ metric, inRangeFraction });
    }
  }
  return { requiresConfirmation: warnings.length > 0, warnings };
}
