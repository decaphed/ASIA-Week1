// ─────────────────────────────────────────────────────────────────────────
// validation.js — pure functions that check an incoming reading.
//
// "Pure" = no Express, no database, just data-in / errors-out. That makes the
// rules trivial to unit-test and reusable. The Express middleware
// (middleware/validateReading.js) simply calls validateReading() and turns any
// returned errors into a 400 response.
//
// WHY validate at the boundary? Never trust input from the network. Node-RED
// (or curl, or a buggy sensor) could send missing fields, strings instead of
// numbers, or wildly out-of-range values. We reject them before they reach the
// database.
// ─────────────────────────────────────────────────────────────────────────

// Plausible physical ranges for a pump. Anything outside is almost certainly
// a bad reading or a bug, so we refuse it. Ranges are wider than the
// simulator's normal output so occasional fault-condition spikes still pass.
export const RANGES = {
  flowRate: { min: 0, max: 500 }, // L/min
  rpm: { min: 0, max: 5000 }, // revolutions/minute
  vibration: { min: 0, max: 25 }, // mm/s
  suctionPressure: { min: 0, max: 10 }, // bar
  dischargePressure: { min: 0, max: 25 }, // bar
  motorTemp: { min: -20, max: 150 }, // °C
};

const NUMERIC_FIELDS = Object.keys(RANGES);
const VALID_STATUSES = ['RUNNING', 'STOPPED', 'FAULT'];

/**
 * Validate a reading body.
 * @returns {string[]} human-readable error messages (empty array = valid).
 */
export function validateReading(body) {
  const errors = [];

  for (const field of NUMERIC_FIELDS) {
    const value = body[field];

    if (value === undefined || value === null) {
      errors.push(`${field} is required`);
      continue;
    }
    if (typeof value !== 'number' || Number.isNaN(value)) {
      errors.push(`${field} must be a number`);
      continue;
    }
    const { min, max } = RANGES[field];
    if (value < min || value > max) {
      errors.push(`${field} must be between ${min} and ${max}`);
    }
  }

  // status is optional; if present it must be one of the known run states.
  if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) {
    errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  // timestamp is optional; if present it must be a parseable date string.
  if (body.timestamp !== undefined) {
    if (typeof body.timestamp !== 'string' || Number.isNaN(Date.parse(body.timestamp))) {
      errors.push('timestamp must be a valid ISO date string');
    }
  }

  return errors;
}

// One-minute aggregate record produced by the preprocessing pipeline (see
// server/preprocessing/pipeline.js) and posted to POST /api/processed. Six
// stats per metric, unlike the single value validated above.
const AGGREGATE_STATS = ['Mean', 'Median', 'Min', 'Max', 'StdDev', 'Last'];
const VALID_QUALITY_LABELS = ['GOOD', 'FAIR', 'POOR'];

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate a processed_telemetry aggregate body.
 * @returns {string[]} human-readable error messages (empty array = valid).
 */
export function validateProcessedRecord(body) {
  const errors = [];

  for (const field of NUMERIC_FIELDS) {
    for (const stat of AGGREGATE_STATS) {
      const key = `${field}${stat}`;
      if (!isFiniteNumber(body[key])) {
        errors.push(`${key} must be a number`);
      }
    }
  }

  if (!VALID_STATUSES.includes(body.dominantStatus)) {
    errors.push(`dominantStatus must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  for (const field of ['windowStart', 'windowEnd', 'timestamp']) {
    if (typeof body[field] !== 'string' || Number.isNaN(Date.parse(body[field]))) {
      errors.push(`${field} must be a valid ISO date string`);
    }
  }

  if (!Number.isInteger(body.sampleCount) || body.sampleCount <= 0) {
    errors.push('sampleCount must be a positive integer');
  }
  if (!isFiniteNumber(body.qualityScore) || body.qualityScore < 0 || body.qualityScore > 100) {
    errors.push('qualityScore must be a number between 0 and 100');
  }
  if (!VALID_QUALITY_LABELS.includes(body.qualityLabel)) {
    errors.push(`qualityLabel must be one of: ${VALID_QUALITY_LABELS.join(', ')}`);
  }

  return errors;
}
