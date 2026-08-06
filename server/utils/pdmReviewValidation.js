// ─────────────────────────────────────────────────────────────────────────
// pdmReviewValidation.js — pure validation for the HITL fault-event review
// PATCH body (server/controllers/pdmController.js::reviewFaultEvent).
//
// Deliberately separate from utils/validation.js: these enums describe the
// fault_events HITL review outcome (database/schema.sql lines 203-204), not
// raw/processed telemetry. Reusing VALID_FAULT_TYPES from utils/validation.js
// would silently reject the legitimate 'OTHER' fault type.
//
// The service (faultEventService.js::reviewFaultEvent) stays permissive by
// design — it's also called directly with partial patches elsewhere (see
// faultEventService.test.mjs). This module is the gate, wired in only at
// the controller boundary.
// ─────────────────────────────────────────────────────────────────────────

export const REVIEW_STATUSES = ['PENDING_REVIEW', 'CONFIRMED', 'REJECTED', 'N/A'];

export const FAULT_EVENT_FAULT_TYPES = ['THERMAL', 'CAVITATION', 'BEARING', 'OTHER'];

// Statuses that represent a completed review, requiring the reviewer to
// have actually recorded a finding rather than just flipping a flag.
export const TERMINAL_STATUSES = ['CONFIRMED', 'REJECTED'];

function isBlank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * @returns {string[]} human-readable error messages (empty array = valid).
 */
export function validateReviewPatch(body) {
  const errors = [];

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return ['request body must be an object'];
  }

  if (body.status !== undefined && !REVIEW_STATUSES.includes(body.status)) {
    return [`status must be one of: ${REVIEW_STATUSES.join(', ')}`];
  }

  if (!TERMINAL_STATUSES.includes(body.status)) {
    return errors;
  }

  if (isBlank(body.rootCause)) {
    errors.push('rootCause is required and must be a non-empty string');
  }
  if (isBlank(body.reviewedBy)) {
    errors.push('reviewedBy is required and must be a non-empty string');
  }

  if (body.status === 'CONFIRMED') {
    if (isBlank(body.resolution)) {
      errors.push('resolution is required and must be a non-empty string');
    }
    if (typeof body.faultType !== 'string' || !FAULT_EVENT_FAULT_TYPES.includes(body.faultType)) {
      errors.push(`faultType must be one of: ${FAULT_EVENT_FAULT_TYPES.join(', ')}`);
    }
  }

  return errors;
}
