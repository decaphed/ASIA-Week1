// ─────────────────────────────────────────────────────────────────────────
// episodes.js — identifies FAULT episodes in processed_telemetry rows and
// performs a chronological, campaign-level train/test split for evaluating
// fault-onset prediction. Pure functions, no DB/Express (styled like
// preprocessing/aggregation.js) — callers own reading the rows and doing
// anything with the split beyond computing it.
//
// "Episode" = one contiguous run of dominantStatus === 'FAULT' rows in a
// rows array ordered oldest-first (the same order db queries use with
// `ORDER BY id ASC`). A single FAULT episode almost always spans multiple
// consecutive 1-minute processed_telemetry rows (a fault condition doesn't
// resolve in 60 seconds), so "episode" and "row" are deliberately different
// units throughout this module — counts/fractions here operate on episodes,
// not rows, unless a name says otherwise (e.g. rowCount).
// ─────────────────────────────────────────────────────────────────────────

// Minimum number of real FAULT-onset episodes required before any
// walk-forward split / evaluation is considered trustworthy. Mirrors
// server/services/forecastService.js's MIN_READINGS = 12 guard: that gate
// exists because fitting (there, a forecast slope) on too few samples lets
// the fit "explain" noise instead of signal and report a confident-looking
// but meaningless result. The same failure mode applies here at a higher
// level — a precision/recall number computed over a handful of onset
// episodes is not a reliable estimate of how a classifier (or the baseline)
// will perform on the next one. checkEvaluationGate() is the mechanical
// enforcement of this: evaluateFaultPrediction.js must not proceed past it
// when the real episode count is below MIN_ONSET_EPISODES.
export const MIN_ONSET_EPISODES = 100;

/**
 * @param {object[]} rows processed_telemetry rows, oldest-first
 *   (`ORDER BY id ASC` / `ORDER BY timestamp ASC`). Each row is expected to
 *   have `dominantStatus`, `timestamp`.
 * @returns {{startIndex:number, endIndex:number, startTimestamp:string,
 *   endTimestamp:string, rowCount:number}[]} one entry per contiguous run of
 *   dominantStatus === 'FAULT' rows, in the same (chronological) order as
 *   `rows`. `startIndex`/`endIndex` are inclusive indices into `rows`.
 */
export function identifyEpisodes(rows) {
  const episodes = [];
  let start = null;

  for (let i = 0; i < rows.length; i++) {
    const inFault = rows[i].dominantStatus === 'FAULT';

    if (inFault && start === null) {
      start = i;
    }

    const runEnds = start !== null && (i === rows.length - 1 || rows[i + 1].dominantStatus !== 'FAULT');
    if (inFault && runEnds) {
      episodes.push({
        startIndex: start,
        endIndex: i,
        startTimestamp: rows[start].timestamp,
        endTimestamp: rows[i].timestamp,
        rowCount: i - start + 1,
      });
      start = null;
    }
  }

  return episodes;
}

/**
 * @param {object[]} rows processed_telemetry rows, oldest-first.
 * @returns {{ready:boolean, episodeCount:number, required:number}}
 */
export function checkEvaluationGate(rows) {
  const episodeCount = identifyEpisodes(rows).length;
  return {
    ready: episodeCount >= MIN_ONSET_EPISODES,
    episodeCount,
    required: MIN_ONSET_EPISODES,
  };
}

/**
 * Chronological, campaign-level walk-forward split.
 *
 * Why not a random/k-fold split: adjacent 1-minute processed_telemetry rows
 * are highly autocorrelated (see driftService.js — motorTemp's observed
 * lag-1 autocorrelation is ~0.9). A random or k-fold split would routinely
 * place near-duplicate neighboring minutes on both sides of the split,
 * letting a model "predict" the test set by interpolating between
 * essentially-the-same training rows sitting right next to it in time —
 * a leakage channel that produces spuriously good offline scores which do
 * not hold up online, where the model only ever sees the future once. A
 * walk-forward split — train strictly precedes test in time — is the only
 * split that mirrors how the model will actually be used.
 *
 * The split is also done at whole-EPISODE granularity, not row granularity:
 * splitting a single FAULT episode's rows across train and test would leak
 * the tail-end of a fault (which strongly informs a classifier what fault
 * onset looks like) into training while its beginning is being "predicted"
 * in test, again inflating scores in a way that would not replicate live.
 *
 * @param {object[]} rows processed_telemetry rows, oldest-first.
 * @param {{testEpisodeFraction?: number}} [opts] fraction of episodes (by
 *   episode order, not row count) held out for test, taken from the most
 *   recent end of the timeline. Default 0.2 (last 20% of episodes).
 * @returns {{trainRows:object[], testRows:object[], trainEpisodes:object[],
 *   testEpisodes:object[]}}
 */
export function walkForwardSplit(rows, { testEpisodeFraction = 0.2 } = {}) {
  const episodes = identifyEpisodes(rows);

  if (episodes.length === 0) {
    // Nothing to split on — everything is "train", nothing is "test".
    return { trainRows: rows.slice(), testRows: [], trainEpisodes: [], testEpisodes: [] };
  }

  const testCount = Math.max(1, Math.round(episodes.length * testEpisodeFraction));
  const splitEpisodeIndex = Math.max(0, episodes.length - testCount);

  const trainEpisodes = episodes.slice(0, splitEpisodeIndex);
  const testEpisodes = episodes.slice(splitEpisodeIndex);

  // The split point in time is exactly the first test episode's onset. Every
  // row before that timestamp is train; every row from it onward (inclusive)
  // is test. Because episodes are contiguous, non-overlapping runs in
  // chronological row order, this timestamp cut can never fall inside a
  // FAULT episode — it lands exactly on one's start — so no episode is ever
  // split across train and test.
  const splitTimestamp = testEpisodes[0].startTimestamp;

  const trainRows = [];
  const testRows = [];
  for (const row of rows) {
    if (row.timestamp < splitTimestamp) {
      trainRows.push(row);
    } else {
      testRows.push(row);
    }
  }

  return { trainRows, testRows, trainEpisodes, testEpisodes };
}
