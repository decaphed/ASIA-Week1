// ─────────────────────────────────────────────────────────────────────────
// pdmManualBufferValidation.js — pure validation for POST
// /pdm/fault-events/manual-buffer's body (§10.4 Entry point 1: an operator
// retroactively confirming a fault over a raw_telemetry range Tier 1 never
// flagged or that was never reviewed).
//
// This endpoint creates a CONFIRMED row from a single reviewer's assertion
// with no second-human check (§10.4's explicit resolution — a human
// directly asserting ground truth doesn't need HITL re-review the way an
// automated Tier 1 guess does). Because that's a materially higher-trust
// action than the existing PATCH-confirm endpoint (which is at least
// checking a machine-computed candidate), `notes` is mandatory here even
// though pdmReviewValidation.js's PATCH validation treats it as optional —
// this is the audit-trail requirement, not a copy-paste omission.
// ─────────────────────────────────────────────────────────────────────────

import { FAULT_EVENT_FAULT_TYPES } from './pdmReviewValidation.js';
import { WINDOW_DURATION_SECONDS } from '../preprocessing/config.js';

const MAX_HOURS = parseInt(process.env.PDM_MANUAL_BUFFER_MAX_HOURS, 10) || 168;

function isBlank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

function parseIso(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * @returns {string[]} human-readable error messages (empty array = valid).
 */
export function validateManualBufferCreate(body) {
  const errors = [];

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return ['request body must be an object'];
  }

  const faultStartMs = parseIso(body.faultStart);
  const faultEndMs = parseIso(body.faultEnd);
  if (faultStartMs === null) errors.push('faultStart must be a valid ISO timestamp');
  if (faultEndMs === null) errors.push('faultEnd must be a valid ISO timestamp');

  if (faultStartMs !== null && faultEndMs !== null) {
    if (faultStartMs >= faultEndMs) {
      errors.push('faultStart must be before faultEnd');
    } else {
      const spanSeconds = (faultEndMs - faultStartMs) / 1000;
      if (spanSeconds < WINDOW_DURATION_SECONDS) {
        errors.push(`fault range must span at least ${WINDOW_DURATION_SECONDS} seconds (one processing window)`);
      }
      const spanHours = spanSeconds / 3600;
      if (spanHours > MAX_HOURS) {
        errors.push(`fault range must not exceed ${MAX_HOURS} hours (PDM_MANUAL_BUFFER_MAX_HOURS)`);
      }
    }
  }

  if (body.triggerWindowEnd !== undefined && parseIso(body.triggerWindowEnd) === null) {
    errors.push('triggerWindowEnd, if given, must be a valid ISO timestamp');
  }

  if (typeof body.faultType !== 'string' || !FAULT_EVENT_FAULT_TYPES.includes(body.faultType)) {
    errors.push(`faultType must be one of: ${FAULT_EVENT_FAULT_TYPES.join(', ')}`);
  }
  if (isBlank(body.rootCause)) {
    errors.push('rootCause is required and must be a non-empty string');
  }
  if (isBlank(body.resolution)) {
    errors.push('resolution is required and must be a non-empty string');
  }
  // Mandatory here (unlike pdmReviewValidation.js's optional `notes`) — see
  // this file's header comment for why: the audit-trail requirement for a
  // single-reviewer action that skips HITL review entirely.
  if (isBlank(body.notes)) {
    errors.push('notes is required and must be a non-empty string (justification for this manual assertion)');
  }

  return errors;
}
