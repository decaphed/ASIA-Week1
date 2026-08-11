// ─────────────────────────────────────────────────────────────────────────
// authentikIdentity.js — reads the identity Traefik's forward-auth
// middleware already attaches to every request that passed the
// authentik-auth gate (see authResponseHeaders in
// authentik/traefik/dynamic/dynamic.yml) and exposes it as req.identity.
//
// backend publishes no port (docker-compose.yml), but it's NOT network-
// isolated from other containers — everything shares the default Compose
// network, and node-red (which runs arbitrary flow JS by design) already
// talks to backend:3000 directly for ingestion. So "no identity headers"
// doesn't just mean "a trusted local dev/test run" — it can also mean "a
// request from another container on the network, bypassing Traefik and
// Authentik entirely." requireGroup() below fails closed on that case.
//
// authentik-server joins multi-value response headers with "|" by default
// — reverify against a real outpost response if group-gating stops working
// after an authentik upgrade.
// ─────────────────────────────────────────────────────────────────────────

export function authentikIdentity(req, res, next) {
  req.identity = {
    username: req.get('X-authentik-username') || null,
    email: req.get('X-authentik-email') || null,
    groups: (req.get('X-authentik-groups') || '').split('|').filter(Boolean),
  };
  next();
}

// Requests with no identity are treated as untrusted by default — the only
// requests that should ever lack these headers are ones that never passed
// through the authentik-auth gate at all (see module comment). The single
// exception is an explicit, allowlisted dev/test environment, so local
// `npm run dev`/`npm test` runs (which never go through Traefik) don't need
// to fake Authentik headers just to exercise a gated route.
const DEV_ENVS = ['development', 'test'];

export function requireGroup(group) {
  return (req, res, next) => {
    if (!req.identity?.username) {
      if (DEV_ENVS.includes(process.env.NODE_ENV)) return next();
      return res.status(403).json({ success: false, error: 'forbidden' });
    }
    if (!req.identity.groups.includes(group)) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }
    next();
  };
}
