// ─────────────────────────────────────────────────────────────────────────
// recordBootstrapRun.js — reads pdm/app/training.py's `fit` CLI JSON output
// off stdin and persists it to training_runs, reusing the SAME table
// recordTrainingRun.js writes to (§15.1/D56: one table of trained
// artifacts, bootstrap and ongoing corpus retrains alike — not a
// fragmented second bookkeeping mechanism).
//
// Unlike recordTrainingRun.js (an ongoing champion/challenger comparison,
// always has a promotionReason from decide_promotion()), the bootstrap has
// no corpus and no prior champion to compare against — it's promoted
// unconditionally, the same semantics decide_promotion() already gives a
// genuine first candidate ("no champion yet").
//
// Usage: python -m pdm.app.training fit data/train.csv | node server/scripts/recordBootstrapRun.js
// Then: python -m pdm.app.training stamp-run-id <printed trainingRunId>
// (see pdm/app/training.py's module docstring for why this two-step
// handoff exists — Python never writes Postgres, §3.4's invariant).
// ─────────────────────────────────────────────────────────────────────────

import * as trainingRunModel from '../models/trainingRunModel.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  const result = JSON.parse(raw);

  const { id } = await trainingRunModel.insertRun({
    // No training_corpus involvement for the bootstrap (§15.1's whole
    // point) — these three fields describe train.csv itself instead, so a
    // reader of training_runs history isn't left with meaningless zeros.
    corpusContentHash: `bootstrap:train.csv:${result.artifactSha256}`,
    corpusRowManifest: JSON.stringify({ source: 'data/train.csv', labelClasses: result.labelClasses }),
    corpusRowCount: 0,
    trainedAt: result.trainedAt,
    metrics: JSON.stringify(result.metrics),
    artifactPath: result.artifactPath,
    promoted: true,
    promotionReason: 'bootstrap model fit from train.csv (§15.1/D51) — no champion yet, first Tier 2 artifact',
    championRunIdAtEval: null,
  });

  process.stdout.write(JSON.stringify({ trainingRunId: id }));
}

main().catch((err) => {
  process.stderr.write(`recordBootstrapRun.js error: ${err.stack || err.message}\n`);
  process.exit(1);
});
