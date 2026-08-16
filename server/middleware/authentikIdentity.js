// ─────────────────────────────────────────────────────────────────────────
// authentikIdentity.js — reads the identity Traefik's forward-auth
// middleware already attaches to every request that passed the
// authentik-auth gate (see authResponseHeaders in
// authentik/traefik/dynamic/dynamic.yml) and exposes it as req.identity.
//
// backend publishes no port (docker-compose.yml), but it's NOT network-
// isolated from other containers — everything shares the `edge` Compose
// network, and node-red (which runs arbitrary flow JS by design) already
// talks to backend:3000 directly for ingestion. That means the raw
// X-authentik-* headers alone are NOT trustworthy: any container reachable
// on `edge` could set them itself and impersonate an authenticated user/
// group, bypassing Traefik and Authentik entirely. So identity headers are
// only honored when paired with INTERNAL_PROXY_SECRET, a value only
// client's nginx (client/nginx.conf.template) and backend know — nginx is
// the one hop that both terminates real browser traffic (which already went
// through Traefik's forwardAuth) and re-stamps the identity headers itself,
// so a client-forged header can't ride along with the correct secret.
// Requests without a matching secret (e.g. node-red's direct POSTs, or any
// other container on `edge`) are treated as fully anonymous — same as the
// old "headers absent" case, so requireGroup() below still fails closed.
//
// authentik-server joins multi-value response headers with "|" by default
// — reverify against a real outpost response if group-gating stops working
// after an authentik upgrade.
// ─────────────────────────────────────────────────────────────────────────

export function authentikIdentity(req, res, next) {
  const proxySecret = process.env.INTERNAL_PROXY_SECRET;
  const trusted = Boolean(proxySecret) && req.get('X-Internal-Proxy-Secret') === proxySecret;

  req.trustedProxy = trusted;
  req.identity = trusted
    ? {
        username: req.get('X-authentik-username') || null,
        email: req.get('X-authentik-email') || null,
        groups: (req.get('X-authentik-groups') || '').split('|').filter(Boolean),
      }
    : { username: null, email: null, groups: [] };
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

// Applied to every read route that isn't ingestion (/data, /processed) or a
// container-internal healthcheck (/health — Docker's own HEALTHCHECK curls
// this from inside the backend container itself, never through nginx, so it
// can never carry the proxy secret). Without this, a request that skipped
// Traefik/Authentik entirely (e.g. node-red, or any other container later
// added to the `edge` network) could still read every route that doesn't
// separately call requireGroup() — which, before this, was all of them
// except the PATCH review endpoint.
export function requireTrustedProxy(req, res, next) {
  if (req.trustedProxy || DEV_ENVS.includes(process.env.NODE_ENV)) return next();
  return res.status(403).json({ success: false, error: 'forbidden' });
}
