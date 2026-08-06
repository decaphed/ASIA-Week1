// ─────────────────────────────────────────────────────────────────────────
// useHashRoute.js — tiny hash router (no react-router dependency).
// Routes are "#/overview", "#/telemetry", … — unknown hashes fall back
// to the overview page. A route may carry an optional second segment as
// `param` (e.g. "#/review/12" → { route: 'review', param: '12' }) — pages
// that don't need it simply ignore the prop.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';

export const ROUTES = ['overview', 'analytics', 'predict', 'review', 'reports'];

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '').split(/[?#]/)[0];
  const [route, param] = raw.split('/');
  return ROUTES.includes(route) ? { route, param: param || null } : { route: 'overview', param: null };
}

export function useHashRoute() {
  const [state, setState] = useState(parseHash);

  useEffect(() => {
    const onChange = () => setState(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return state;
}
