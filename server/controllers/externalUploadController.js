// ─────────────────────────────────────────────────────────────────────────
// externalUploadController.js — §10.4 Entry point 2's HTTP endpoints.
// Calls externalUploadService only, never externalUploadModel/corpusModel
// directly (controller→service→model layering, matching pdmController.js).
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/externalUploadService.js';

/** POST /pdm/fault-events/external-upload — Stage A on a just-uploaded CSV. */
export async function uploadExternalCsv(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'no file uploaded (expected multipart field "file")' });
    }
    const uploadedBy = req.identity?.username || (typeof req.body?.uploadedBy === 'string' ? req.body.uploadedBy.trim() : undefined);
    if (!uploadedBy) {
      return res.status(400).json({ success: false, error: 'uploadedBy is required when no Authentik identity is present' });
    }

    const result = await service.handleUpload(req.file.path, req.file.originalname, uploadedBy);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/** POST /pdm/fault-events/external-upload/:uploadId/confirm — Stage B + Stage C + materialization. */
export async function confirmExternalUpload(req, res, next) {
  try {
    const uploadId = Number(req.params.uploadId);
    if (!Number.isInteger(uploadId)) {
      return res.status(400).json({ success: false, error: 'uploadId must be an integer' });
    }

    const body = req.body ?? {};
    if (typeof body.faultType !== 'string' || !body.faultType) {
      return res.status(400).json({ success: false, error: 'faultType is required' });
    }
    if (typeof body.rootCause !== 'string' || !body.rootCause.trim()) {
      return res.status(400).json({ success: false, error: 'rootCause is required' });
    }
    if (typeof body.resolution !== 'string' || !body.resolution.trim()) {
      return res.status(400).json({ success: false, error: 'resolution is required' });
    }
    if (typeof body.notes !== 'string' || !body.notes.trim()) {
      return res.status(400).json({ success: false, error: 'notes is required (justification, same as manual-buffer)' });
    }

    const reviewedBy = req.identity?.username || (typeof body.reviewedBy === 'string' ? body.reviewedBy.trim() : undefined);
    if (!reviewedBy) {
      return res.status(400).json({ success: false, error: 'reviewedBy is required when no Authentik identity is present' });
    }

    const result = await service.confirmUpload(uploadId, body, reviewedBy);
    if (result.requiresConfirmation) {
      return res.status(200).json({ success: true, data: result });
    }
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
