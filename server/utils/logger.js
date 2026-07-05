// ─────────────────────────────────────────────────────────────────────────
// logger.js — a tiny timestamped console logger.
//
// A real production app would use pino/winston, but for a teaching project a
// thin wrapper keeps the output readable and dependency-free while still
// demonstrating the idea of a single logging utility used everywhere.
// ─────────────────────────────────────────────────────────────────────────

const stamp = () => new Date().toISOString();

export const logger = {
  info: (msg) => console.log(`[${stamp()}] [INFO ] ${msg}`),
  warn: (msg) => console.warn(`[${stamp()}] [WARN ] ${msg}`),
  error: (msg) => console.error(`[${stamp()}] [ERROR] ${msg}`),
};
