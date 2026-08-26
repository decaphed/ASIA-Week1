// ─────────────────────────────────────────────────────────────────────────
// pdmController.js — HITL review endpoints (§3.6). Calls faultEventService
// only, never faultEventModel directly (controller→service→model layering).
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/faultEventService.js';
import { validateReviewPatch } from '../utils/pdmReviewValidation.js';
import { validateManualBufferCreate } from '../utils/pdmManualBufferValidation.js';
import { toCsv } from '../utils/csv.js';

const EXPORT_COLUMNS = [
  'faultEventId', 'phase', 'eventStatus', 'eventFaultType', 'timestamp',
  'engineRpm', 'lubOilPressure', 'fuelPressure', 'coolantPressure', 'lubOilTemperature', 'coolantTemperature', 'engineStatus',
];

export async function listFaultEvents(req, res, next) {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json({ success: true, data: await service.listFaultEvents(status) });
  } catch (err) {
    next(err);
  }
}

export async function getFaultEvent(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const event = await service.getFaultEvent(id);
    if (!event) return res.status(404).json({ success: false, error: 'fault event not found' });
    res.json({ success: true, data: event });
  } catch (err) {
    next(err);
  }
}

export async function reviewFaultEvent(req, res, next) {
  try {
    const body = req.body ?? {};
    const errors = validateReviewPatch(body);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: 'Invalid fault event review', details: errors });
    }

    const id = parseInt(req.params.id, 10);
    const { status, faultType, rootCause, resolution, reviewedBy, notes, faultEnd } = body;

    // Blank optional strings must become undefined, not '' — the service
    // does `patch.x ?? existing.x`, so an explicit '' would overwrite an
    // existing value where undefined preserves it.
    //
    // reviewedBy is validated above but NOT trusted as the actor identity —
    // when the request carries an Authentik identity (i.e. it came through
    // the forward-auth gate), the persisted value is the authenticated
    // username, not whatever the client sent, so a reviewer can't attribute
    // a decision to someone else. Falls back to the client-supplied value
    // when there's no identity (direct/dev access — see
    // middleware/authentikIdentity.js), matching this repo's existing trust
    // boundary at the Docker network edge.
    const patch = {
      status,
      faultType,
      rootCause: typeof rootCause === 'string' ? rootCause.trim() : rootCause,
      resolution: typeof resolution === 'string' && resolution.trim() === '' ? undefined : resolution,
      reviewedBy: req.identity?.username || (typeof reviewedBy === 'string' ? reviewedBy.trim() : reviewedBy),
      notes: typeof notes === 'string' && notes.trim() === '' ? undefined : notes,
      faultEnd,
    };

    const updated = await service.reviewFaultEvent(id, patch);
    if (!updated) return res.status(404).json({ success: false, error: 'fault event not found' });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

/**
 * §10.4 Entry point 1 — creates a CONFIRMED fault_events row directly from
 * an operator's assertion, no PENDING_REVIEW step. Errors from the service
 * layer (422 no-data, 409 overlap, 502 pdm-call-failed, 400 window-bounds)
 * carry their own .status and fall through to next(err) — the shared
 * errorHandler (server/middleware/errorHandler.js) already reads err.status
 * and echoes err.message for anything below 500, so no per-status mapping
 * is needed here.
 */
export async function createManualBufferEvent(req, res, next) {
  try {
    const body = req.body ?? {};
    const errors = validateManualBufferCreate(body);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: 'Invalid manual buffer request', details: errors });
    }

    // Same trust boundary as reviewFaultEvent: the authenticated identity
    // (when present) is what gets persisted, never a client-supplied
    // reviewedBy — a reviewer can't attribute this assertion to someone else.
    const reviewedBy = req.identity?.username || (typeof body.reviewedBy === 'string' ? body.reviewedBy.trim() : undefined);
    if (!reviewedBy) {
      return res.status(400).json({ success: false, error: 'Invalid manual buffer request', details: ['reviewedBy is required when no Authentik identity is present'] });
    }

    const created = await service.createManualBufferEvent(body, reviewedBy);
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    next(err);
  }
}

export async function getFaultEventStats(req, res, next) {
  try {
    res.json({ success: true, data: await service.getFaultEventStats() });
  } catch (err) {
    next(err);
  }
}

/**
 * CSV training-data export: every reviewed event's buffer window
 * (faultStart-1h .. faultEnd+1h), one row per raw_telemetry sample, tagged
 * with faultEventId + phase (see faultEventService.exportBufferRows).
 * ?status= optionally restricts to one fault_events status (e.g. CONFIRMED).
 */
export async function exportFaultEventBuffers(req, res, next) {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const rows = await service.exportBufferRows(status);
    const csv = toCsv(rows, EXPORT_COLUMNS);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fault-event-buffers.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
}
