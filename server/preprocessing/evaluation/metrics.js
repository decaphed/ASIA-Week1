// ─────────────────────────────────────────────────────────────────────────
// metrics.js — evaluation metrics for fault-onset prediction: precision/
// recall at a lead-time window, and Brier score. Pure functions, generic
// over a `predictions` array of `{ timestamp, score }` objects (score in
// [0,1]) — deliberately not coupled to how those predictions were produced,
// so the exact same functions score today's non-learned threshold-crossing
// baseline (see server/scripts/evaluateFaultPrediction.js) and any future
// real classifier identically. Per the project's evaluation requirement, a
// future classifier must beat the baseline's numbers from THESE functions at
// the SAME lead time before it is worth shipping.
// ─────────────────────────────────────────────────────────────────────────

const MINUTE_MS = 60 * 1000;

function minutesBetween(fromIso, toIso) {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / MINUTE_MS;
}

/**
 * Greedy-matched precision/recall for predictions that fire within a
 * [leadMinMinutes, leadMaxMinutes] window BEFORE a true FAULT episode onset.
 *
 * A prediction is a true positive if score >= threshold AND it falls within
 * the lead window before some episode's startTimestamp that hasn't already
 * been matched to an earlier prediction. Predictions are considered in
 * timestamp order so each episode is claimed by the earliest qualifying
 * prediction; any remaining above-threshold predictions become false
 * positives, and any episode with no matching prediction becomes a false
 * negative.
 *
 * @param {{timestamp: string, score: number}[]} predictions
 * @param {{startTimestamp: string}[]} episodes true FAULT onsets in the same
 *   evaluation window (e.g. testEpisodes from walkForwardSplit).
 * @param {{leadMinMinutes: number, leadMaxMinutes: number, threshold: number}} options
 * @returns {{precision: number|null, recall: number|null, tp: number, fp: number, fn: number}}
 */
export function precisionRecallAtLeadTime(predictions, episodes, { leadMinMinutes, leadMaxMinutes, threshold }) {
  const matchedEpisodes = new Set();
  let tp = 0;
  let fp = 0;

  const sortedPredictions = predictions
    .filter((p) => p.score >= threshold)
    .slice()
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  for (const prediction of sortedPredictions) {
    let matched = false;

    for (let i = 0; i < episodes.length; i++) {
      if (matchedEpisodes.has(i)) continue;

      // Minutes from prediction to onset; positive = prediction came before
      // onset (a genuine "lead").
      const lead = minutesBetween(prediction.timestamp, episodes[i].startTimestamp);

      if (lead >= leadMinMinutes && lead <= leadMaxMinutes) {
        matchedEpisodes.add(i);
        matched = true;
        break;
      }
    }

    if (matched) {
      tp += 1;
    } else {
      fp += 1;
    }
  }

  const fn = episodes.length - matchedEpisodes.size;

  return {
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
    tp,
    fp,
    fn,
  };
}

/**
 * Mean squared error between each prediction's score and the actual binary
 * outcome: did a true FAULT episode start within leadMaxMinutes AFTER that
 * prediction's timestamp (0 = no, 1 = yes). Unlike precisionRecallAtLeadTime,
 * this scores EVERY prediction (not just above-threshold ones) against the
 * ground truth, so it captures calibration quality as well as detection.
 * @param {{timestamp: string, score: number}[]} predictions
 * @param {{startTimestamp: string}[]} episodes
 * @param {{leadMaxMinutes: number}} options
 * @returns {number|null} null if predictions is empty.
 */
export function brierScore(predictions, episodes, { leadMaxMinutes }) {
  if (predictions.length === 0) return null;

  const squaredErrors = predictions.map((prediction) => {
    const outcome = episodes.some((episode) => {
      const lead = minutesBetween(prediction.timestamp, episode.startTimestamp);
      return lead >= 0 && lead <= leadMaxMinutes;
    }) ? 1 : 0;

    return (prediction.score - outcome) ** 2;
  });

  return squaredErrors.reduce((a, b) => a + b, 0) / squaredErrors.length;
}
