// ─────────────────────────────────────────────────────────────────────────
// buffer.js — event-time windowed buffer (Stage 2 of the pipeline).
//
// Replaces the prior count-based rolling array (60th push closes a window)
// with fixed, epoch-aligned event-time boundaries: a window is
// [windowStartMs, windowEndMs) computed from each sample's own timestamp, not
// from arrival count. This guarantees a window actually represents its
// intended real-world duration regardless of missing, delayed, duplicated,
// or out-of-order samples — see the design doc's response to the reviewer's
// windowing comments.
//
// classify()/commit() split: classify(tsMs) is pure (no mutation) and
// answers "what kind of sample is this, relative to buffer state." commit()
// mutates state accordingly and returns any windows that just closed.
// ─────────────────────────────────────────────────────────────────────────

import { WINDOW_DURATION_SECONDS, LATE_GRACE_SECONDS, RECENT_TAIL_SIZE } from './config.js';

const WINDOW_DURATION_MS = WINDOW_DURATION_SECONDS * 1000;
const LATE_GRACE_MS = LATE_GRACE_SECONDS * 1000;

/** windowStartMs -> WindowState */
let windows = new Map();

// Timestamp-sorted (not arrival-order) fixed-length tail, independent of
// window boundaries, so faultClassifier can find a chronological "before"
// neighbor for a run that starts at the very beginning of a window whose
// true predecessor already got evicted with a previous window.
let recentTail = [];

// The most recently accepted-or-merged sample — the gap-fill anchor.
let lastSample = null;

// The most recent ACCEPTED (true forward-progress) timestamp, used to decide
// whether a new arrival is in-order (ACCEPTED) or reordered (MERGED).
let lastAcceptedTimestampMs = null;

function windowStartMsFor(tsMs) {
  return Math.floor(tsMs / WINDOW_DURATION_MS) * WINDOW_DURATION_MS;
}

function makeWindowState(windowStartMs) {
  return {
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowStartMs + WINDOW_DURATION_MS).toISOString(),
    windowStartMs,
    windowEndMs: windowStartMs + WINDOW_DURATION_MS,
    samples: [],
    samplesByMs: new Map(),
    mergedSampleCount: 0,
    closed: false,
    closedAtMs: null,
  };
}

function getOrCreateWindow(windowStartMs) {
  let w = windows.get(windowStartMs);
  if (!w) {
    w = makeWindowState(windowStartMs);
    windows.set(windowStartMs, w);
  }
  return w;
}

/** @returns the windowStartMs of the newest still-open window, or null if none. */
function getOpenWindowStartMs() {
  let maxStart = null;
  for (const w of windows.values()) {
    if (!w.closed && (maxStart === null || w.windowStartMs > maxStart)) maxStart = w.windowStartMs;
  }
  return maxStart;
}

/** Insert `sample` into `arr` at the position that keeps it sorted by timestamp. */
function sortedInsert(arr, sample) {
  const ms = Date.parse(sample.timestamp);
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Date.parse(arr[mid].timestamp) <= ms) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, sample);
}

function updateRecentTail(sample) {
  sortedInsert(recentTail, sample);
  while (recentTail.length > RECENT_TAIL_SIZE) recentTail.shift(); // evict oldest (lowest timestamp)
}

/**
 * Pure classification — does not mutate any buffer state.
 * @param {number} tsMs incoming sample's timestamp, as epoch ms.
 * @returns {'ACCEPTED'|'DUPLICATE'|'MERGED'|'REJECTED_STALE'}
 */
export function classify(tsMs) {
  for (const w of windows.values()) {
    if (w.samplesByMs.has(tsMs)) return 'DUPLICATE';
  }

  const windowStartMs = windowStartMsFor(tsMs);
  const w = windows.get(windowStartMs);

  if (!w) {
    const openStart = getOpenWindowStartMs();
    // A slot older than the currently open window's slot, with no window
    // object left for it, means that window already closed and was evicted
    // past its late-grace period — too stale to recover.
    if (openStart !== null && windowStartMs < openStart) return 'REJECTED_STALE';
    return 'ACCEPTED';
  }

  if (w.closed) return 'MERGED'; // late, but still within its grace-retention period
  if (lastAcceptedTimestampMs !== null && tsMs <= lastAcceptedTimestampMs) return 'MERGED'; // out-of-order within the still-open window
  return 'ACCEPTED';
}

/**
 * Mutates buffer state for a sample already classified by classify().
 * DUPLICATE/REJECTED_STALE never enter a window — the caller stores them
 * for audit only.
 * @param {object} sample the annotated sample (already validated/stored).
 * @param {'ACCEPTED'|'DUPLICATE'|'MERGED'|'REJECTED_STALE'} classification
 * @returns {object[]} zero or more WindowState objects that just closed, oldest first.
 */
export function commit(sample, classification) {
  const closedWindows = [];
  if (classification === 'DUPLICATE' || classification === 'REJECTED_STALE') {
    return closedWindows;
  }

  const tsMs = Date.parse(sample.timestamp);
  const windowStartMs = windowStartMsFor(tsMs);
  const w = getOrCreateWindow(windowStartMs);

  sortedInsert(w.samples, sample);
  w.samplesByMs.set(tsMs, sample);
  if (classification === 'MERGED') w.mergedSampleCount++;

  updateRecentTail(sample);
  lastSample = sample;
  if (classification === 'ACCEPTED') {
    lastAcceptedTimestampMs = tsMs;

    // Moving forward into a new/later window slot closes every still-open
    // window strictly before it — handles a multi-boundary jump (a long
    // silence or burst) by closing them all, in order.
    const sortedEntries = [...windows.entries()].sort((a, b) => a[0] - b[0]);
    for (const [ws, win] of sortedEntries) {
      if (!win.closed && ws < windowStartMs) {
        win.closed = true;
        win.closedAtMs = Date.now();
        closedWindows.push(win);
      }
    }
  }

  evictExpiredClosedWindows();
  return closedWindows;
}

function evictExpiredClosedWindows() {
  const now = Date.now();
  for (const [ws, win] of windows) {
    if (win.closed && now - win.closedAtMs > LATE_GRACE_MS) {
      windows.delete(ws);
    }
  }
}

/**
 * Force-close any open window whose event-time boundary has already passed,
 * even with no new sample to trigger it — guarantees a window closes during
 * total stream silence, since ingestion is otherwise entirely push-driven.
 * @param {number} nowMs wall-clock time to compare window boundaries against.
 * @returns {object[]} WindowState objects that were force-closed, oldest first.
 */
export function closeExpiredWindows(nowMs = Date.now()) {
  const closedWindows = [];
  const sortedEntries = [...windows.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, win] of sortedEntries) {
    if (!win.closed && win.windowEndMs <= nowMs) {
      win.closed = true;
      win.closedAtMs = nowMs;
      closedWindows.push(win);
    }
  }
  evictExpiredClosedWindows();
  return closedWindows;
}

/** @returns the most recently pushed (ACCEPTED or MERGED) sample, or null before the first one. */
export function getLastSample() {
  return lastSample;
}

/** @returns a copy of the timestamp-sorted recent-tail, for faultClassifier's cross-window neighbor lookups. */
export function getRecentTail() {
  return recentTail.slice();
}

/** Test/dev-only: reset all buffer state. */
export function resetAll() {
  windows = new Map();
  recentTail = [];
  lastSample = null;
  lastAcceptedTimestampMs = null;
}
