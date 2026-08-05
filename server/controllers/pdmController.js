// ─────────────────────────────────────────────────────────────────────────
// pdmController.js — HITL review endpoints (§3.6). Calls faultEventService
// only, never faultEventModel directly (controller→service→model layering).
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/faultEventService.js';

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

export function reviewFaultEvent(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const { status, faultType, rootCause, resolution, reviewedBy, notes, faultEnd } = req.body;
    const updated = service.reviewFaultEvent(id, { status, faultType, rootCause, resolution, reviewedBy, notes, faultEnd });
    if (!updated) return res.status(404).json({ success: false, error: 'fault event not found' });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

export function getFaultEventStats(req, res, next) {
  try {
    res.json({ success: true, data: service.getFaultEventStats() });
  } catch (err) {
    next(err);
  }
}
