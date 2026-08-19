// ─────────────────────────────────────────────────────────────────────────
// uploadFile.js — multer config for §10.4 Entry point 2's CSV upload
// endpoint. The first file-upload surface in this codebase — see this
// module's own comments for why each control exists, not just what it does.
//
// TEMP FILENAME (design-review HIGH finding, fixed): the on-disk temp
// filename is ALWAYS crypto.randomUUID() + a fixed .csv extension — NEVER
// derived from file.originalname. Echoing a client-supplied filename into
// a disk-storage path (even after a naive sanitize) is the single most
// common multer footgun: a crafted originalname containing '../' segments
// or null bytes can write outside the scratch dir, or collide with/
// overwrite another in-flight upload's temp file. originalname is stored
// only as a metadata STRING (external_uploads."originalFilename"), never
// used to construct a filesystem path anywhere in this codebase.
// ─────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';

const UPLOAD_MAX_BYTES = parseInt(process.env.PDM_UPLOAD_MAX_BYTES, 10) || 50 * 1024 * 1024; // 50MB
const SCRATCH_DIR = process.env.PDM_UPLOAD_SCRATCH_DIR || os.tmpdir();

const ALLOWED_MIME_TYPES = new Set(['text/csv', 'application/vnd.ms-excel', 'application/csv', 'text/plain']);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, SCRATCH_DIR),
  filename: (_req, _file, cb) => cb(null, `pdm-upload-${crypto.randomUUID()}.csv`),
});

function fileFilter(_req, file, cb) {
  // Extension AND MIME allowlist — neither alone is trustworthy (a
  // browser/client controls both the declared MIME type and the
  // filename), but together they reject the obviously-wrong case cheaply,
  // before any bytes are parsed. Real content validation (RFC4180
  // structure, a real time axis, etc.) happens in Stage A, on the actual
  // parsed content, not the file's stated type.
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext !== '.csv') {
    return cb(new Error('only .csv files are accepted'));
  }
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return cb(new Error(`unsupported content type: ${file.mimetype}`));
  }
  return cb(null, true);
}

export const uploadCsv = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: UPLOAD_MAX_BYTES,
    files: 1,
  },
});
