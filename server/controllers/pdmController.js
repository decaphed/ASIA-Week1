// ─────────────────────────────────────────────────────────────────────────
// pdmController.js — HITL review endpoints (§3.6). Calls faultEventService
// only, never faultEventModel directly (controller→service→model layering).
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/faultEventService.js';
import { validateReviewPatch } from '../utils/pdmReviewValidation.js';

export function listFaultEvents(req, res, next) {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json({ success: true, data: service.listFaultEvents(status) });
  } catch (err) {
    next(err);
  }
}

export function getFaultEvent(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const event = service.getFaultEvent(id);
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
    const patch = {
      status,
      faultType,
      rootCause: typeof rootCause === 'string' ? rootCause.trim() : rootCause,
      resolution: typeof resolution === 'string' && resolution.trim() === '' ? undefined : resolution,
      reviewedBy: typeof reviewedBy === 'string' ? reviewedBy.trim() : reviewedBy,
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

export async function getFaultEventStats(req, res, next) {
  try {
    res.json({ success: true, data: await service.getFaultEventStats() });
  } catch (err) {
    next(err);
  }
}
