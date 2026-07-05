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

// Plausible physical ranges. Anything outside is almost certainly a bad
// reading or a bug, so we refuse it.
export const RANGES = {
  temperature: { min: -50, max: 150 }, // °C
  humidity: { min: 0, max: 100 }, // %
  pressure: { min: 800, max: 1100 }, // hPa
};

const NUMERIC_FIELDS = ['temperature', 'humidity', 'pressure'];

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

  // light is optional. Accept real booleans as well as 0/1 for convenience.
  if (body.light !== undefined) {
    const ok = typeof body.light === 'boolean' || body.light === 0 || body.light === 1;
    if (!ok) errors.push('light must be a boolean (or 0/1)');
  }

  // timestamp is optional; if present it must be a parseable date string.
  if (body.timestamp !== undefined) {
    if (typeof body.timestamp !== 'string' || Number.isNaN(Date.parse(body.timestamp))) {
      errors.push('timestamp must be a valid ISO date string');
    }
  }

  return errors;
}
