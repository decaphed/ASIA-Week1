// ─────────────────────────────────────────────────────────────────────────
// trainingService.js — Node's HTTP proxy to pdm's /training/* endpoints
// (§15.7's upload -> quality-check -> fit -> compare -> deploy loop). Same
// "Node calls pdm over HTTP" pattern pdmService.js/externalUploadService.js
// already use for /score and /process-window.
//
// On a successful deploy, this module records the promoted run into
// training_runs — Python never writes Postgres (§3.4's invariant), so pdm
// only ever returns a JSON result and Node persists it, same handoff shape
// recordBootstrapRun.js uses for the CLI-piped bootstrap path.
// ─────────────────────────────────────────────────────────────────────────

import { openAsBlob } from 'node:fs';
import { unlink } from 'node:fs/promises';

import * as trainingRunModel from '../models/trainingRunModel.js';
import { logger } from '../utils/logger.js';

const PDM_SERVICE_URL = process.env.PDM_SERVICE_URL || 'http://localhost:8000';
const UPLOAD_TIMEOUT_MS = 15000;
const FIT_TIMEOUT_MS = 60000;
const DEPLOY_TIMEOUT_MS = 15000;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function pdmJsonPost(path, timeoutMs) {
  let res;
  try {
    res = await fetch(`${PDM_SERVICE_URL}${path}`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw httpError(502, `pdm ${path} call failed: ${err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status, body?.detail ? JSON.stringify(body.detail) : `pdm ${path} responded ${res.status}`);
  return body;
}

/** @param tempFilePath a just-uploaded temp CSV (multer diskStorage, uploadFile.js). */
export async function uploadCsv(tempFilePath, originalFilename) {
  try {
    // openAsBlob() (Node >=19.8) gives FormData a Blob-like handle backed by
    // the file on disk — the bytes are streamed to pdm as fetch consumes the
    // multipart body, not read into a single in-memory Buffer first, unlike
    // the readFile()+`new Blob([...])` approach this replaced. Same
    // streaming discipline server/utils/csvParse.js already uses (via
    // createReadStream) for the pre-existing external-upload CSV path.
    const form = new FormData();
    form.append('file', await openAsBlob(tempFilePath), originalFilename);

    let res;
    try {
      res = await fetch(`${PDM_SERVICE_URL}/training/upload`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (err) {
      throw httpError(502, `pdm /training/upload call failed: ${err.message}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(res.status, body?.detail ? JSON.stringify(body.detail) : `pdm /training/upload responded ${res.status}`);
    return body;
  } finally {
    try {
      await unlink(tempFilePath);
    } catch (err) {
      logger.error(`trainingService: failed to delete temp upload file ${tempFilePath}: ${err.message}`);
    }
  }
}

export function fitCandidate(uploadId) {
  return pdmJsonPost(`/training/${encodeURIComponent(uploadId)}/fit`, FIT_TIMEOUT_MS);
}

export async function deployCandidate(uploadId) {
  const result = await pdmJsonPost(`/training/${encodeURIComponent(uploadId)}/deploy`, DEPLOY_TIMEOUT_MS);

  // Design-review finding, accepted as a known interaction rather than
  // fixed here: this INSERT reuses the same training_runs table and the
  // same `promoted` flag retrain.py's (currently unwired — see its own
  // _main() stub) corpus-based champion/challenger loop expects
  // trainingRunModel.getChampion() to reflect. An upload-deployed model
  // becomes the next corpus-based challenger's comparison baseline, mixing
  // two different data lineages under one pointer. Acceptable today since
  // retrain.py's CLI entry point isn't wired to anything yet (see its
  // module docstring: "actual Tier 2 training is explicitly out of
  // scope"); revisit this if/when that loop is built for real — either
  // give upload-sourced runs a filterable marker getChampion() can
  // exclude, or make the two flows explicitly aware of each other.
  // Design-review finding, fixed: pdm's /deploy above already overwrote the
  // live model.joblib/metadata.json and called model.reload() — since the
  // copied metadata.json still has runId: null at that point, Tier 2 is
  // ALREADY inactive the instant /deploy returns, whether or not the rest
  // of this function succeeds. If insertRun() or the stamp-run-id call
  // below fails, the previous working model is gone (overwritten), the new
  // one is unloadable (runId still null), and Tier 2 stays dark until deploy
  // is retried. Wrap both steps so the thrown error says so explicitly,
  // instead of leaking a generic DB/fetch error that gives the operator no
  // hint the live artifact was already replaced.
  let trainingRunId;
  try {
    ({ id: trainingRunId } = await trainingRunModel.insertRun({
      corpusContentHash: `bootstrap:upload:${result.artifactSha256}`,
      corpusRowManifest: JSON.stringify({ source: 'upload', uploadId }),
      corpusRowCount: 0,
      trainedAt: result.trainedAt,
      metrics: JSON.stringify(result.metrics),
      artifactPath: null,
      promoted: true,
      promotionReason: 'operator-deployed candidate from an uploaded training CSV (§15.7)',
      championRunIdAtEval: null,
    }));

    // Same fit -> insert -> stamp handoff the CLI bootstrap flow already
    // uses (recordBootstrapRun.js -> `python -m pdm.app.training
    // stamp-run-id`), just over HTTP.
    const stampRes = await fetch(`${PDM_SERVICE_URL}/training/stamp-run-id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: trainingRunId }),
      signal: AbortSignal.timeout(DEPLOY_TIMEOUT_MS),
    });
    if (!stampRes.ok) throw new Error(`pdm /training/stamp-run-id responded ${stampRes.status}`);
  } catch (err) {
    throw httpError(
      502,
      'model file was deployed but activation failed (Tier 2 is currently INACTIVE) — re-run deploy or contact an operator: ' + err.message,
    );
  }

  return { ...result, trainingRunId };
}

export async function discardCandidate(uploadId) {
  let res;
  try {
    res = await fetch(`${PDM_SERVICE_URL}/training/${encodeURIComponent(uploadId)}`, {
      method: 'DELETE', signal: AbortSignal.timeout(DEPLOY_TIMEOUT_MS),
    });
  } catch (err) {
    throw httpError(502, `pdm DELETE /training/${uploadId} call failed: ${err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status, `pdm DELETE /training/${uploadId} responded ${res.status}`);
  return body;
}

export function resetModel() {
  return pdmJsonPost('/training/reset', DEPLOY_TIMEOUT_MS);
}

export function listRuns() {
  return trainingRunModel.listRuns();
}
