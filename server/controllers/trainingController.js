// ─────────────────────────────────────────────────────────────────────────
// trainingController.js — §15.7's /pdm/training/* HTTP endpoints. Calls
// trainingService only, never pdm/DB models directly (controller->service
// layering, matching pdmController.js/externalUploadController.js).
// ─────────────────────────────────────────────────────────────────────────

import * as service from '../services/trainingService.js';

export async function uploadTrainingCsv(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'no file uploaded (expected multipart field "file")' });
    }
    const result = await service.uploadCsv(req.file.path, req.file.originalname);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    if (err.status === 422) {
      // The quality gate rejected the CSV — this is a well-formed "no" the
      // FE renders inline, not an unexpected failure to log-and-500.
      let detail;
      try {
        detail = JSON.parse(err.message);
      } catch {
        detail = { reasons: [err.message] };
      }
      return res.status(422).json({ success: false, error: 'quality gate rejected the upload', ...detail });
    }
    next(err);
  }
}

export async function fitTrainingCandidate(req, res, next) {
  try {
    const result = await service.fitCandidate(req.params.uploadId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function deployTrainingCandidate(req, res, next) {
  try {
    const result = await service.deployCandidate(req.params.uploadId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function discardTrainingCandidate(req, res, next) {
  try {
    const result = await service.discardCandidate(req.params.uploadId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function resetTrainingModel(req, res, next) {
  try {
    const result = await service.resetModel();
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function listTrainingRuns(req, res, next) {
  try {
    const runs = await service.listRuns();
    res.status(200).json({ success: true, data: runs });
  } catch (err) {
    next(err);
  }
}
