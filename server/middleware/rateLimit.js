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
//
// app.js sets `trust proxy` so req.ip honors X-Forwarded-For — necessary so
// browser submissions (client/src/api/client.js's postReading, proxied
// through nginx) aren't all collapsed onto nginx's container IP. But that
// same trust-proxy setting means a caller hitting backend:3000 directly
// (node-red, or anything else on `edge`) can forge X-Forwarded-For to get a
// fresh req.ip every request and dodge the window entirely. req.trustedProxy
// (middleware/authentikIdentity.js) tells us whether the request actually
// came through nginx with the internal secret — only trust the
// X-Forwarded-For-derived req.ip then. Otherwise key on the raw socket
// address, which nothing running on `edge` can spoof.
// ─────────────────────────────────────────────────────────────────────────

const WINDOW_MS = 10_000;
// node-red posts one reading/sec plus up to 3 retries; generous headroom
// above that for legitimate bursts (e.g. several sensors on one host).
const MAX_PER_WINDOW = 30;

const hits = new Map();

export function rateLimit(req, res, next) {
  const key = req.trustedProxy ? req.ip : req.socket.remoteAddress;
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
