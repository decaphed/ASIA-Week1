// ─────────────────────────────────────────────────────────────────────────
// buffer.js — persistent in-memory rolling buffer (Stage 2 of the pipeline).
//
// Ported from node-red/flow.json's preprocess_minute function node, which
// kept this same array in Node-RED's node-scoped `context`. Here it is a
// module-scoped singleton instead — same lifetime/reset behavior (an Express
// restart loses any partial window, exactly like a Node-RED redeploy did).
// ─────────────────────────────────────────────────────────────────────────

export const WINDOW_SIZE = 60;

let buffer = [];

// The most recently pushed sample, kept across resetBuffer() calls — the
// anchor gap-fill interpolation needs to bridge a missing stretch even when
// it happens to straddle a window boundary (see pipeline.js/missing.js).
let lastSample = null;

/** Append one annotated sample to the rolling buffer. */
export function pushSample(sample) {
  buffer.push(sample);
  lastSample = sample;
}

/** @returns the most recently pushed sample, or null before the first one. */
export function getLastSample() {
  return lastSample;
}

/** @returns {number} current buffer length. */
export function bufferSize() {
  return buffer.length;
}

/** @returns {boolean} true once WINDOW_SIZE samples have accumulated. */
export function isWindowComplete() {
  return buffer.length >= WINDOW_SIZE;
}

/** @returns a copy of the current window (does not clear the buffer). */
export function getWindow() {
  return buffer.slice();
}

/** Clear the buffer so the next window starts empty. */
export function resetBuffer() {
  buffer = [];
}
