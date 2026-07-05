// ─────────────────────────────────────────────────────────────────────────
// requestTimer.js — measures how long each request takes.
//
// This powers the "API latency" figure on the dashboard's stats panel (a
// bonus requirement). We record a high-resolution start time, and when the
// response finishes we compute the elapsed milliseconds and remember the most
// recent value so GET /api/stats can report it.
// ─────────────────────────────────────────────────────────────────────────

let lastLatencyMs = 0;

export function requestTimer(req, res, next) {
  const start = process.hrtime.bigint(); // nanosecond-precision clock

  // 'finish' fires once the response has been fully sent.
  res.on('finish', () => {
    const elapsedNs = process.hrtime.bigint() - start;
    lastLatencyMs = Math.round((Number(elapsedNs) / 1e6) * 100) / 100;
  });

  next();
}

/** Latency (ms) of the most recently completed request. */
export function getLastLatencyMs() {
  return lastLatencyMs;
}
