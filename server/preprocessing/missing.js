// ─────────────────────────────────────────────────────────────────────────
// missing.js — missing-sample detection AND gap-filling.
//
// detectMissing() walks a completed window's timestamps and counts gaps in
// the ~1 Hz series — this now only ever finds RESIDUAL gaps, i.e. ones too
// large to trust an interpolated guess for (see generateFillSamples below),
// since fillable gaps are reconstructed proactively, per incoming sample, in
// pipeline.js — before a window is ever assembled.
//
// generateFillSamples() is the actual gap-filling: for a gap up to
// MAX_FILLABLE_GAP_SECONDS, linearly interpolate each missing tick's numeric
// metrics between the last known-good sample and the newly-arrived one, and
// carry the last known status forward (status is categorical — it can't be
// interpolated). Each fill sample is tagged provenance: 'IMPUTED' and goes
// on to be stored, physics-validated, and buffered exactly like a real
// sample (see pipeline.js) — the tag is what keeps it distinguishable, not
// special-case handling elsewhere in the pipeline.
// ─────────────────────────────────────────────────────────────────────────

const GAP_THRESHOLD_SECONDS = 1.5;

// Longer than this, a straight-line guess is more likely to be wrong than
// right (e.g. a real regime change could have happened during the silence) —
// leave it as a genuine, uninterpolated gap instead of fabricating it.
export const MAX_FILLABLE_GAP_SECONDS = 10;

/**
 * @param {object[]} window a completed 60-sample window, in arrival order.
 * @returns {number} missingSampleCount — estimated number of ticks that never arrived.
 */
export function detectMissing(window) {
  let missingCount = 0;

  for (let i = 1; i < window.length; i++) {
    const dtSec = (new Date(window[i].timestamp).getTime() - new Date(window[i - 1].timestamp).getTime()) / 1000;
    if (dtSec > GAP_THRESHOLD_SECONDS) {
      missingCount += Math.round(dtSec) - 1;
    }
  }

  return missingCount;
}

/**
 * @param {object|null} lastSample the last sample actually pushed (any provenance), or null if this is the first ever.
 * @param {object} newSample the just-arrived real sample.
 * @param {string[]} metrics numeric metric names to interpolate.
 * @returns {object[]} zero or more synthesized samples to insert (in order) between lastSample and newSample.
 */
export function generateFillSamples(lastSample, newSample, metrics) {
  if (!lastSample) return [];

  const lastMs = new Date(lastSample.timestamp).getTime();
  const newMs = new Date(newSample.timestamp).getTime();
  const dtSec = (newMs - lastMs) / 1000;

  // Too large to trust a straight line, arrived out of order, or not
  // actually a gap (normal ~1s cadence) — nothing to fill.
  if (dtSec > MAX_FILLABLE_GAP_SECONDS) return [];
  const missingTicks = Math.round(dtSec) - 1;
  if (missingTicks <= 0) return [];

  const fills = [];
  for (let i = 1; i <= missingTicks; i++) {
    const t = i / (missingTicks + 1); // evenly spaced across the gap
    const fill = {
      timestamp: new Date(lastMs + t * (newMs - lastMs)).toISOString(),
      status: lastSample.status, // categorical — carry forward, can't interpolate
      provenance: 'IMPUTED',
    };
    for (const metric of metrics) {
      fill[metric] = lastSample[metric] + t * (newSample[metric] - lastSample[metric]);
    }
    fills.push(fill);
  }
  return fills;
}

/**
 * Replace runs of physics-invalid samples inside a completed window with
 * linearly-interpolated values, the same way generateFillSamples reconstructs
 * a genuine gap — except both endpoints are already in `window` here, so no
 * streaming/lookahead is needed. The raw invalid values are never mutated
 * (they're already stored for audit before this runs); this only affects the
 * copy used for stats/forecast/trend.
 *
 * @param {object[]} window completed AUDIT window, in arrival order.
 * @param {string[]} metrics numeric metric names to interpolate.
 * @returns {object[]} same length as window; invalid runs replaced with
 *   samples flagged imputedForPhysics: true, everything else untouched.
 */
export function imputeInvalidRuns(window, metrics) {
  const result = window.slice();
  let i = 0;

  while (i < result.length) {
    if (result[i].physicsValid !== false) {
      i++;
      continue;
    }

    let j = i;
    while (j < result.length && result[j].physicsValid === false) j++;
    // Invalid run is [i, j).

    const before = i > 0 ? result[i - 1] : null;
    const after = j < result.length ? result[j] : null;
    const runLength = j - i;

    for (let k = 0; k < runLength; k++) {
      const sample = result[i + k];
      const filled = { ...sample, imputedForPhysics: true };

      if (before && after) {
        const t = (k + 1) / (runLength + 1);
        for (const metric of metrics) {
          filled[metric] = before[metric] + t * (after[metric] - before[metric]);
        }
      } else if (before) {
        for (const metric of metrics) filled[metric] = before[metric];
      } else if (after) {
        for (const metric of metrics) filled[metric] = after[metric];
      } else {
        // No valid neighbor on either side (whole window invalid) — nothing
        // to interpolate from; leave as-is, handled upstream by the
        // all-invalid-window skip in pipeline.js.
        i = j;
        continue;
      }

      result[i + k] = filled;
    }

    i = j;
  }

  return result;
}
