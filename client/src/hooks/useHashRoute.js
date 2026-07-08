// ─────────────────────────────────────────────────────────────────────────
// useHashRoute.js — tiny hash router (no react-router dependency).
// Routes are "#/overview", "#/telemetry", … — unknown hashes fall back
// to the overview page.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';

export const ROUTES = ['overview', 'analytics', 'predict', 'reports'];

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '').split(/[?#]/)[0];
  return ROUTES.includes(raw) ? raw : 'overview';
}

export function useHashRoute() {
  const [route, setRoute] = useState(parseHash);

  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}
