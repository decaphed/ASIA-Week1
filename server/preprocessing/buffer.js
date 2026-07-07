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

/** Append one annotated sample to the rolling buffer. */
export function pushSample(sample) {
  buffer.push(sample);
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
