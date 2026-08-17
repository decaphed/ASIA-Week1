// ─────────────────────────────────────────────────────────────────────────
// recordTrainingRun.js — reads a RetrainResult JSON (from
// pdm/app/retrain.py::run_retrain) off stdin and persists it to
// training_runs. This is the ONE place a training run's result ever
// reaches Postgres — pdm/app/retrain.py itself never opens a write
// connection (§3.4's "Python never writes application data" invariant,
// unchanged by §10.5's read-only corpus role for training_corpus).
//
// Usage: python -m pdm.app.retrain | node server/scripts/recordTrainingRun.js
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
    corpusContentHash: result.corpusContentHash,
    corpusRowManifest: JSON.stringify(result.corpusRowManifest),
    corpusRowCount: result.corpusRowCount,
    trainedAt: result.trainedAt,
    metrics: JSON.stringify(result.metrics),
    artifactPath: result.artifactPath ?? null,
    promoted: result.promoted,
    promotionReason: result.promotionReason,
    championRunIdAtEval: result.championRunIdAtEval ?? null,
  });

  process.stdout.write(JSON.stringify({ trainingRunId: id, promoted: result.promoted }));
}

main().catch((err) => {
  process.stderr.write(`recordTrainingRun.js error: ${err.stack || err.message}\n`);
  process.exit(1);
});
