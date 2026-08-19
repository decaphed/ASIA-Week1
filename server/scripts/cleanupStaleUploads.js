// ─────────────────────────────────────────────────────────────────────────
// cleanupStaleUploads.js — purges stagedRows for external_uploads that
// have sat in AWAITING_MAPPING (an operator uploaded a file, Stage A
// passed, but the mapping screen was never confirmed) past a TTL. §10.4
// Entry point 2 / design review D18: nothing should hold an uploaded
// file's full content in Postgres indefinitely — an abandoned mapping
// screen is exactly that case.
//
// Run with: node server/scripts/cleanupStaleUploads.js
// (cron/manual — no schedule wired into this repo's own infrastructure)
// ─────────────────────────────────────────────────────────────────────────

import { getStaleAwaitingMapping, purgeStagedRows } from '../models/externalUploadModel.js';
import { logger } from '../utils/logger.js';

const TTL_HOURS = parseInt(process.env.PDM_UPLOAD_STAGING_TTL_HOURS, 10) || 24;

async function main() {
  const cutoff = new Date(Date.now() - TTL_HOURS * 60 * 60 * 1000).toISOString();
  const stale = await getStaleAwaitingMapping(cutoff);

  for (const upload of stale) {
    // eslint-disable-next-line no-await-in-loop
    await purgeStagedRows(upload.id);
    logger.info(`cleanupStaleUploads: purged stagedRows for upload #${upload.id} (uploaded ${upload.uploadedAt}, past ${TTL_HOURS}h TTL)`);
  }

  logger.info(`cleanupStaleUploads: purged ${stale.length} stale upload(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`cleanupStaleUploads: failed: ${err.stack || err.message}`);
    process.exit(1);
  });
