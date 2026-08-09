// ─────────────────────────────────────────────────────────────────────────
// index.js — barrel export. dataController.js imports processSample from
// here rather than reaching into pipeline.js directly, so this directory has
// exactly one public entry point.
// ─────────────────────────────────────────────────────────────────────────

export { processSample, runBackgroundSweep } from './pipeline.js';
