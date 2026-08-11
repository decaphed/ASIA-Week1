// ─────────────────────────────────────────────────────────────────────────
// authentikIdentity.js — reads the identity Traefik's forward-auth
// middleware already attaches to every request that passed the
// authentik-auth gate (see authResponseHeaders in
// authentik/traefik/dynamic/dynamic.yml) and exposes it as req.identity.
//
// backend publishes no port (docker-compose.yml) — the only route in is
// client's nginx, which is only reachable via the Traefik router gated by
// authentik-auth, so these headers are always present for real traffic.
// They're simply absent when something calls Express directly (tests,
// local dev without the full stack); in that case req.identity.username
// is null and callers fall back to their pre-RBAC behavior rather than
// failing closed, matching this repo's existing trust boundary at the
// Docker network edge.
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

// Only enforces when a request actually carries an Authentik identity (i.e.
// it came through the forward-auth gate). Requests without one fall through
// unchanged — see the module comment above for why that's the right default
// here rather than failing closed.
export function requireGroup(group) {
  return (req, res, next) => {
    if (req.identity?.username && !req.identity.groups.includes(group)) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }
    next();
  };
}
