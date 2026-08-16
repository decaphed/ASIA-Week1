// ─────────────────────────────────────────────────────────────────────────
// rateLimit.js — minimal fixed-window rate limiter, in-memory, no external
// dependency (same "not worth a library for this" reasoning as utils/csv.js).
//
// Only applied to /api/data and /api/processed: those are the two routes
// node-red (and any other container on the `edge` network) can reach
// directly, bypassing Traefik's rl-app/rl-auth rate limits entirely — see
// docker-compose.yml's backend service comment and
// middleware/authentikIdentity.js. Every other route is only reachable
// through Traefik, which already rate-limits it.
// ─────────────────────────────────────────────────────────────────────────

const WINDOW_MS = 10_000;
// node-red posts one reading/sec plus up to 3 retries; generous headroom
// above that for legitimate bursts (e.g. several sensors on one host).
const MAX_PER_WINDOW = 30;

const hits = new Map();

export function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    hits.set(key, { windowStart: now, count: 1 });
    return next();
  }

  entry.count += 1;
  if (entry.count > MAX_PER_WINDOW) {
    return res.status(429).json({ success: false, error: 'too many requests' });
  }
  next();
}
